// 黄瓜短剧（hgdju.com）适配器
//
// 站点结构（实测，2026-09 改版为 Nuxt3 SSR 后）：
//   列表   /browse、频道页 /yuanchuang /mogai /manju /zhenren /aiduanju，分页 /<频道>/page-N
//   详情   /drama/dj-<hash>      —— h1 标题、meta 简介、data-xpch="episode-grid" 里的 /play/dj-<hash>/<n>
//   播放   /play/dj-<hash>/<n>   —— 内嵌 Nuxt 数据里的 source_url（m3u8，\u002F 转义）
//   搜索   /search?q=<关键词>    —— 结构与列表页一致
//
// 三个关键点：
//   1) 播放页里的 m3u8 藏在 Nuxt 序列化数据里，路径分隔符是 `\u002F`（即 `/`），
//      取出后要把 `\u002F` 还原成 `/`
//   2) m3u8 的 auth_key 是时间戳签名（约 7 天），所以播放地址**实时解析**、短缓存
//   3) slug 由旧版 <slug> 变为 dj-<hash>，详情/播放路径都要用新 slug
//
// 站点域名在国内网络常被墙（需要 VOD_HTTP_PROXY），媒体域 hls.qldjxf.cn 一般可直连。
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
  { id: 'aiduanju', name: 'AI 短剧' }
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

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 列表卡片：<article data-xpch="card-drama"> … 标题在 img alt / aria-label，详情 /drama/dj-<hash>
function parseCards(html) {
  const out = []
  const seen = new Set()
  const text = String(html)
  const blocks =
    text.match(/<article\s+data-xpch="card-drama"[\s\S]*?(?=<article\s+data-xpch="card-drama"|$)/g) || []
  for (const block of blocks) {
    const slug = (block.match(/href="\/drama\/([A-Za-z0-9_-]+)"/) || [])[1]
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    // 标题：aria-label（「标题 详情」去尾巴）优先，img alt 兜底
    const aria = decodeEntities((block.match(/aria-label="([^"]+)"/) || [])[1] || '').replace(/\s*详情\s*$/, '')
    const alt = decodeEntities((block.match(/<img[^>]*alt="([^"]+)"/) || [])[1] || '')
    const title = aria || alt
    if (!title) continue
    // 卡片上的播放链接（最新一集）：/play/<slug>/<n>
    const playN = (block.match(new RegExp(`href="/play/${escapeReg(slug)}/(\\d+)"`)) || [])[1] || ''
    const epText = (block.match(/全\s*\d+\s*集|更新至\s*\d+\s*集/) || [])[0] || ''
    const hot = (block.match(/([\d.]+万?)\s*热度/) || [])[1] || ''
    out.push({
      id: slug,
      name: title,
      pic: '',
      remarks: decodeEntities(epText) || (hot ? `${hot}热度` : ''),
      year: '',
      type: '',
      score: '',
      playPage: `${SITE}/play/${slug}${playN ? `/${playN}` : ''}`
    })
  }
  return out
}

// 播放页：m3u8 藏在 Nuxt 序列化数据里，路径分隔符是 \u002F（即 /）
function parseMediaUrl(html) {
  const text = String(html)
  // URL 里的 \u002F 是字面反斜杠，所以字符类不能排除反斜杠
  let m = text.match(/https?:(?:\\u002F|\/){2}[^"'\s]+?\.m3u8[^"'\s]*/i)
  if (!m) m = text.match(/https?:[^"'\s]+?\.m3u8[^"'\s]*/i)
  if (!m) return ''
  return m[0].replace(/\\u002F/gi, '/').replace(/\\u0026/gi, '&').replace(/\\\//g, '/')
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

// 列表：typeId 为频道 slug（browse/原创…），page 从 1 开始；分页走 /<频道>/page-N
export async function fetchList({ typeId = '', page = 1 } = {}) {
  const known = HGD_CATEGORIES.some((c) => c.id === typeId)
  const base = known ? `/${typeId}` : '/browse'
  const current = Math.min(Math.max(Number(page) || 1, 1), 500)
  const path = current > 1 ? `${base}/page-${current}` : base
  const key = `list:${path}`
  const cached = cacheGet(pageCache, key, PAGE_TTL)
  if (cached) return cached

  const html = await fetchText(`${SITE}${path}`)
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
  // 封面：pic.ndhixj.cn 的转义 URL
  const picMatch =
    html.match(/https?:\\u002F\\u002Fpic\.[^"\\\s]+?\.(?:jpe?g|png|webp)/i) ||
    html.match(/https?:\/\/pic\.[^"'\s<>\\]+?\.(?:jpe?g|png|webp)/i)
  const pic = picMatch ? picMatch[0].replace(/\\u002F/gi, '/').replace(/\\\//g, '/') : ''
  const totalEp = (html.match(/共\s*(\d+)\s*集/) || [])[1] || ''

  // 剧集：当前剧 slug 下的 /play/<slug>/<n>（推荐区是别的 slug，天然排除）
  const episodes = []
  const seen = new Set()
  const esc = escapeReg(id)
  for (const m of html.matchAll(new RegExp(`href="/play/${esc}/(\\d+)"`, 'g'))) {
    const n = m[1]
    if (seen.has(n)) continue
    seen.add(n)
    episodes.push({ name: `第${n}集`, url: `${SITE}/play/${id}/${n}` })
  }
  episodes.sort((a, b) => {
    const na = Number((a.url.match(/(\d+)$/) || [])[1]) || 0
    const nb = Number((b.url.match(/(\d+)$/) || [])[1]) || 0
    return na - nb
  })
  if (!episodes.length) {
    episodes.push({ name: '第1集', url: `${SITE}/play/${id}/1` })
  }

  const video = {
    id,
    name,
    pic,
    remarks: totalEp ? `共 ${totalEp} 集` : '',
    year: (content.match(/(20\d{2})/) || [])[1] || '',
    type: '短剧',
    typeId: '',
    area: '',
    lang: '',
    score: '',
    actor: '',
    director: '',
    duration: '',
    updatedAt: '',
    content,
    playFrom: ['短剧线路'],
    playUrl: [episodes]
  }
  cacheSet(pageCache, key, video)
  return video
}

// 播放：实时解析播放页内嵌数据里的 m3u8（source_url）
export async function resolvePlay(rawUrl) {
  const { slug, n } = parseHgdPlayPath(rawUrl)
  if (!slug) throw new Error('播放地址非法')
  const key = `${slug}/${n || 1}`
  const cached = cacheGet(playCache, key, PLAY_TTL)
  if (cached) return cached

  const path = n ? `/play/${slug}/${n}` : `/play/${slug}`
  const html = await fetchText(`${SITE}${path}`)
  const media = parseMediaUrl(html)
  if (!media) throw new Error('播放页解析失败（站点结构可能变了）')

  cacheSet(playCache, key, media)
  return media
}
