// 图片代理：采集源的海报常见「防盗链 / http 图片被 https 页面拦截 / 源站慢」，
// 统一走服务端取图（带 Referer 与 UA），并输出长缓存头。
//
// 防盗链策略是「猜」的，所以按顺序试，成功过的策略记下来（同一域名下次直接用）：
//   1) Referer=目标自身域名     —— 最常见的「必须是自己站」防盗链
//   2) Referer=movie.douban.com —— 豆瓣图床要求任意第三方 Referer（不带就直接 418）
//   3) 不带 Referer             —— 少数图床只认空 Referer
// 若走代理拿不到（部分 CDN 拒绝代理 IP），再直连重试一次。
import http from 'node:http'
import https from 'node:https'
import { agentFor } from '../net.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const MAX_BYTES = 8 * 1024 * 1024
const STRATEGY_ATTEMPTS = 3

// host -> 已确认可用的 Referer 策略
const refererHints = new Map()

function refererStrategies(url) {
  const list = [`${url.protocol}//${url.host}/`]
  if (/douban/i.test(url.host)) list.push('https://movie.douban.com/')
  list.push('')
  return list
}

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
  const hinted = refererHints.get(url.host)
  fetchImage(req, url, res, { strategy: hinted ?? 0, tried: 0, viaProxy: true })
}

function fetchImage(req, url, res, state) {
  const strategies = refererStrategies(url)
  const index = Math.min(state.strategy, strategies.length - 1)
  const referer = strategies[index]
  const lib = url.protocol === 'https:' ? https : http
  const agent = state.viaProxy ? agentFor(url) : undefined
  const headers = {
    'User-Agent': UA,
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    Connection: 'close'
  }
  if (referer) headers.Referer = referer

  let settled = false
  const retry = () => {
    if (settled || res.headersSent) return
    settled = true
    // 先换 Referer 策略；策略试完了再直连重试一次
    if (state.strategy + 1 < strategies.length) {
      fetchImage(req, url, res, { ...state, strategy: state.strategy + 1, viaProxy: state.viaProxy })
      return
    }
    if (state.viaProxy) {
      fetchImage(req, url, res, { strategy: 0, tried: state.tried + 1, viaProxy: false })
      return
    }
    res.status(502).end()
  }

  const upstream = lib.get(url, { rejectUnauthorized: false, agent, headers, timeout: 15000 }, (remote) => {
    const code = remote.statusCode || 0
    if (code >= 400 || code < 200) {
      remote.resume()
      retry()
      return
    }
    const length = Number(remote.headers['content-length'] || 0)
    if (length && length > MAX_BYTES) {
      remote.destroy()
      settled = true
      res.status(413).end()
      return
    }
    settled = true
    refererHints.set(url.host, index)
    res.set('Content-Type', remote.headers['content-type'] || 'image/jpeg')
    res.set('Cache-Control', 'public, max-age=86400')
    res.set('Access-Control-Allow-Origin', '*')
    remote.pipe(res)
    remote.on('error', () => res.end())
  })

  upstream.on('timeout', () => upstream.destroy(new Error('请求超时')))
  upstream.on('error', () => retry())
  req.on('close', () => upstream.destroy())
}

export { STRATEGY_ATTEMPTS }
