// 苹果 CMS V10（MacCMS）采集接口封装
// 仅负责「HTTP 取文本 + 解析 + 归一化字段」，所有请求目标都来自服务端白名单，
// 不接受客户端直接传入任意 URL，避免 SSRF。
import http from 'node:http'
import https from 'node:https'
import { agentFor } from '../net.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const MAX_BODY = 12 * 1024 * 1024

export function httpGetText(rawUrl, { timeout = 12000, maxRedirects = 4, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(rawUrl)
    } catch {
      reject(new Error('无法解析的 URL'))
      return
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(new Error('仅支持 http/https'))
      return
    }
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.get(
      url,
      {
        rejectUnauthorized: false,
        agent: agentFor(url),
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
          Connection: 'close',
          ...headers
        },
        timeout
      },
      (res) => {
        const { statusCode, headers: resHeaders } = res
        if (statusCode >= 300 && statusCode < 400 && resHeaders.location && maxRedirects > 0) {
          res.resume()
          resolve(
            httpGetText(new URL(resHeaders.location, url).toString(), {
              timeout,
              maxRedirects: maxRedirects - 1,
              headers
            })
          )
          return
        }
        if (statusCode < 200 || statusCode >= 300) {
          res.resume()
          reject(new Error(`HTTP ${statusCode}`))
          return
        }
        const chunks = []
        let total = 0
        res.on('data', (chunk) => {
          total += chunk.length
          if (total > MAX_BODY) {
            req.destroy(new Error('响应体过大'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      }
    )
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
  })
}

// 兼容：BOM、行注释、JSONP 包裹
export function parseJsonLoose(text) {
  if (!text) throw new Error('空响应')
  let s = String(text).replace(/^\uFEFF/, '').trim()
  const jsonp = s.match(/^[\w$.]+\s*\((.*)\)[;\s]*$/s)
  if (jsonp) s = jsonp[1]
  if (s.startsWith('//')) s = s.replace(/^\s*\/\/.*$/gm, '').trim()
  return JSON.parse(s)
}

function buildUrl(api, params) {
  const u = new URL(api)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    u.searchParams.set(key, String(value))
  }
  return u.toString()
}

export function normalizeClass(item) {
  return {
    id: String(item?.type_id ?? ''),
    pid: String(item?.type_pid ?? '0'),
    name: String(item?.type_name ?? '')
  }
}

export function parsePlayFrom(from) {
  return String(from || '')
    .split('$$$')
    .map((s) => s.trim())
    .filter(Boolean)
}

// 播放地址清洗：
//  - 部分源把地址整体做了 URL 编码（https%3A%2F%2F...）
//  - 部分源在地址后追加播放器参数（url|||eyJhbGci...），那一段是给播放器用的，取前面真正的地址
export function normalizePlayUrl(url) {
  let out = String(url || '').trim()
  if (/^https?%3a/i.test(out)) {
    try {
      out = decodeURIComponent(out)
    } catch {
      // 解码失败则保持原样
    }
  }
  const bar = out.indexOf('|||')
  if (bar > 0) out = out.slice(0, bar)
  return out
}

// vod_play_url: "第1集$url#第2集$url$$$线路2..."
export function parsePlayUrl(play) {
  return String(play || '')
    .split('$$$')
    .map((line) =>
      line
        .split('#')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
          const idx = item.indexOf('$')
          if (idx < 0) return { name: item, url: normalizePlayUrl(item) }
          return { name: item.slice(0, idx), url: normalizePlayUrl(item.slice(idx + 1)) }
        })
        .filter((ep) => /^https?:\/\//i.test(ep.url))
    )
}

export function normalizeVideo(v) {
  return {
    id: String(v?.vod_id ?? ''),
    name: String(v?.vod_name ?? ''),
    pic: String(v?.vod_pic ?? ''),
    remarks: String(v?.vod_remarks ?? ''),
    year: String(v?.vod_year ?? ''),
    type: String(v?.type_name ?? ''),
    typeId: String(v?.type_id ?? ''),
    area: String(v?.vod_area ?? ''),
    lang: String(v?.vod_lang ?? ''),
    score: String(v?.vod_score ?? ''),
    actor: String(v?.vod_actor ?? ''),
    director: String(v?.vod_director ?? ''),
    duration: String(v?.vod_duration ?? ''),
    updatedAt: String(v?.vod_time ?? ''),
    content: String(v?.vod_content ?? v?.vod_blurb ?? '').replace(/<[^>]+>/g, '').trim(),
    playFrom: parsePlayFrom(v?.vod_play_from),
    playUrl: parsePlayUrl(v?.vod_play_url)
  }
}

export async function fetchCategories(api, opts = {}) {
  const text = await httpGetText(buildUrl(api, { ac: 'list' }), opts)
  const data = parseJsonLoose(text)
  const classes = Array.isArray(data?.class) ? data.class.map(normalizeClass).filter((c) => c.id) : []
  return { classes }
}

export async function fetchList(api, { typeId, page = 1, wd, hours } = {}, opts = {}) {
  const params = { ac: 'videolist', pg: page }
  if (typeId) params.t = typeId
  if (wd) params.wd = wd
  if (hours) params.h = hours
  const text = await httpGetText(buildUrl(api, params), opts)
  const data = parseJsonLoose(text)
  const list = Array.isArray(data?.list) ? data.list.map(normalizeVideo) : []
  return {
    page: Number(data?.page) || page,
    pageCount: Number(data?.pagecount) || 1,
    total: Number(data?.total) || list.length,
    list
  }
}

export async function fetchDetail(api, id, opts = {}) {
  // 苹果 CMS V10 的标准详情参数是 ac=detail；一部分源（尤其是多仓订阅下发的接口）只认这个，
  // 而另一部分老源只认 ac=videolist&ids。两种都试，优先取能给出剧集地址的那个。
  let fallback = null
  for (const ac of ['detail', 'videolist']) {
    try {
      const text = await httpGetText(buildUrl(api, { ac, ids: id }), opts)
      const data = parseJsonLoose(text)
      const list = Array.isArray(data?.list) ? data.list : []
      const video = list.length ? normalizeVideo(list[0]) : null
      if (!video) continue
      if (video.playUrl.length) return video
      if (!fallback) fallback = video
    } catch {
      // 换下一种详情参数
    }
  }
  return fallback
}
