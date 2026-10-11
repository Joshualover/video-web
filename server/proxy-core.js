import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { agentFor } from './net.js'

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
export const REQUEST_TIMEOUT_MS = 10_000
export const MAX_REDIRECTS = 5
// 默认关闭「内网上游直连」（即默认开启 SSRF 防护）。
// 局域网/IPTV 等确实需要服务端直连内网的场景，显式设 ALLOW_PRIVATE_NETWORK=true 打开。
export const ALLOW_PRIVATE_NETWORK =
  (process.env.ALLOW_PRIVATE_NETWORK ?? 'false').toLowerCase() === 'true'
// 默认校验上游证书；只有自签名源站确实需要时才设 ALLOW_INSECURE_TLS=true。
export const ALLOW_INSECURE_TLS =
  (process.env.ALLOW_INSECURE_TLS ?? 'false').toLowerCase() === 'true'
export const PROXY_TOKEN = process.env.PROXY_TOKEN || ''
// 内网被拒绝时的统一提示：带上自助开关，避免用户不明所以
const PRIVATE_REJECT_HINT =
  '该地址指向内网资源，已被拒绝（如需服务端直连局域网/IPTV，请设置 ALLOW_PRIVATE_NETWORK=true）'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// 把 IPv4-mapped IPv6 的两种写法都还原成点分 IPv4：
//   ::ffff:127.0.0.1  点分（Node socket 里常见）
//   ::ffff:7f00:1     十六进制（WHATWG URL 会把 [::ffff:127.0.0.1] 归一化成这个形式）
// 只认点分写法会让 [::ffff:127.0.0.1] 这类地址绕过内网判断。
function mappedIpv4(lower) {
  const dotted = lower.match(/(?:^|:)ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (dotted) return dotted[1]
  const hex = lower.match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = Number.parseInt(hex[1], 16)
    const lo = Number.parseInt(hex[2], 16)
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.')
  }
  return ''
}

export function isPrivateIp(ip) {
  const raw = String(ip ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!raw || raw === 'unknown' || raw === '0.0.0.0' || raw === '::' || raw === '::1') return true
  // 唯一本地 fc00::/7 与链路本地 fe80::/10
  if (raw.startsWith('fc') || raw.startsWith('fd') || /^fe[89ab]/.test(raw)) return true
  const lower = mappedIpv4(raw) || raw
  if (net.isIP(lower) !== 4) return false
  const [a, b, c] = lower.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true // 链路本地 / 云元数据
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // 192.0.0.0/24、192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true // 203.0.113.0/24
  return false
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase()
  if (host === 'localhost') return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  return false
}

export async function assertPublicTarget(rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw httpError(400, '参数非法：无法解析的 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw httpError(400, '仅允许 http/https 链接')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (!ALLOW_PRIVATE_NETWORK) {
    if (isPrivateHostname(hostname)) {
      throw httpError(403, PRIVATE_REJECT_HINT)
    }
    if (net.isIP(hostname)) {
      if (isPrivateIp(hostname)) throw httpError(403, PRIVATE_REJECT_HINT)
      return url
    }

    let records
    try {
      records = await dns.lookup(hostname, { all: true, verbatim: true })
    } catch {
      // 本地解析不了不等于攻击：被墙/被污染的域名往往只能靠远端代理解析（README 里的 VOD_HTTP_PROXY 场景）。
      // 配了代理就交给代理去解析，否则该请求本来也连不上，直接给出明确错误即可。
      if (agentFor(url)) return url
      throw httpError(502, '目标域名解析失败')
    }
    if (!records.length || records.some((record) => isPrivateIp(record.address))) {
      throw httpError(403, PRIVATE_REJECT_HINT)
    }
  }
  return url
}

export function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function readNodeBody(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      stream.destroy?.()
      reject(err)
    }
    stream.on('data', (chunk) => {
      if (settled) return
      total += chunk.length
      if (total > maxBytes) {
        fail(httpError(413, '响应体超过 10MB 限制'))
        return
      }
      chunks.push(chunk)
    })
    stream.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    stream.on('error', (err) => fail(err))
  })
}

// DNS 解析完、真正建立连接之前先校验一遍（配合响应期的 socket 校验，双保险）。
// 放在 lookup 里意味着私网地址根本不会被连上，而不是「已发出请求再丢弃响应」。
function guardedLookup(validate) {
  return (hostname, _options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true }).then(
      (records) => {
        if (!records.length) {
          callback(httpError(403, PRIVATE_REJECT_HINT))
          return
        }
        if (records.some((record) => !validate(record.address))) {
          callback(httpError(403, PRIVATE_REJECT_HINT))
          return
        }
        callback(null, records[0].address, records[0].family)
      },
      (err) => callback(err)
    )
  }
}

