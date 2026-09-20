// 服务端出网代理：Node 的 http/https 模块既不认系统代理也不认 *_PROXY 环境变量，
// 所以这里自己实现一个 CONNECT 隧道 Agent，供影视源抓取/播放代理使用。
//
// 配置方式（进程级，启动时读取）：
//   VOD_HTTP_PROXY=http://127.0.0.1:7890        代理地址，支持 http:// 与 https:// 代理
//   VOD_HTTP_PROXY=http://user:pass@host:port   带认证
//   VOD_NO_PROXY=.example.com,10.0.0.5          额外直连的域名/IP（逗号分隔）
// 不设置则全部直连（保持原行为）。
//
// 用法：lib.get(url, { ...原有参数, agent: agentFor(url) })
// 未启用代理、或目标命中直连规则时返回 undefined（= 走默认直连）。
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

const PROXY_KEYS = [
  'VOD_HTTP_PROXY',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy'
]
const NO_PROXY_KEYS = ['VOD_NO_PROXY', 'NO_PROXY', 'no_proxy']
const CONNECT_TIMEOUT = 15000

function firstEnv(keys) {
  for (const key of keys) {
    const value = process.env[key]
    if (value && value.trim()) return value.trim()
  }
  return ''
}

export function isPrivateIp(ip) {
  const value = String(ip || '').toLowerCase()
  if (value.includes(':')) {
    return (
      value === '::1' ||
      value.startsWith('fc') ||
      value.startsWith('fd') ||
      value.startsWith('fe80')
    )
  }
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 169 && parts[1] === 254)
  )
}

let parsed = false
let proxy = null
let bypass = []

function parseConfig() {
  if (parsed) return proxy
  parsed = true
  const raw = firstEnv(PROXY_KEYS)
  if (raw) {
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`仅支持 http/https 代理，收到 ${url.protocol}`)
      }
      proxy = url
      console.log(`[net] 出网代理已启用：${url.protocol}//${url.host}`)
    } catch (err) {
      proxy = null
      console.warn(`[net] 代理地址无效，已忽略：${raw}（${err.message}）`)
    }
  }
  bypass = firstEnv(NO_PROXY_KEYS)
    .split(',')
    .map((item) => item.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean)
  return proxy
}

// 是否直连：回环、内网地址、以及 VOD_NO_PROXY 里列出的域名
export function isBypassed(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (net.isIP(host)) return isPrivateIp(host)
  for (const rule of bypass) {
    if (host === rule || host.endsWith(`.${rule}`)) return true
  }
  return false
}

