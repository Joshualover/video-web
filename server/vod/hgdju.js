// 黄瓜短剧（hgdju.com）适配器
//
// 站点结构（实测）：
//   列表   /browse?page=N、频道页 /yuanchuang /mogai /manju /zhenren /aiduanju /aihuanlian
//   详情   /drama/<slug>        —— h1 标题、meta 简介、.ep-grid 里的 /play/<slug>/<n>
//   播放   /play/<slug>/<n>     —— 内嵌 window.HG_PLAY = {...} JSON
//   搜索   /search?q=<关键词>
//
// 三个关键点：
//   1) 播放页里的 m3u8 是 JSON 字符串（`\u0026` 就是 `&`），**必须按 JSON 解析**，
//      直接用正则抠 URL 会把 `\u0026` 带进地址，源站返回 400 Bad Request
//   2) HG_PLAY.episodes[].hls 只有「当前集（±邻近几集）」有值，所以要按请求的 n 取
//   3) hls 里的 auth_key 是时间戳签名（实测约 7 天），所以播放地址**实时解析**、短缓存
//
// 站点域名在国内网络常被墙（需要 VOD_HTTP_PROXY），媒体域 hlsapp.ndhixj.cn 一般可直连。
import { httpGetText } from './maccms.js'

const SITE = 'https://hgdju.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const PAGE_TTL = 10 * 60 * 1000 // 列表/详情/搜索缓存
const PLAY_TTL = 5 * 60 * 1000 // 播放地址缓存（auth_key 有 7 天，但别缓存太久）
const MAX_ENTRIES = 200

export const HGD_SITE = SITE
// 不列「browse/最近更新」：前端标签栏本来就有一个「最近更新」（不带 type 参数，等价）。
// 该频道仍可访问：typeId 为空或未知时 fetchList 会回退到 /browse
export const HGD_CATEGORIES = [
  { id: 'yuanchuang', name: '原创短剧' },
  { id: 'mogai', name: '魔改短剧' },
  { id: 'manju', name: 'AI 漫剧' },
  { id: 'zhenren', name: '真人短剧' },
  { id: 'aiduanju', name: 'AI 短剧' },
  { id: 'aihuanlian', name: 'AI 换脸' }
]

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

// 站点对突发请求敏感（实测连续请求会 SSL 中断 / 连不上），所以全局串行 + 最小间隔
const MIN_GAP = 350
let queue = Promise.resolve()
let lastAt = 0

function schedule(task) {
  const run = async () => {
    const wait = lastAt + MIN_GAP - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastAt = Date.now()
    return task()
  }
  const result = queue.then(run, run)
  queue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

// 站点偶尔抽风（ECONNRESET / SSL 中断），重试一次
async function fetchText(url, { timeout = 15000 } = {}) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await schedule(() =>
        httpGetText(url, {
          timeout,
          headers: {
            'User-Agent': UA,
            Referer: `${SITE}/`,
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }
        })
      )
    } catch (err) {
      lastError = err
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 800))
    }
  }
  throw lastError
}

