// Piped 适配器 —— Spotube 默认音源（YouTube 音频）在 Web 端的等价实现
//
// Spotube 桌面端用 Dart 的 YouTubeEngine（youtube_explode / newpipe / yt-dlp）直连 YouTube；
// 浏览器 + Node 侧没法跑那套内核，等价做法是走 Piped 的公开 API：
//   GET {base}/search?q=<关键词>&filter=music_songs   搜索
//   GET {base}/streams/<videoId>?local=true           音频流清单
// 加 local=true 让 Piped 实例把 googlevideo 的地址代理一遍 —— 国内直连 googlevideo 是不通的，
// 而实例地址本身（配合 VOD_HTTP_PROXY）通常可达。
import { getJson } from './http.js'

export const kind = 'piped'
export const capabilities = { search: true, stream: true, preview: false, slow: false }

// search 的 filter 用 music_songs：只要「音乐」类结果，跟 Spotube 的曲目搜索对齐
const SEARCH_FILTER = 'music_songs'

function videoIdOf(item) {
  const direct = String(item?.videoId || '').trim()
  if (direct) return direct
  const raw = String(item?.url || '')
  const m = raw.match(/[?&]v=([\w-]{6,})/) || raw.match(/\/watch\/([\w-]{6,})/)
  return m ? m[1] : ''
}

function absolute(url, apiBase) {
  const raw = String(url || '').trim()
  if (!raw) return ''
  try {
    return new URL(raw, apiBase).toString()
  } catch {
    return ''
  }
}

// Piped 对同一段音频会给多种容器/码率，统一成流对象
export function normalizeAudioStream(stream, apiBase) {
  const url = absolute(stream?.url, apiBase)
  if (!url) return null
  const mimeType = String(stream?.mimeType || '')
  const format = String(stream?.format || '').toUpperCase()
  const isWebm = /webm/i.test(mimeType) || format === 'WEBM' || format === 'OPUS'
  const bitrate = Math.round(Number(stream?.bitrate) || 0) * 1000 // Piped 给的是 kbps
  return {
    url,
    container: isWebm ? 'webm' : 'mp4',
    codec: String(stream?.codec || (isWebm ? 'opus' : 'aac')),
    bitrate,
    lossless: false,
    quality: String(stream?.quality || (bitrate ? `${Math.round(bitrate / 1000)} kbps` : ''))
  }
}

export function normalizeSearchItem(item, apiBase) {
  const id = videoIdOf(item)
  if (!id) return null
  const duration = Math.max(Math.round(Number(item?.duration) || 0), 0)
  return {
    id,
    name: String(item?.title || '').trim() || id,
    artists: [String(item?.uploaderName || item?.uploader || '').trim()].filter(Boolean),
    album: '',
    duration,
    pic: absolute(item?.thumbnail, apiBase),
    externalUri: `https://www.youtube.com/watch?v=${id}`,
    preview: false
  }
}

export async function fetchSearch(api, { wd, limit = 20 } = {}) {
  const url = `${api.replace(/\/+$/, '')}/search?q=${encodeURIComponent(wd)}&filter=${SEARCH_FILTER}`
  const data = await getJson(url, { timeout: 10000 })
  const items = Array.isArray(data?.items) ? data.items : []
  const out = []
  for (const item of items) {
    const track = normalizeSearchItem(item, api)
    if (track) out.push(track)
    if (out.length >= limit) break
  }
  return out
}

export async function fetchStreams(api, { id } = {}) {
  if (!id) throw new Error('缺少曲目 id')
  const url = `${api.replace(/\/+$/, '')}/streams/${encodeURIComponent(id)}?local=true`
  const data = await getJson(url, { timeout: 12000 })
  const audio = Array.isArray(data?.audioStreams) ? data.audioStreams : []
  const streams = audio
    .map((stream) => normalizeAudioStream(stream, api))
    .filter(Boolean)
    .sort((a, b) => b.bitrate - a.bitrate)
  if (!streams.length) {
    // 实例被 YouTube 限流时 audioStreams 会是空数组，这里给出能对症的提示
    throw new Error('该实例没有返回音频流（实例可能被 YouTube 限流，换一个 Piped 实例试试）')
  }
  return {
    title: String(data?.title || '').trim(),
    duration: Math.round(Number(data?.duration) || 0),
    pic: absolute(data?.thumbnailUrl, api),
    streams
  }
}

export async function check(api) {
  const data = await getJson(`${api.replace(/\/+$/, '')}/healthcheck`, { timeout: 8000 })
  if (!data || typeof data !== 'object') throw new Error('实例没有返回健康信息')
  const version = String(data.version || '').trim()
  return version ? `Piped ${version}` : 'Piped'
}