// 通过代理建立到目标的 CONNECT 隧道，回调里拿到原始 socket
function connectViaProxy(target, options, callback) {
  const targetHost = options.host
  const targetPort = Number(options.port) || 80
  const proxyLib = proxy.protocol === 'https:' ? https : http
  const headers = { Host: `${targetHost}:${targetPort}`, 'Proxy-Connection': 'keep-alive' }
  if (proxy.username || proxy.password) {
    const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
    headers['Proxy-Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`
  }

  const req = proxyLib.request({
    host: proxy.hostname,
    port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
    method: 'CONNECT',
    path: `${targetHost}:${targetPort}`,
    headers,
    rejectUnauthorized: false,
    agent: false,
    timeout: CONNECT_TIMEOUT
  })

  let settled = false
  req.once('connect', (res, socket) => {
    if (settled) return
    settled = true
    if (res.statusCode !== 200) {
      socket.destroy()
      callback(new Error(`代理 CONNECT 失败（HTTP ${res.statusCode}）`))
      return
    }
    callback(null, socket)
  })
  req.once('timeout', () => req.destroy(new Error('代理连接超时')))
  req.once('error', (err) => {
    if (settled) return
    settled = true
    callback(err)
  })
  req.end()
}

class TunnelHttpAgent extends http.Agent {
  constructor() {
    super({ keepAlive: true, maxSockets: 16 })
  }
  createConnection(options, callback) {
    connectViaProxy(null, options, callback)
  }
}

class TunnelHttpsAgent extends https.Agent {
  constructor() {
    super({ keepAlive: true, maxSockets: 16 })
  }
  createConnection(options, callback) {
    connectViaProxy(null, options, (err, socket) => {
      if (err) {
        callback(err)
        return
      }
      // 隧道打通后，再和真正的目标做 TLS 握手
      const tlsSocket = tls.connect({
        socket,
        servername: options.servername || options.host,
        rejectUnauthorized: options.rejectUnauthorized,
        ALPNProtocols: options.ALPNProtocols || ['http/1.1']
      })
      const onError = (tlsErr) => {
        tlsSocket.destroy()
        callback(tlsErr)
      }
      tlsSocket.once('error', onError)
      tlsSocket.once('secureConnect', () => {
        tlsSocket.removeListener('error', onError)
        callback(null, tlsSocket)
      })
    })
  }
}

const agents = { http: null, https: null }

// 部分站点（或其 CDN）反而不能走代理（代理 IP 会被 Cloudflare challenge / 取不到资源），
// 由适配器在运行期登记这些域名，命中后强制直连；也可用 VOD_DIRECT_HOSTS 手动补充。
const directHosts = new Set(
  firstEnv(['VOD_DIRECT_HOSTS'])
    .split(',')
    .map((item) => item.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean)
)

// 运行期学到的「域名 → 该走直连还是代理」：同一个域名不要每次都试错
const routeHints = new Map()

function normalizeHost(hostname) {
  // 去掉端口（agentFor 一律用 hostname 查，避免 g.x.com:9999 这种对不上）
  return String(hostname || '').trim().toLowerCase().replace(/:[0-9]+$/, '')
}

export function setRouteHint(hostname, route) {
  const host = normalizeHost(hostname)
  if (!host || (route !== 'direct' && route !== 'proxy')) return
  if (routeHints.get(host) === route) return
  routeHints.set(host, route)
  console.log(`[net] ${host} 以后走${route === 'direct' ? '直连' : '代理'}`)
}

export function getRouteHint(hostname) {
  return routeHints.get(normalizeHost(hostname)) || null
}

export function addDirectHosts(hosts = []) {
  let added = false
  for (const host of hosts) {
    const value = String(host || '').trim().toLowerCase().replace(/^\./, '')
    if (value && !directHosts.has(value)) {
      directHosts.add(value)
      added = true
    }
  }
  if (added) console.log(`[net] 直连域名（不走代理）：${[...directHosts].join(', ')}`)
  return [...directHosts]
}

function isDirectHost(hostname) {
  for (const suffix of directHosts) {
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) return true
  }
  return false
}

// 给某个目标 URL 挑一个 agent；无需代理时返回 undefined
//   force: 'direct' 强制直连 | 'proxy' 强制走代理（失败重试 / 路由学习时用）
export function agentFor(rawUrl, { force } = {}) {
  if (force === 'direct') return undefined
  const configured = parseConfig()
  if (!configured) return undefined
  let url
  try {
    url = new URL(String(rawUrl))
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (force !== 'proxy') {
    if (isBypassed(url.hostname) || isDirectHost(url.hostname)) return undefined
    // 之前学过这个域名该直连
    if (getRouteHint(url.hostname) === 'direct') return undefined
  }
  const key = url.protocol === 'https:' ? 'https' : 'http'
  if (!agents[key]) {
    agents[key] = key === 'https' ? new TunnelHttpsAgent() : new TunnelHttpAgent()
  }
  return agents[key]
}

// 供接口/界面展示当前代理状态
export function proxyStatus() {
  const configured = parseConfig()
  const direct = [...directHosts]
  const hints = [...routeHints.entries()].map(([host, route]) => `${host}:${route}`)
  if (!configured) return { enabled: false, url: '', noProxy: bypass, directHosts: direct, routeHints: hints }
  return {
    enabled: true,
    url: `${configured.protocol}//${configured.host}`,
    noProxy: bypass,
    directHosts: direct,
    routeHints: hints
  }
}