function absolute(url) {
  const raw = String(url || '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  return `${SITE}${raw.startsWith('/') ? '' : '/'}${raw}`
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

// 列表卡片：<div class="card"> … <a class="card-main" href="/play/<slug>"> … <b class="card-title">
function parseCards(html) {
  const out = []
  const blocks = String(html).match(/<div class="card">[\s\S]*?(?=<div class="card">|<\/div>\s*<\/div>\s*<div class="pager|$)/g) || []
  for (const block of blocks) {
    const slug = (block.match(/href="\/play\/([A-Za-z0-9_-]+)/) || [])[1]
    if (!slug) continue
    const title = decodeEntities((block.match(/class="card-title"[^>]*>([^<]*)</) || [])[1] || '')
    if (!title) continue
    const cover =
      (block.match(/z-image-loader-url="([^"]+)"/) || [])[1] ||
      (block.match(/data-cover-fb="([^"]+)"/) || [])[1] ||
      (block.match(/<img[^>]+src="([^"]+)"/) || [])[1] ||
      ''
    const line = decodeEntities((block.match(/class="card-line"[^>]*>([^<]*)</) || [])[1] || '')
    const epText = decodeEntities((block.match(/class="card-ep[^"]*"[^>]*>([^<]*)</) || [])[1] || '')
    const meta = decodeEntities((block.match(/class="card-meta[^"]*"[^>]*>([^<]*)</) || [])[1] || '')
    // 卡片 meta 里是「9.4万 热度」这类热度值（站点没有评分），拿来做无集数时的备注
    const hot = (meta.match(/([\d.]+万?)\s*热度/) || [])[1] || ''
    const year = (meta.match(/(20\d{2})/) || [])[1] || ''
    out.push({
      id: slug,
      name: title,
      pic: absolute(cover),
      remarks: epText || (hot ? `${hot}热度` : ''),
      year,
      type: line,
      score: '',
      playPage: `${SITE}/play/${slug}`
    })
  }
  // 保底：卡片结构变了也能抓到标题 + 链接
  if (!out.length) {
    for (const m of String(html).matchAll(/href="\/play\/([A-Za-z0-9_-]+)"[^>]*>[\s\S]{0,400}?<b class="card-title"[^>]*>([^<]*)</g)) {
      const title = decodeEntities(m[2])
      if (title) out.push({ id: m[1], name: title, pic: '', remarks: '', year: '', type: '', score: '', playPage: `${SITE}/play/${m[1]}` })
    }
  }
  return out
}

function parseHgPlay(html) {
  const text = String(html)
  const marker = text.indexOf('window.HG_PLAY')
  if (marker < 0) return null
  const start = text.indexOf('{', marker)
  if (start < 0) return null
  // 从第一个 { 开始做括号配对，避免正则被 JSON 里的花括号/引号坑到
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

export function isHgdUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl))
    return /(^|\.)hgdju\.com$/i.test(url.hostname)
  } catch {
    return false
  }
}

export function isHgdPlayUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl))
    return /(^|\.)hgdju\.com$/i.test(url.hostname) && /^\/play\//.test(url.pathname)
  } catch {
    return false
  }
}

export function parseHgdPlayPath(rawUrl) {
  const m = String(rawUrl).match(/\/play\/([A-Za-z0-9_-]+)(?:\/(\d+))?/)
  return { slug: m ? m[1] : '', n: m && m[2] ? m[2] : '' }
}

// 分类（也用来做健康检测：能打开 /browse 就算可用）
export async function fetchCategories() {
  const cached = cacheGet(pageCache, 'categories', PAGE_TTL)
  if (cached) return cached
  await fetchText(`${SITE}/browse`)
  const classes = HGD_CATEGORIES.map((c) => ({ id: c.id, pid: '0', name: c.name }))
  const value = { classes }
  cacheSet(pageCache, 'categories', value)
  return value
}

// 列表：typeId 为频道 slug（browse/原创…），page 从 1 开始
export async function fetchList({ typeId = '', page = 1 } = {}) {
  const known = HGD_CATEGORIES.some((c) => c.id === typeId)
  const path = known ? `/${typeId}` : '/browse'
  const current = Math.min(Math.max(Number(page) || 1, 1), 500)
  const key = `list:${path}:${current}`
  const cached = cacheGet(pageCache, key, PAGE_TTL)
  if (cached) return cached

  const html = await fetchText(`${SITE}${path}?page=${current}`)
  const list = parseCards(html)
  const value = {
    page: current,
    pageCount: list.length ? current + 1 : current, // 站点不返回总页数，按「有内容就还能翻」
    total: 0,
    list
  }
  cacheSet(pageCache, key, value)
  return value
}

// 搜索
export async function fetchSearch(wd) {
  const keyword = String(wd || '').trim()
  if (!keyword) return { page: 1, pageCount: 1, total: 0, list: [] }
  const key = `search:${keyword}`
  const cached = cacheGet(pageCache, key, PAGE_TTL)
  if (cached) return cached
  const html = await fetchText(`${SITE}/search?q=${encodeURIComponent(keyword)}`)
  const list = parseCards(html)
  const value = { page: 1, pageCount: 1, total: list.length, list }
  cacheSet(pageCache, key, value)
  return value
}

// 详情：剧集地址用播放页 URL（真实 m3u8 在播放时实时解析）
export async function fetchDetail(slug) {
  const id = String(slug || '').trim()
  if (!id) return null
  const key = `detail:${id}`
  const cached = cacheGet(pageCache, key, PAGE_TTL)
  if (cached) return cached

  const html = await fetchText(`${SITE}/drama/${id}`)
  const name = decodeEntities((html.match(/<h1[^>]*>([^<]*)</) || [])[1] || '')
  if (!name) return null
  const content = decodeEntities(
    (html.match(/<meta\s+name="description"\s+content="([^"]*)"/) || [])[1] || ''
  )
  const pic = absolute(
    (html.match(/<img[^>]+z-image-loader-url="([^"]+)"/) || [])[1] ||
      (html.match(/data-cover="([^"]+)"/) || [])[1] ||
      (html.match(/data-cover-fb="([^"]+)"/) || [])[1] ||
      ''
  )
  const line = decodeEntities((html.match(/data-line="([^"]*)"/) || [])[1] || '')
  const totalEp = (html.match(/共\s*(\d+)\s*集/) || [])[1] || ''

  const episodes = []
  const seen = new Set()
  for (const m of html.matchAll(/<a[^>]*class="ep-link[^"]*"[^>]*href="\/play\/([A-Za-z0-9_-]+)\/(\d+)"[^>]*>([^<]*)</g)) {
    const [, epSlug, n, label] = m
    if (seen.has(n)) continue
    seen.add(n)
    episodes.push({ name: `第${decodeEntities(label) || n}集`, url: `${SITE}/play/${epSlug}/${n}` })
  }
  // 兜底：有的页面只给 /play/<slug>（从第 1 集开始）
  if (!episodes.length) {
    episodes.push({ name: '第1集', url: `${SITE}/play/${id}` })
  }

  const video = {
    id,
    name,
    pic,
    remarks: totalEp ? `共 ${totalEp} 集` : '',
    year: (content.match(/(20\d{2})/) || [])[1] || '',
    type: line || '短剧',
    typeId: '',
    area: '',
    lang: '',
    score: '',
    actor: '',
    director: '',
    duration: '',
    updatedAt: '',
    content,
    playFrom: [line || '短剧线路'],
    playUrl: [episodes]
  }
  cacheSet(pageCache, key, video)
  return video
}

// 播放：实时解析播放页里的 HG_PLAY，取请求那一集的 m3u8
export async function resolvePlay(rawUrl) {
  const { slug, n } = parseHgdPlayPath(rawUrl)
  if (!slug) throw new Error('播放地址非法')
  const key = `${slug}/${n || 1}`
  const cached = cacheGet(playCache, key, PLAY_TTL)
  if (cached) return cached

  const path = n ? `/play/${slug}/${n}` : `/play/${slug}`
  const html = await fetchText(`${SITE}${path}`)
  const data = parseHgPlay(html)
  if (!data || !Array.isArray(data.episodes)) throw new Error('播放页解析失败（站点结构可能变了）')

  const byNumber = data.episodes.find((ep) => String(ep.n) === String(n))
  const withUrl = (ep) => Boolean(ep && (ep.hls || ep.mp4))
  const ep =
    (withUrl(byNumber) && byNumber) ||
    data.episodes.find(withUrl) ||
    byNumber ||
    data.episodes[0]
  const media = ep ? ep.hls || ep.mp4 : ''
  if (!media) throw new Error('该集暂无播放地址')

  cacheSet(playCache, key, media)
  return media
}
