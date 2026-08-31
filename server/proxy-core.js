import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
export const REQUEST_TIMEOUT_MS = 10_000
export const MAX_REDIRECTS = 5
export const ALLOW_PRIVATE_NETWORK =
  (process.env.ALLOW_PRIVATE_NETWORK ?? 'true').toLowerCase() !== 'false'
export const ALLOW_INSECURE_TLS =
  (process.env.ALLOW_INSECURE_TLS ?? 'true').toLowerCase() !== 'false'
export const PROXY_TOKEN = process.env.PROXY_TOKEN || ''
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export function isPrivateIp(ip) {
  if (ip === '::1' || ip === '::') return true
  const lower = ip.toLowerCase()
  if (lower === 'unknown' || lower === '' || lower === '0.0.0.0') return true
  if (
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  ) {
    return true
  }
  if (lower.startsWith('::ffff:')) {
    return isPrivateIp(ip.slice(7))
  }
  if (net.isIP(lower) !== 4) return false
  const [a, b] = lower.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
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
      throw httpError(403, '该地址指向内网资源，已被拒绝')
    }
    if (net.isIP(hostname)) {
      if (isPrivateIp(hostname)) throw httpError(403, '该地址指向内网资源，已被拒绝')
      return url
    }

    let records
    try {
      records = await dns.lookup(hostname, { all: true, verbatim: true })
    } catch {
      throw httpError(502, '目标域名解析失败')
    }
    if (!records.length || records.some((record) => isPrivateIp(record.address))) {
      throw httpError(403, '该地址指向内网资源，已被拒绝')
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

function rawRequest(url, signal, validateSocket = null) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const request = lib.request(
      url,
      {
        method: 'GET',
        signal,
        rejectUnauthorized: !ALLOW_INSECURE_TLS,
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

export function tokenAllowed(queryToken, authHeader) {
  if (!PROXY_TOKEN) return true
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  return queryToken === PROXY_TOKEN || bearer === PROXY_TOKEN
}
