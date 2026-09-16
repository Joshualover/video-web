// 图片代理：采集源的海报常见「防盗链 / http 图片被 https 页面拦截 / 源站慢」，
// 统一走服务端取图（带 Referer 与 UA），并输出长缓存头。
import http from 'node:http'
import https from 'node:https'
import { agentFor } from '../net.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const MAX_BYTES = 8 * 1024 * 1024

export function handleImageProxy(req, res) {
  const raw = String(req.query.url || '')
  let url
  try {
    url = new URL(raw)
  } catch {
    return res.status(400).json({ error: 'url 参数非法' })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return res.status(400).json({ error: 'url 参数非法' })
  }

  const lib = url.protocol === 'https:' ? https : http
  const upstream = lib.get(
    url,
    {
      rejectUnauthorized: false,
      agent: agentFor(url),
      headers: {
        'User-Agent': UA,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        Referer: `${url.protocol}//${url.host}/`,
        Connection: 'close'
      },
      timeout: 15000
    },
    (remote) => {
      const code = remote.statusCode || 0
      if (code >= 400) {
        remote.resume()
        res.status(502).end()
        return
      }
      const length = Number(remote.headers['content-length'] || 0)
      if (length && length > MAX_BYTES) {
        remote.destroy()
        res.status(413).end()
        return
      }
      res.set('Content-Type', remote.headers['content-type'] || 'image/jpeg')
      res.set('Cache-Control', 'public, max-age=86400')
      res.set('Access-Control-Allow-Origin', '*')
      remote.pipe(res)
      remote.on('error', () => res.end())
    }
  )

  upstream.on('timeout', () => upstream.destroy(new Error('请求超时')))
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).end()
    else res.end()
  })
  req.on('close', () => upstream.destroy())
}
