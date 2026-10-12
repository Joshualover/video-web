// 播放地址解析 + HLS 代理
//  - 部分源 vod_play_url 给的是「网页播放页」（如 /share/xxx、/play/xxx），需要从 HTML 中解析真实 m3u8
//  - 部分 CDN 会校验 Referer / 不允许跨域，统一走服务端代理（含 m3u8 内片段地址重写）
import http from 'node:http'
import https from 'node:https'
import { httpGetText } from './maccms.js'
import { agentFor, setRouteHint } from '../net.js'
import { ALLOW_INSECURE_TLS, assertPublicTarget, sanitizeMediaContentType, tokenFromRequest } from '../proxy-core.js'
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
  // 出口校验：内网/元数据地址直接拒绝，与 /api/vod/hls、/api/vod/image 保持一致
  await assertPublicTarget(url.toString())
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
  } catch (err) {
    // 解析失败可以回退原地址，但「目标被出口校验拒绝」不能吞：吞掉会让调用方拿到
    // 200 + 一个根本播不了的地址，排障时看不到真正原因（下游还会再拦一次，安全无碍）。
    if (err?.status === 403 || err?.status === 400) throw err
    console.warn(`[vod] 播放页解析失败，回退原地址：${url.hostname} - ${err?.message || err}`)
  }

  resolveCache.set(url.toString(), { url: resolved, at: Date.now() })
  if (resolveCache.size > 500) {
    const oldest = [...resolveCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100)
    for (const [key] of oldest) resolveCache.delete(key)
  }
  return resolved
}

