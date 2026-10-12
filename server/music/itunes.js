// Apple 试听源 —— 兜底音源（不是 Spotube 的源，是为了「开箱即用」补的）
//
// YouTube 系音源（Piped / Invidious）在国内网络必须给服务端配 VOD_HTTP_PROXY 才能用；
// 没有代理时总得有一条能出声的通路，所以内置这条：iTunes Search API 的 30 秒试听片段，
// 直连可用、无需密钥。它只提供片段（preview: true），曲目信息来自 Apple Music 目录。
//
//   GET {base}/search?term=<关键词>&entity=song&limit=<条数>
import { getJson } from './http.js'

export const kind = 'itunes'
export const capabilities = { search: true, stream: true, preview: true }

const MAX_LIMIT = 50

function bigArtwork(url) {
  return String(url || '').replace(/\/100x100bb\.(jpg|png)/, '/600x600bb.$1')
}

export function normalizeSearchItem(item) {
  const id = String(item?.trackId || '').trim()
  if (!id) return null
  const preview = String(item?.previewUrl || '').trim()
  if (!/^https?:\/\//i.test(preview)) return null
  return {
    id,
    name: String(item?.trackName || '').trim() || id,
    artists: [String(item?.artistName || '').trim()].filter(Boolean),
    album: String(item?.collectionName || '').trim(),
    duration: Math.max(Math.round(Number(item?.trackTimeMillis || 0) / 1000), 0),
    pic: bigArtwork(item?.artworkUrl100),
    externalUri: String(item?.trackViewUrl || '').trim(),
    preview: true
  }
}

export async function fetchSearch(api, { wd, limit = 20 } = {}) {
  const size = Math.min(Math.max(limit, 1), MAX_LIMIT)
  const url = `${api.replace(/\/+$/, '')}/search?term=${encodeURIComponent(wd)}&entity=song&limit=${size}`
  const data = await getJson(url, { timeout: 9000, headers: { Accept: 'application/json' } })
  const items = Array.isArray(data?.results) ? data.results : []
  const out = []
  for (const item of items) {
    const track = normalizeSearchItem(item)
    if (track) out.push(track)
  }
  return out
}

export async function fetchStreams(api, { id } = {}) {
  if (!id) throw new Error('缺少曲目 id')
  const url = `${api.replace(/\/+$/, '')}/lookup?id=${encodeURIComponent(id)}&entity=song`
  const data = await getJson(url, { timeout: 9000, headers: { Accept: 'application/json' } })
  const item = Array.isArray(data?.results) ? data.results[0] : null
  const track = item ? normalizeSearchItem(item) : null
  if (!item || !track) throw new Error('曲目不存在或没有试听片段')
  return {
    title: track.name,
    duration: track.duration,
    pic: track.pic,
    preview: true,
    streams: [
      {
        url: String(item.previewUrl),
        container: 'mp4',
        codec: 'aac',
        bitrate: 256000,
        lossless: false,
        quality: '试听 256 kbps'
      }
    ]
  }
}

export async function check(api) {
  const url = `${api.replace(/\/+$/, '')}/search?term=test&entity=song&limit=1`
  const data = await getJson(url, { timeout: 8000, headers: { Accept: 'application/json' } })
  if (typeof data?.resultCount !== 'number') throw new Error('接口返回格式异常')
  return 'iTunes Search API'
}
