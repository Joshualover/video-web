// 画质徽标的前端取数小工具：整批 URL 一次请求（服务端有缓存、host 闸门与限流）。
// 探测失败静默——画质是锦上添花的信息，任何异常都不该影响选路面板本身。
import { vodApi } from './vod'

export async function fetchQualities(urls) {
  const list = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string' && u)
  if (!list.length) return {}
  try {
    const { results } = await vodApi.quality(list)
    const map = {}
    for (const r of results || []) {
      if (r && r.url) map[r.url] = r
    }
    return map
  } catch {
    return {}
  }
}

// 徽标三态：有值显示档位；探到清单但无分辨率信息 → 「未知」；失败/未探 → 不显示
export function qualityBadge(entry) {
  if (!entry) return null
  if (entry.status === 'ok' && entry.label) return entry.label
  if (entry.status === 'unknown') return '未知'
  return null
}
