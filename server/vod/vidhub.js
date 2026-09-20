// vidhub.tv 适配器（苹果 CMS V10 模板站，但采集接口 /api.php/provide/vod/ 已关闭）
//
// 实测的可用路径：
//   搜索   /index.php/ajax/suggest?mid=1&wd=<关键词>   → JSON {total,list:[{id,name,pic}]}（无需验证码）
//          （HTML 搜索页 /vodsearch 有人机验证，要人工输图形码，所以走 ajax）
//   列表   /vodshow/<type>-----------.html              第 1 页（72 条）
//          /vodshow/<type>--------<page>---.html        第 N 页
//   分类   /vodtype/1..4.html  电影 / 电视剧 / 综艺 / 动漫
//   详情   /voddetail/<id>.html                          h1 标题、meta 简介、封面、剧集
//   播放   /vodplay/<id>-<sid>-<nid>.html                页面里是 iframe /player/?u=<密文>
//          → /player/?u=… 直接给 var config = {...}，其中 url 就是明文 m3u8
//
// 注意：这个站点及其媒体 CDN 走代理反而会被 Cloudflare challenge / 404，
//      所以这里强制直连（失败才退回代理），并把解析出的媒体域名登记为直连。
import { httpGetText } from './maccms.js'
import { addDirectHosts } from '../net.js'

const SITE = 'https://vidhub.tv'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const PAGE_TTL = 15 * 60 * 1000
const PLAY_TTL = 3 * 60 * 60 * 1000 // m3u8 是静态地址（无 auth 参数），可以缓存久一点
const MAX_ENTRIES = 200

export const VIDHUB_SITE = SITE
export const VIDHUB_CATEGORIES = [
  { id: '1', name: '电影' },
  { id: '2', name: '电视剧' },
  { id: '3', name: '综艺' },
  { id: '4', name: '动漫' }
]

// 站点本身必须直连（代理 IP 会被 CF challenge）；它的媒体 CDN 走哪条路由由
// hls 代理「失败换路 + 记忆」自动决定（既有必须直连的，也有必须走代理的）
export const VIDHUB_DIRECT_HOSTS = ['vidhub.tv', 'vidhub3.top']
addDirectHosts(VIDHUB_DIRECT_HOSTS)

const pageCache = new Map()
const playCache = new Map()

function cacheGet(store, key, ttl) {
  const hit = store.get(key)
  if (hit && Date.now() - hit.at < ttl) return hit.value
  if (hit) store.delete(key)
  return null
}

function cacheSet(store, key, value) {
  store.set(key, { at: Date.now(), value })
  if (store.size > MAX_ENTRIES) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 50)
    for (const [k] of oldest) store.delete(k)
  }
}

let lastAt = 0
async function polite() {
  const wait = lastAt + 250 - Date.now()
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  lastAt = Date.now()
}

// 先直连（该站对代理 IP 会 challenge），失败再退回代理
async function fetchText(url, { timeout = 15000 } = {}) {
  const headers = {
    'User-Agent': UA,
    Referer: `${SITE}/`,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
  }
  let directError
  for (const proxy of [false, true]) {
    try {
      await polite()
      return await httpGetText(url, { timeout, headers, proxy })
    } catch (err) {
      if (proxy === false) directError = err
      else throw directError || err
    }
  }
  throw directError || new Error('请求失败')
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function absolute(url) {
  const raw = String(url || '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  return `${SITE}${raw.startsWith('/') ? '' : '/'}${raw}`
}

// 列表卡片：<div class="module-item"> … href="/voddetail/<id>.html" title="…" … data-src="…"
function parseCards(html) {
  const out = []
  const seen = new Set()
  const blocks = String(html).match(/<div class="module-item">[\s\S]*?(?=<div class="module-item">|<\/div><\/div><\/div>$)/g) || []
  const chunks = blocks.length ? blocks : [String(html)]
  for (const block of chunks) {
    for (const tag of block.match(/<a\b[^>]*>/g) || []) {
      const href = (tag.match(/href="\/voddetail\/(\d+)\.html"/) || [])[1]
      if (!href || seen.has(href)) continue
      const title = decodeEntities((tag.match(/title="([^"]*)"/) || [])[1] || '')
      if (!title) continue
      // 卡片内的其他字段从该卡片块里取
      const start = block.indexOf(tag)
      const scope = block.slice(start, start + 900)
      const pic = absolute((scope.match(/data-src="([^"]+)"/) || [])[1] || '')
      const caption = scope.match(/class="module-item-caption">([\s\S]{0,220}?)<\/div>/)
      const spans = caption ? [...caption[1].matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => decodeEntities(m[1])) : []
      const note = decodeEntities(
        (scope.match(/class="module-item-note"[^>]*>([^<]*)</) || [])[1] ||
          (scope.match(/class="module-item-text"[^>]*>([^<]*)</) || [])[1] ||
          ''
      )
      const year = spans.find((s) => /^(19|20)\d{2}$/.test(s)) || ''
      const type = spans.find((s) => s && s !== year && !/中国大陆|中国香港|中国台湾|美国|日本|韩国|英国|法国|泰国|印度|其他|大陆|香港|台湾/.test(s)) || ''
      seen.add(href)
      out.push({
        id: href,
        name: title,
        pic,
        remarks: note,
        year,
        type,
        score: '',
        playPage: `${SITE}/voddetail/${href}.html`
      })
    }
  }
  return out
}

export function isVidhubUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl))
    return /(^|\.)vidhub\d*\.(tv|top|cc|vip|xyz)$/i.test(url.hostname)
  } catch {
    return false
  }
}

