// 播放地址解析 + HLS 代理
//  - 部分源 vod_play_url 给的是「网页播放页」（如 /share/xxx、/play/xxx），需要从 HTML 中解析真实 m3u8
//  - 部分 CDN 会校验 Referer / 不允许跨域，统一走服务端代理（含 m3u8 内片段地址重写）
import http from 'node:http'
import https from 'node:https'
import { httpGetText } from './maccms.js'
import { agentFor, setRouteHint } from '../net.js'
import { isHgdPlayUrl, resolvePlay as resolveHgdPlay } from './hgdju.js'
import { isVidhubPlayUrl, resolvePlay as resolveVidhubPlay } from './vidhub.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const MEDIA_EXT_RE = /\.(m3u8|mp4|flv|ts|mkv|mov)(\?|#|$)/i
const ABS_M3U8_RE = /https?:\/\/[^\s"'<>\\)]+?\.m3u8[^\s"'<>\\)]*/gi
const REL_M3U8_RE = /["'](\/[^"'\s<>\\)]+?\.m3u8[^"'\s<>\\)]*)["']/gi

const resolveCache = new Map() // rawUrl -> { url, at }
const RESOLVE_TTL = 30 * 60 * 1000

export function isHttpUrl(raw) {
  try {
    const u = new URL(String(raw))
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// 把播放地址解析成真正的媒体地址（m3u8/mp4）；已是媒体直接返回
export async function resolveMediaUrl(rawUrl) {
  let url
  try {
    url = new URL(String(rawUrl))
  } catch {
    throw new Error('播放地址非法')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('播放地址非法')
  if (MEDIA_EXT_RE.test(url.pathname)) return url.toString()

  // 短剧源（黄瓜短剧）：播放页里的 m3u8 是 JSON 转义的（&），通用正则抠不出来，走专用解析
  if (isHgdPlayUrl(url.toString())) return resolveHgdPlay(url.toString())
  // 影视站（vidhub）：播放页里是播放器 iframe，m3u8 藏在 /player/ 页的 var config = {} 里
  if (isVidhubPlayUrl(url.toString())) return resolveVidhubPlay(url.toString())

  const cached = resolveCache.get(url.toString())
  if (cached && Date.now() - cached.at < RESOLVE_TTL) return cached.url

  let resolved = url.toString()
  try {
    const text = await httpGetText(url.toString(), { timeout: 12000 })
    const abs = text.match(ABS_M3U8_RE)
    if (abs && abs.length) {
      resolved = abs[0]
    } else {
      for (const m of text.matchAll(REL_M3U8_RE)) {
        try {
          resolved = new URL(m[1], url).toString()
          break
        } catch {
          // 继续尝试
        }
      }
    }
  } catch {
    // 解析失败则回退原地址
  }

  resolveCache.set(url.toString(), { url: resolved, at: Date.now() })
  if (resolveCache.size > 500) {
    const oldest = [...resolveCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100)
    for (const [key] of oldest) resolveCache.delete(key)
  }
  return resolved
}

function rewritePlaylist(text, baseUrl) {
  const proxify = (value) => {
    try {
      const abs = new URL(value, baseUrl).toString()
      return `/api/vod/hls?url=${encodeURIComponent(abs)}`
    } catch {
      return value
    }
  }
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      if (trimmed.startsWith('#')) {
        // EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA 里的 URI="..."
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${proxify(uri)}"`)
      }
      return proxify(trimmed)
    })
    .join('\n')
}

// 探测媒体地址可用性与延迟（HEAD 不可靠，这里用 GET 拿到首包即断开）
function probeOnce(url, timeout) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.get(
      url,
      {
        rejectUnauthorized: false,
        agent: agentFor(url),
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: `${url.protocol}//${url.host}/`,
          Connection: 'close'
        },
        timeout
      },
      (res) => {
        const code = res.statusCode || 0
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume()
          probeOnce(new URL(res.headers.location, url), timeout).then(resolve, reject)
          return
        }
        const contentType = res.headers['content-type'] || ''
        res.destroy()
        if (code >= 200 && code < 300) resolve({ code, contentType })
        else reject(new Error(`HTTP ${code}`))
      }
    )
    req.on('timeout', () => req.destroy(new Error('探测超时')))
    req.on('error', reject)
  })
}