function rawRequest(url, signal, validateSocket = null) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const request = lib.request(
      url,
      {
        method: 'GET',
        signal,
        rejectUnauthorized: !ALLOW_INSECURE_TLS,
        lookup: validateSocket ? guardedLookup(validateSocket) : undefined,
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
          Connection: 'close'
        }
      },
      (response) => {
        // DNS rebinding 二次防线：域名解析校验之后，连接实际建立时
        // 再用 socket 的真实远端地址校验一次，防止解析结果被替换。
        if (validateSocket) {
          const remote = response.socket?.remoteAddress
          if (!validateSocket(remote)) {
            response.on('error', () => {})
            response.destroy()
            reject(httpError(403, '该地址指向内网资源，已被拒绝'))
            return
          }
        }
        resolve({ status: response.statusCode, headers: response.headers, stream: response })
      }
    )
    request.on('error', (err) => {
      if (signal?.aborted) {
        const abortError = new Error('请求超时')
        abortError.name = 'AbortError'
        reject(abortError)
        return
      }
      reject(err)
    })
    request.end()
  })
}

export function friendlyProxyError(err) {
  const code = err?.code || err?.cause?.code
  switch (code) {
    case 'ECONNREFUSED':
      return '目标站点不可达：连接被拒绝（端口未开放或被防火墙拦截）'
    case 'ECONNRESET':
      return '目标站点不可达：连接被重置'
    case 'ENOTFOUND':
      return '目标站点不可达：域名无法解析'
    case 'ETIMEDOUT':
      return '目标站点不可达：连接超时'
    case 'EHOSTUNREACH':
      return '目标站点不可达：主机不可达'
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'CERT_HAS_EXPIRED':
      return '目标站点证书校验失败（自签名或过期证书），可设置 ALLOW_INSECURE_TLS=true'
    default:
      return `目标站点不可达（${code || err?.message || '未知错误'}）`
  }
}

export async function proxyFetch(rawUrl) {
  let current = await assertPublicTarget(rawUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  // 开启 SSRF 防护时，对每次实际连接做 socket 地址二次校验（防 DNS rebinding）
  const socketGuard = ALLOW_PRIVATE_NETWORK
    ? null
    : (remote) => Boolean(remote) && !isPrivateIp(remote)

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let response
      try {
        response = await rawRequest(current, controller.signal, socketGuard)
      } catch (err) {
        if (err.name === 'AbortError') throw httpError(504, '请求超时')
        // 已带明确状态码的错误（含 SSRF 拦截的 403）原样透出，不要包装成「目标站点不可达」
        if (err.status) throw err
        throw httpError(502, friendlyProxyError(err))
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location
        response.stream.resume()
        if (!location) throw httpError(502, '目标站点返回无效跳转')
        current = await assertPublicTarget(new URL(location, current).toString())
        continue
      }

      if (response.status < 200 || response.status >= 300) {
        response.stream.resume()
        throw httpError(502, `目标站点返回 ${response.status} 状态`)
      }

      const text = await readNodeBody(response.stream, MAX_RESPONSE_BYTES)
      return {
        text,
        contentType: response.headers['content-type'] || 'text/plain'
      }
    }
    throw httpError(504, '重定向次数过多')
  } finally {
    clearTimeout(timer)
  }
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''))
  const bufB = Buffer.from(String(b ?? ''))
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

// 取调用方令牌：query（<img>/<video> 这类发不出自定义头的请求）或 Authorization 头都认。
// 生成播放地址时必须用它，否则前端用 Authorization 调用 /api/vod/play 时，
// 返回的 <video src> 里不会带令牌，配了 PROXY_TOKEN 就会 401 播放失败。
export function tokenFromRequest(req) {
  const queryToken = req?.query?.token
  if (typeof queryToken === 'string' && queryToken) return queryToken
  const auth = String(req?.headers?.authorization || '')
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

export function tokenAllowed(queryToken, authHeader) {
  if (!PROXY_TOKEN) return true
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  return safeEqual(queryToken, PROXY_TOKEN) || safeEqual(bearer, PROXY_TOKEN)
}

// 上游 Content-Type 白名单：代理把上游响应原样回吐时，绝不能让 text/html 这类可执行类型
// 落到本站 origin（否则 /api/proxy、/api/vod/hls、/api/vod/image 都是同源 XSS 端点）。
const SAFE_TEXT_TYPES = new Set([
  'text/plain',
  'text/xml',
  'text/x-mpegurl',
  'text/vnd.apple.mpegurl',
  'application/json',
  'application/xml',
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
  'application/octet-stream'
])

// 文本类响应（m3u 播放列表、配置 JSON）：非白名单类型一律降级为 text/plain
export function sanitizeProxyContentType(contentType) {
  const value = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (SAFE_TEXT_TYPES.has(value)) return contentType
  if (value.startsWith('text/') && value !== 'text/html') return contentType
  return 'text/plain; charset=utf-8'
}

// 媒体类响应（分片、密钥、图片、mp4）：只放行音视频/图片与常见容器类型
export function sanitizeMediaContentType(contentType, fallback = 'application/octet-stream') {
  const value = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (/^(video|audio|image)\//.test(value)) return contentType
  if (/^application\/(vnd\.apple\.mpegurl|x-mpegurl|octet-stream|mp2t|dash\+xml)$/.test(value)) {
    return contentType
  }
  return fallback
}