export function isVidhubPlayUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl))
    return /(^|\.)vidhub\d*\.(tv|top|cc|vip|xyz)$/i.test(url.hostname) && /^\/vodplay\//.test(url.pathname)
  } catch {
    return false
  }
}

export function parseVidhubPlayPath(rawUrl) {
  const m = String(rawUrl).match(/\/vodplay\/(\d+)-(\d+)-(\d+)\.html/)
  return m ? { id: m[1], sid: m[2], nid: m[3] } : { id: '', sid: '', nid: '' }
}

// 分类（同时作为健康检测：能打开 /vodtype/1.html 就算可用）
export async function fetchCategories() {
  const cached = cacheGet(pageCache, 'categories', PAGE_TTL)
  if (cached) return cached
  await fetchText(`${SITE}/vodtype/1.html`)
  const value = { classes: VIDHUB_CATEGORIES.map((c) => ({ id: c.id, pid: '0', name: c.name })) }
  cacheSet(pageCache, 'categories', value)
  return value
}

// 列表：typeId 为 1..4；page 从 1 开始。为空时取站点首页（各分类最新合集）
export async function fetchList({ typeId = '', page = 1 } = {}) {
  const type = VIDHUB_CATEGORIES.some((c) => c.id === typeId) ? typeId : ''
  const current = Math.min(Math.max(Number(page) || 1, 1), 500)
  const key = `list:${type || 'home'}:${current}`
  const cached = cacheGet(pageCache, key, PAGE_TTL)
  if (cached) return cached

  let html
  if (!type) {
    // 「最近更新」取站点首页（各分类最新合集），首页没有分页
    if (current > 1) return { page: 1, pageCount: 1, total: 0, list: [] }
    html = await fetchText(`${SITE}/`)
  } else {
    html =
      current === 1
        ? await fetchText(`${SITE}/vodshow/${type}-----------.html`)
        : await fetchText(`${SITE}/vodshow/${type}--------${current}---.html`)
  }
  const list = html ? parseCards(html) : []
  const value = {
    page: current,
    // 首页没有翻页；分类页按「有内容就还能翻」估算
    pageCount: type && list.length ? current + 1 : current,
    total: 0,
    list
  }
  cacheSet(pageCache, key, value)
  return value
}

// 搜索：走 ajax/suggest（无验证码）
export async function fetchSearch(wd) {
  const keyword = String(wd || '').trim()
  if (!keyword) return { page: 1, pageCount: 1, total: 0, list: [] }
  const key = `search:${keyword}`
  const cached = cacheGet(pageCache, key, PAGE_TTL)
  if (cached) return cached

  const text = await fetchText(`${SITE}/index.php/ajax/suggest?mid=1&wd=${encodeURIComponent(keyword)}`)
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  const list = (Array.isArray(data?.list) ? data.list : []).map((item) => ({
    id: String(item?.id || ''),
    name: String(item?.name || ''),
    pic: absolute(item?.pic || ''),
    remarks: '',
    year: '',
    type: '',
    score: '',
    playPage: `${SITE}/voddetail/${item?.id}.html`
  })).filter((item) => item.id && item.name)

  const value = { page: 1, pageCount: 1, total: list.length, list }
  cacheSet(pageCache, key, value)
  return value
}