export async function probeMediaUrl(rawUrl, { timeout = 6000 } = {}) {
  let resolved
  try {
    resolved = await resolveMediaUrl(rawUrl)
  } catch (err) {
    return { ok: false, latency: 0, error: err?.message || '地址非法' }
  }
  const started = Date.now()
  try {
    await probeOnce(new URL(resolved), timeout)
    return { ok: true, latency: Date.now() - started, resolved }
  } catch (err) {
    return { ok: false, latency: Date.now() - started, resolved, error: err?.message || '探测失败' }
  }
}

// 流式代理：m3u8 重写，其余（ts/key/mp4）原样透传
export function handleHlsProxy(req, res) {
  const raw = String(req.query.url || '')
  if (!isHttpUrl(raw)) return res.status(400).json({ error: 'url 参数非法' })

  let url
  try {
    url = new URL(raw)
  } catch {
    return res.status(400).json({ error: 'url 参数非法' })
  }
  fetchUpstream(req, res, url, { retried: false })
}

// 取上游：默认走代理（如果配了），失败（网络错误 / 4xx / 5xx）就换另一条路由重试一次。
// 有的 CDN 必须直连（代理 IP 会被拒），有的偏偏只能走代理，所以成功的那条路会被记住。
function fetchUpstream(req, res, url, state) {
  const lib = url.protocol === 'https:' ? https : http
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    Referer: `${url.protocol}//${url.host}/`,
    Connection: 'close'
  }
  if (req.headers.range) headers.Range = req.headers.range

  const agent = agentFor(url, { force: state.force })
  const route = agent ? 'proxy' : 'direct'
  let settled = false

  const retryOtherRoute = (reason) => {
    if (settled || res.headersSent) return
    settled = true
    const other = route === 'proxy' ? 'direct' : 'proxy'
    // other=direct 总是可试；other=proxy 得先确实配了代理
    const otherViable = other === 'direct' ? true : Boolean(agentFor(url, { force: 'proxy' }))
    if (!state.retried && otherViable) {
      console.warn(
        `[vod] ${url.hostname} ${route === 'proxy' ? '代理' : '直连'}失败（${reason}），改用${other === 'proxy' ? '代理' : '直连'}重试`
      )
      fetchUpstream(req, res, url, { ...state, retried: true, force: other })
      return
    }
    res.status(502).json({ error: reason || '上游请求失败' })
  }

  const upstream = lib.get(
    url,
    { rejectUnauthorized: false, agent, headers, timeout: 20000 },
    (remote) => {
      const code = remote.statusCode || 0
      if (code >= 400 || code < 200) {
        remote.resume()
        retryOtherRoute(`上游返回 ${code}`)
        return
      }
      settled = true
      // 只有成功才记住这条路
      setRouteHint(url.hostname, route)

      const contentType = remote.headers['content-type'] || ''
      const isPlaylist =
        /mpegurl|vnd\.apple/i.test(contentType) ||
        /\.m3u8?($|\?)/i.test(url.pathname + url.search)

      if (isPlaylist) {
        const chunks = []
        let total = 0
        remote.on('data', (chunk) => {
          total += chunk.length
          if (total > 4 * 1024 * 1024) {
            remote.destroy()
            return
          }
          chunks.push(chunk)
        })
        remote.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          res.set('Content-Type', 'application/vnd.apple.mpegurl')
          res.set('Cache-Control', 'no-store')
          res.set('Access-Control-Allow-Origin', '*')
          res.send(rewritePlaylist(text, url))
        })
        remote.on('error', () => {
          if (!res.headersSent) res.status(502).json({ error: '上游读取失败' })
          else res.end()
        })
        return
      }

      res.status(code || 200)
      if (contentType) res.set('Content-Type', contentType)
      const len = remote.headers['content-length']
      if (len) res.set('Content-Length', len)
      if (remote.headers['content-range']) res.set('Content-Range', remote.headers['content-range'])
      if (remote.headers['accept-ranges']) res.set('Accept-Ranges', remote.headers['accept-ranges'])
      res.set('Access-Control-Allow-Origin', '*')
      remote.pipe(res)
      remote.on('error', () => res.end())
    }
  )

  upstream.on('timeout', () => upstream.destroy(new Error('请求超时')))
  upstream.on('error', (err) => {
    const message = err?.code === 'ECONNRESET' ? '源站拒绝了连接（可能需要特定 Referer）' : err.message
    retryOtherRoute(message || '上游请求失败')
  })
  req.on('close', () => upstream.destroy())
}
