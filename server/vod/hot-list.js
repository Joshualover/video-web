// 影视热榜聚合（经 60s API，免 key）——参考 LibreTV 的 douban-weekly 模块语义重写。
// 豆瓣五个周榜 + 百度热播剧榜由 60s 代为抓取；这里只做服务端转发 + 内存缓存 + 字段归一。
// 默认走社区实例，失败自动回退官方公共实例（每日额度有限、数据中心 IP 常被限流）；
// 可用 SIXTY_API_BASE 指向自部署实例。
import { httpGetText } from './maccms.js'

const CACHE_TTL = 60 * 60 * 1000
const UA = 'flow-player (+https://github.com/Joshualover/video-web)'
const FALLBACK_BASE = 'https://60s.viki.moe'

function apiBase() {
  return String(process.env.SIXTY_API_BASE || 'https://60s.crystelf.top').replace(/\/+$/, '')
}

/** 榜单标识：豆瓣五个周榜 + 百度热播剧榜 */
export const HOT_LIST_IDS = [
  'douban_movie_weekly',
  'douban_tv_chinese',
  'douban_tv_global',
  'douban_show_chinese',
  'douban_show_global',
  'baidu_teleplay'
]

export function isHotListId(id) {
  return HOT_LIST_IDS.includes(id)
}

const DOUBAN_WEEKLY_CATEGORY = {
  douban_movie_weekly: 'movie',
  douban_tv_chinese: 'tv_chinese',
  douban_tv_global: 'tv_global',
  douban_show_chinese: 'show_chinese',
  douban_show_global: 'show_global'
}

/** 豆瓣周榜条目 → 统一条目；缺标题或封面的脏数据丢弃。
 *  优先原生 cover（doubanio 域走本站图片代理的豆瓣白名单），公共镜像 cover_proxy 限流严重仅作兜底 */
export function doubanWeeklyToItem(raw, isTv) {
  const cover = raw?.cover || raw?.cover_proxy
  if (!raw?.id || !raw?.title || !cover) return undefined
  return {
    id: String(raw.id),
    title: raw.title,
    cover,
    rating: raw.rating && raw.rating > 0 ? String(raw.rating) : undefined,
    isTv
  }
}

/** 百度热播剧条目 → 统一条目；无评分，海报为空的条目丢弃 */
export function baiduTeleplayToItem(raw, index) {
  if (!raw?.title || !raw?.cover) return undefined
  // 百度榜无稳定 id，用榜单内序号保证前端 key 唯一
  return { id: `baidu_${index}`, title: raw.title, cover: raw.cover, isTv: true }
}

const cache = new Map() // id -> { at, items }

async function fetchJson(path) {
  const primary = apiBase()
  const bases = primary === FALLBACK_BASE ? [primary] : [primary, FALLBACK_BASE]
  let lastError = null
  for (const base of bases) {
    try {
      const text = await httpGetText(`${base}${path}`, {
        timeout: 8000,
        headers: { 'User-Agent': UA, Accept: 'application/json' }
      })
      return JSON.parse(text)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('60s API 请求失败')
}

function assertArray(value, what) {
  if (!Array.isArray(value)) throw new Error(`${what}数据异常`)
  return value
}

export async function fetchHotList(id, { force = false } = {}) {
  if (!isHotListId(id)) throw Object.assign(new Error(`未知榜单: ${String(id).slice(0, 30)}`), { status: 400 })
  const hit = cache.get(id)
  if (!force && hit && Date.now() - hit.at < CACHE_TTL) return hit.items

  const category = DOUBAN_WEEKLY_CATEGORY[id]
  let items
  if (category) {
    const raw = await fetchJson(`/v2/douban/weekly/${category}`)
    const isTv = id !== 'douban_movie_weekly'
    items = assertArray(raw?.data, '豆瓣周榜')
      .map((entry) => doubanWeeklyToItem(entry, isTv))
      .filter(Boolean)
  } else {
    const raw = await fetchJson('/v2/baidu/teleplay')
    items = assertArray(raw?.data, '百度热播剧榜')
      .map((entry, i) => baiduTeleplayToItem(entry, i))
      .filter(Boolean)
  }
  if (!items.length) throw new Error('榜单数据为空')
  cache.set(id, { at: Date.now(), items })
  return items
}
