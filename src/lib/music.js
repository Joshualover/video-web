// 音乐接口客户端（对应 server 端 /api/music/*）
import { apiAuthHeaders } from './fetch.js'

async function apiGet(path, params = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    query.set(key, String(value))
  }
  const url = query.toString() ? `${path}?${query}` : path
  const resp = await fetch(url, { headers: apiAuthHeaders() })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(data.error || `请求失败（${resp.status}）`)
  return data
}

async function apiSend(path, body, method = 'POST') {
  const resp = await fetch(path, {
    method,
    headers: apiAuthHeaders({ 'Content-Type': 'application/json' }),
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(data.error || `请求失败（${resp.status}）`)
  return data
}

export const musicApi = {
  sources: () => apiGet('/api/music/sources'),
  setSourceEnabled: (id, enabled) =>
    apiSend(`/api/music/sources/${encodeURIComponent(id)}`, { enabled }, 'PUT'),
  checkSource: (id) => apiSend(`/api/music/sources/${encodeURIComponent(id)}/check`, {}),
  addSource: (body) => apiSend('/api/music/sources', body),
  removeSource: (id) => apiSend(`/api/music/sources/${encodeURIComponent(id)}`, null, 'DELETE'),
  // slow: 'exclude' = 只要快源（第一趟）；'only' = 只要慢源（第二趟，如 yt-dlp）
  search: (wd, opts = {}) =>
    apiGet('/api/music/search', {
      wd,
      source: opts.source,
      limit: opts.limit || 40,
      slow: opts.slow
    }),
  stream: (source, id) => apiGet('/api/music/stream', { source, id }),
  // 等价 Spotube 的 matches()：本音源拿不到播放地址时，用「曲名 + 艺术家 + 时长」去别的音源找
  match: (params) => apiGet('/api/music/match', params)
}

// 封面统一走服务端图片代理，与影视海报同理
export function musicImage(url) {
  const raw = String(url || '').trim()
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw)) return raw
  const token = import.meta.env?.VITE_PROXY_TOKEN
  const query = `url=${encodeURIComponent(raw)}${token ? `&token=${encodeURIComponent(token)}` : ''}`
  return `/api/music/image?${query}`
}

// 服务端已把本站代理地址放在 playUrl，优先取带 playUrl 的那条流
export function pickStream(streams) {
  const list = Array.isArray(streams) ? streams : []
  return list.find((item) => item && item.playUrl) || list[0] || null
}

export function artistText(artists) {
  if (Array.isArray(artists)) return artists.filter(Boolean).join(', ')
  return String(artists || '')
}

export function formatMusicDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
