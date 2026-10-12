// Invidious 适配器 —— YouTube 音频的另一条开源前端通路
//
// Spotube 曾在设置里直接提供 Invidious 音源（assets/images/logos/invidious.jpg），
// 这里沿用同一套 API：
//   GET {base}/api/v1/search?q=<关键词>&type=video   搜索
//   GET {base}/api/v1/videos/<videoId>?local=true    音频流清单
// local=true 让实例代替浏览器去取 googlevideo（同样是为了国内可达 + 免签名问题）。
import { getJson } from './http.js'

export const kind = 'invidious'
export const capabilities = { search: true, stream: true, preview: false, slow: false }

function absolute(url, apiBase) {
  const raw = String(url || '').trim()
  if (!raw) return ''
  try {
    return new URL(raw, apiBase).toString()
  } catch {
    return ''
  }
}

// videoThumbnails 是按尺寸排开的一组，挑最大的
function bestThumbnail(list, apiBase) {
  if (!Array.isArray(list) || !list.length) return ''
  const sorted = [...list].sort((a, b) => Number(b?.width || 0) - Number(a?.width || 0))
  return absolute(sorted[0]?.url, apiBase)
}

export function normalizeAudioFormat(format, apiBase) {
  const url = absolute(format?.url, apiBase)
  if (!url) return null
  const mimeType = String(format?.type || '')
  const container = String(format?.container || '').toLowerCase()
  const isWebm = /webm/i.test(mimeType) || container === 'webm'
  const bitrate = Math.round(Number(format?.bitrate) || 0) // Invidious 给的是 bps
  return {
    url,
    container: isWebm ? 'webm' : 'mp4',
    codec: String(format?.encoding || (isWebm ? 'opus' : 'aac')),
    bitrate,
    lossless: false,
    quality: bitrate ? `${Math.round(bitrate / 1000)} kbps` : String(format?.audioQuality || '')
  }
}

export function normalizeSearchItem(item, apiBase) {
  const id = String(item?.videoId || '').trim()
  if (!id) return null
  return {
    id,
    name: String(item?.title || '').trim() || id,
    artists: [String(item?.author || '').trim()].filter(Boolean),
    album: '',
    duration: Math.max(Math.round(Number(item?.lengthSeconds) || 0), 0),
    pic: bestThumbnail(item?.videoThumbnails, apiBase),
    externalUri: `https://www.youtube.com/watch?v=${id}`,
    preview: false
  }
}

export async function fetchSearch(api, { wd, limit = 20 } = {}) {
  const url = `${api.replace(/\/+$/, '')}/api/v1/search?q=${encodeURIComponent(wd)}&type=video`
  const data = await getJson(url, { timeout: 10000 })
  const items = Array.isArray(data) ? data : []
  const out = []
  for (const item of items) {
    // 搜索结果里会混进 playlist / channel，只要 video
    if (item?.type && item.type !== 'video') continue
    const track = normalizeSearchItem(item, api)
    if (track) out.push(track)
    if (out.length >= limit) break
  }
  return out
}

export async function fetchStreams(api, { id } = {}) {
  if (!id) throw new Error('缺少曲目 id')
  const url = `${api.replace(/\/+$/, '')}/api/v1/videos/${encodeURIComponent(id)}?local=true`
  const data = await getJson(url, { timeout: 12000 })
  const formats = Array.isArray(data?.adaptiveFormats) ? data.adaptiveFormats : []
  const streams = formats
    .filter((format) => /^audio\//i.test(String(format?.type || '')))
    .map((format) => normalizeAudioFormat(format, api))
    .filter(Boolean)
    .sort((a, b) => b.bitrate - a.bitrate)
  if (!streams.length) {
    throw new Error('该实例没有返回音频流（实例可能被 YouTube 限流，换一个 Invidious 实例试试）')
  }
  return {
    title: String(data?.title || '').trim(),
    duration: Math.round(Number(data?.lengthSeconds) || 0),
    pic: bestThumbnail(data?.videoThumbnails, api),
    streams
  }
}

export async function check(api) {
  const data = await getJson(`${api.replace(/\/+$/, '')}/api/v1/stats`, { timeout: 8000 })
  if (!data || typeof data !== 'object') throw new Error('实例没有返回统计信息')
  const version = String(data.version || '').trim()
  return version ? `Invidious ${version}` : 'Invidious'
}
