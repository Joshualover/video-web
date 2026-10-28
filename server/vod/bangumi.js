// 追番日历（Bangumi 每日放送）——参考 LibreTV 的 bangumi 模块语义重写。
// api.bgm.tv 完全公开免 key；服务端直连 + 内存缓存。
// 注意：Bangumi 要求自带可识别的 UA，默认 UA 会被拒绝（403）。
import { httpGetText } from './maccms.js'

const BANGUMI_API = 'https://api.bgm.tv/calendar'
const CACHE_TTL = 30 * 60 * 1000
const UA = 'flow-player (+https://github.com/Joshualover/video-web)'

const cache = { at: 0, data: null }

/** 星期 id：1=周一 … 7=周日；calendar 偶发返回 8 等非法值，直接丢弃 */
export function normalizeWeekday(id) {
  const n = Number(id)
  return n >= 1 && n <= 7 ? n : undefined
}

/** 单条 subject → 榜单条目；缺标题或封面的条目视为脏数据丢弃 */
export function subjectToItem(subject) {
  const title = subject?.name_cn || subject?.name
  const cover = subject?.images?.large || subject?.images?.common || subject?.images?.medium
  if (!subject?.id || !title || !cover) return undefined
  const score = subject?.rating?.score ?? 0
  return {
    id: String(subject.id),
    title,
    cover,
    rating: score > 0 ? score.toFixed(1) : undefined,
    isTv: true
  }
}

export function groupCalendarByWeekday(raw) {
  const days = {}
  for (const day of Array.isArray(raw) ? raw : []) {
    const weekday = normalizeWeekday(day?.weekday?.id ?? -1)
    if (!weekday) continue
    days[weekday] = (Array.isArray(day.items) ? day.items : [])
      .map(subjectToItem)
      .filter(Boolean)
  }
  return days
}

export async function fetchBangumiCalendar({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_TTL) return cache.data
  const text = await httpGetText(BANGUMI_API, {
    timeout: 8000,
    headers: { 'User-Agent': UA, Accept: 'application/json' }
  })
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Bangumi 接口响应异常（非 JSON）')
  }
  const days = groupCalendarByWeekday(Array.isArray(raw) ? raw : [])
  if (!Object.keys(days).length) throw new Error('Bangumi 放送表数据为空')
  cache.at = Date.now()
  cache.data = days
  return days
}