// 详情：多线路剧集（线路名 + 剧集名）
export async function fetchDetail(id) {
  const vid = String(id || '').trim()
  if (!/^\d+$/.test(vid)) return null
  const key = `detail:${vid}`
  const cached = cacheGet(pageCache, key, PAGE_TTL)
  if (cached) return cached

  const html = await fetchText(`${SITE}/voddetail/${vid}.html`)
  const name = decodeEntities((html.match(/<h1[^>]*>([^<]*)<\/h1>/) || [])[1] || '')
  if (!name) return null
  const content = decodeEntities((html.match(/<meta\s+name="description"\s+content="([^"]*)"/) || [])[1] || '')
  const cover = html.match(/<div class="video-cover">[\s\S]{0,400}?data-src="([^"]+)"/) || html.match(/data-src="([^"]+)"/)
  const pic = absolute(cover ? cover[1] : '')
  const remarks = decodeEntities((html.match(/class="module-info-item[^"]*"[^>]*>([^<]*更新[^<]*)</) || [])[1] || '')

  // 线路名（tab 里的 span + 集数）
  const lineNames = [...html.matchAll(/class="module-tab-item[^"]*"[^>]*>\s*<span>([^<]*)<\/span>/g)].map((m) =>
    decodeEntities(m[1])
  )

  // 剧集：链接只有 title 属性，按 (sid,nid) 去重
  const bySid = new Map()
  for (const tag of html.match(/<a\b[^>]*>/g) || []) {
    const m = tag.match(/href="\/vodplay\/(\d+)-(\d+)-(\d+)\.html"/)
    if (!m || m[1] !== vid) continue
    const sid = m[2]
    const nid = Number(m[3])
    if (!bySid.has(sid)) bySid.set(sid, new Map())
    const group = bySid.get(sid)
    if (group.has(nid)) continue
    const rawTitle = decodeEntities((tag.match(/title="([^"]*)"/) || [])[1] || '')
    const clean = rawTitle.replace(/^(立刻播放|播放)/, '').replace(name, '').trim()
    group.set(nid, { nid, name: clean || `第${nid}集`, sid })
  }

  const sids = [...bySid.keys()].sort((a, b) => Number(a) - Number(b))
  const playFrom = []
  const playUrl = []
  sids.forEach((sid, index) => {
    const episodes = [...bySid.get(sid).values()]
      .sort((a, b) => a.nid - b.nid)
      .map((ep) => ({ name: ep.name, url: `${SITE}/vodplay/${vid}-${sid}-${ep.nid}.html` }))
    if (!episodes.length) return
    playFrom.push(lineNames[index] || `线路${index + 1}`)
    playUrl.push(episodes)
  })
  if (!playUrl.length) return null

  const video = {
    id: vid,
    name,
    pic,
    remarks,
    year: (content.match(/(19|20)\d{2}/) || [])[0] || '',
    type: '',
    typeId: '',
    area: '',
    lang: '',
    score: '',
    actor: '',
    director: '',
    duration: '',
    updatedAt: '',
    content,
    playFrom,
    playUrl
  }
  cacheSet(pageCache, key, video)
  return video
}

function parsePlayerConfig(html) {
  const text = String(html)
  const marker = text.search(/var\s+config\s*=\s*\{/)
  if (marker < 0) return null
  const start = text.indexOf('{', marker)
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

// 播放：播放页 → iframe /player/?u=… → config.url（明文 m3u8）
export async function resolvePlay(rawUrl) {
  const { id, sid, nid } = parseVidhubPlayPath(rawUrl)
  if (!id) throw new Error('播放地址非法')
  const key = `${id}-${sid}-${nid}`
  const cached = cacheGet(playCache, key, PLAY_TTL)
  if (cached) return cached

  const playPage = await fetchText(`${SITE}/vodplay/${id}-${sid}-${nid}.html`)
  const iframe = playPage.match(/<iframe[^>]+src="([^"]*\/player\/\?u=[^"]+)"/)
  if (!iframe) throw new Error('播放页解析失败（未找到播放器 iframe）')
  const playerUrl = absolute(iframe[1].replace(/&amp;/g, '&'))

  const playerHtml = await fetchText(playerUrl)
  const config = parsePlayerConfig(playerHtml)
  const media = String(config?.url || '')
  if (!/^https?:\/\//i.test(media)) throw new Error('未解析到播放地址')

  cacheSet(playCache, key, media)
  return media
}