function rewritePlaylist(text, baseUrl, token = '') {
  const suffix = token ? `&token=${encodeURIComponent(token)}` : ''
  const proxify = (value) => {
    try {
      const abs = new URL(value, baseUrl).toString()
      return `/api/vod/hls?url=${encodeURIComponent(abs)}${suffix}`
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
const MAX_PROBE_REDIRECTS = 3

function probeOnce(url, timeout, hop = 0) {
  return new Promise((resolve, reject) => {
    // 探测同样要过出网校验（best.js 探测的地址来自上游源站返回）
    assertPublicTarget(url.toString()).then(() => {
      const lib = url.protocol === 'https:' ? https : http
      const req = lib.get(
        url,
        {
          rejectUnauthorized: !ALLOW_INSECURE_TLS,
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
            if (hop >= MAX_PROBE_REDIRECTS) {
              reject(new Error('重定向次数过多'))
              return
            }
            probeOnce(new URL(res.headers.location, url), timeout, hop + 1).then(resolve, reject)
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
    }, reject)
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
export async function handleHlsProxy(req, res) {
  const raw = String(req.query.url || '')
  if (!isHttpUrl(raw)) return res.status(400).json({ error: 'url 参数非法' })

  let url
  try {
    url = new URL(raw)
  } catch {
    return res.status(400).json({ error: 'url 参数非法' })
  }
  try {
    // 出口校验：协议合法只是最基本的一条，内网/云元数据地址必须在这里拦掉
    await assertPublicTarget(url.toString())
  } catch (err) {
    return res.status(err.status || 403).json({ error: err.message || '目标地址不被允许' })
  }
  // 令牌链：<video> 发不出自定义头，所以把调用方的 token 透传给重写后的分片/密钥地址。
  // 用 tokenFromRequest 而不是只看 query —— 只带 Authorization 调用时也能正确透传。
  fetchUpstream(req, res, url, { retried: false, token: tokenFromRequest(req) })
}

// 取上游：默认走代理（如果配了），失败（网络错误 / 4xx / 5xx）就换另一条路由重试一次。
// 有的 CDN 必须直连（代理 IP 会被拒），有的偏偏只能走代理，所以成功的那条路会被记住。
// 3xx（CDN 很常见）必须跟随：否则清单会拿到一个空体、分片会拿到一个没有 Location 的 302。
const MAX_FOLLOW_REDIRECTS = 3
// 上游明确拒绝（4xx）之后换路由重试时用的短超时：4xx 是确定性答复，不是网络抖动，
// 换条路多半也是同样结果，没必要让客户端对着 20 秒的静默等一个 502。
const RETRY_TIMEOUT_MS = 6000

// 单次向上游要多少字节。1MiB 是实测出来的：YouTube 对没解出 n 签名的直链按大小限流，
//   bytes=0-1048575 -> 206（1MiB 可以）
//   bytes=0-2097151 -> 403（2MiB 就拒）
// 取整 1MiB 作为每次请求的上限。
const RANGE_CHUNK_BYTES = 1024 * 1024

// 把客户端的 Range 收成一段「不超过 RANGE_CHUNK_BYTES」的有界区间。
// 为什么需要：部分 CDN 只肯按小分片给数据 —— 实测 YouTube 的 googlevideo 对同一条直链
//   bytes=0-      -> 403
//   不带 Range    -> 403
//   bytes=0-2047  -> 206
// 而浏览器 <audio>/<video> 的首发请求恰好是 bytes=0-（或一个很大的闭区间），
// 于是表现为「点了播放一直转圈、最后 502」。收小之后上游返回 206 + Content-Range，
// 播放器拿到总长度会自己继续要后面的分片。
// 返回 null 表示「不用改」（已经够小，或是不认识的写法），调用方按原样重试路由。
export function boundedRange(rangeHeader, chunk = RANGE_CHUNK_BYTES) {
  const raw = String(rangeHeader || '').trim()
  if (!raw) return `bytes=0-${chunk - 1}`
  const matched = raw.match(/^bytes=(\d+)-(\d*)$/i)
  if (!matched) return null
  const start = Number(matched[1])
  if (!Number.isFinite(start) || start < 0) return null
  if (matched[2] === '') return `bytes=${start}-${start + chunk - 1}`
  const end = Number(matched[2])
  if (!Number.isFinite(end) || end < start) return null
  // 闭区间但比上限大：同样收小（少给一些字节是合法的，客户端会再要）
  return end - start + 1 > chunk ? `bytes=${start}-${start + chunk - 1}` : null
}

function fetchUpstream(req, res, url, state) {
  const lib = url.protocol === 'https:' ? https : http
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    Referer: `${url.protocol}//${url.host}/`,
    Connection: 'close'
  }
  if (state.rangeOverride) headers.Range = state.rangeOverride
  else if (req.headers.range) headers.Range = req.headers.range

  const agent = agentFor(url, { force: state.force })
  const route = agent ? 'proxy' : 'direct'
  let settled = false

  const retryOtherRoute = (reason, { timeout } = {}) => {
    if (settled || res.headersSent) return
    settled = true
    const other = route === 'proxy' ? 'direct' : 'proxy'
    // other=direct 总是可试；other=proxy 得先确实配了代理
    const otherViable = other === 'direct' ? true : Boolean(agentFor(url, { force: 'proxy' }))
    if (!state.retried && otherViable) {
      console.warn(
        `[vod] ${url.hostname} ${route === 'proxy' ? '代理' : '直连'}失败（${reason}），改用${other === 'proxy' ? '代理' : '直连'}重试`
      )
      fetchUpstream(req, res, url, { ...state, retried: true, force: other, timeout })
      return
    }
    res.status(502).json({ error: reason || '上游请求失败' })
  }

  const upstream = lib.get(
    url,
    { rejectUnauthorized: !ALLOW_INSECURE_TLS, agent, headers, timeout: state.timeout || 20000 },
    (remote) => {
      const code = remote.statusCode || 0
      if (code >= 300 && code < 400 && remote.headers.location) {
        // 3xx：跟随 Location，每跳都重新过出口校验（重定向是绕过校验的经典手法）
        settled = true // 本次调用交出控制权，不再走 retry 路径
        remote.resume()
        if ((state.hops || 0) >= MAX_FOLLOW_REDIRECTS) {
          res.status(502).json({ error: '上游重定向次数过多' })
          return
        }
        let next
        try {
          next = new URL(remote.headers.location, url)
        } catch {
          res.status(502).json({ error: '上游返回无效跳转' })
          return
        }
        assertPublicTarget(next.toString()).then(
          () => fetchUpstream(req, res, next, { ...state, hops: (state.hops || 0) + 1 }),
          (err) => {
            if (res.headersSent) {
              res.end()
              return
            }
            res.status(err?.status || 403).json({ error: err?.message || '重定向目标不被允许' })
          }
        )
        return
      }
      if (code >= 400 || code < 200) {
        remote.resume()
        // 先试「把开放区间收成有界区间」，再谈换路由：googlevideo 这类上游
        // 拒绝的是无界 Range，换成直连一样会被拒（实测两条路都是 403）。
        if (!state.ranged) {
          const nextRange = boundedRange(headers.Range)
          if (nextRange) {
            settled = true
            console.warn(`[vod] ${url.hostname} 上游返回 ${code}，改用有界 Range 重试`)
            fetchUpstream(req, res, url, { ...state, ranged: true, rangeOverride: nextRange })
            return
          }
        }
        retryOtherRoute(`上游返回 ${code}`, {
          // 收成有界 Range 后仍被拒 = 上游确定性拒绝，换路由给个短超时
          timeout: state.ranged ? RETRY_TIMEOUT_MS : undefined
        })
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
            // 必须带错误 destroy，否则既不会有 end 也不会有 error，响应会一直挂着不结束
            remote.destroy(new Error('清单超过 4MB 限制'))
            return
          }
          chunks.push(chunk)
        })
        remote.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          res.set('Content-Type', 'application/vnd.apple.mpegurl')
          res.set('Cache-Control', 'no-store')
          res.set('Access-Control-Allow-Origin', '*')
          res.send(rewritePlaylist(text, url, state.token))
        })
        remote.on('error', () => {
          if (!res.headersSent) res.status(502).json({ error: '上游读取失败' })
          else res.end()
        })
        return
      }

      res.status(code || 200)
      if (contentType) res.set('Content-Type', sanitizeMediaContentType(contentType))
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
