// JioSaavn 适配器 —— Spotube 内置过的另一条音源（可直连，不需要代理）
//
//   GET {base}?__call=search.getResults&q=<关键词>&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=<条数>&p=1
//
// 返回里的 more_info.encrypted_media_url 是 DES-ECB/PKCS#5 加密的播放地址，
// 用它换取 aac.saavncdn.com 上的明文地址（见 des.js）。密钥是各家客户端通用的固定值。
import { getJson } from './http.js'
import { desDecryptBase64 } from './des.js'

export const kind = 'jiosaavn'
export const capabilities = { search: true, stream: true, preview: false, slow: false }

const DES_KEY = '38346591'
// 同一份音频在 CDN 上有几档码率，改文件名后缀即可（_96 → _320）
const BITRATES = [320, 160, 96, 48]
// 搜索接口能一次给这么多；超过就没必要了
const MAX_LIMIT = 40

// 播放时要拿 encrypted_media_url 才能换到真实地址。搜索响应里其实已经带了，
// 但不该把它当作接口契约暴露给前端（前端只该看到普通曲目字段），
// 所以按 id 在服务端存一份，播放时优先命中缓存、没命中再查一次详情。
const TRACK_TTL = 60 * 60 * 1000
const MAX_TRACKS = 500
const trackCache = new Map()

function cacheTrack(track) {
  if (!track?.id) return track
  trackCache.set(track.id, { at: Date.now(), track })
  if (trackCache.size > MAX_TRACKS) {
    const oldest = [...trackCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100)
    for (const [key] of oldest) trackCache.delete(key)
  }
  return track
}

function cachedTrack(id) {
  const hit = trackCache.get(id)
  if (!hit) return null
  if (Date.now() - hit.at > TRACK_TTL) {
    trackCache.delete(id)
    return null
  }
  return hit.track
}

function apiUrl(api, call, params) {
  const url = new URL(api)
  url.searchParams.set('__call', call)
  url.searchParams.set('_format', 'json')
  url.searchParams.set('_marker', '0')
  url.searchParams.set('api_version', '4')
  url.searchParams.set('ctx', 'web6dot0')
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

// 接口在 _format=json 下偶尔回的是「下标对象」而不是数组
function toArray(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return Object.values(value)
  return []
}

// ctx=web6dot0 把曲目细节放在 more_info 下，ctx=wap6dot0 则平铺在条目顶层。
// 两种都认，免得官方哪天换回来就整条音源失效。
function detailsOf(item) {
  const more = item?.more_info
  return more && typeof more === 'object' ? more : item || {}
}

function artistsOf(item, more) {
  const primary = toArray(more?.artistMap?.primary_artists)
    .map((artist) => String(artist?.name || '').trim())
    .filter(Boolean)
  if (primary.length) return [...new Set(primary)]
  // 平铺形态给的是逗号串
  const flat = String(item?.primary_artists || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (flat.length) return [...new Set(flat)]
  const music = String(more?.music || '').trim()
  return music ? [music] : []
}

function bigImage(url) {
  return String(url || '').replace(/150x150/, '500x500').replace(/50x50/, '500x500')
}

export function decryptMediaUrl(encrypted) {
  const url = desDecryptBase64(encrypted, DES_KEY).trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('JioSaavn 播放地址解密失败')
  return url
}

// CDN 上同一份音频有好几档码率，只改文件名后缀（_96 → _320）就能拿到，不必再请求一次
export function qualityVariants(mediaUrl, has320) {
  const url = String(mediaUrl || '')
  return BITRATES.filter((kbps) => kbps < 320 || has320).map((kbps) => ({
    url: url.replace(/_\d+\.mp4(\?|$)/, `_${kbps}.mp4$1`),
    container: 'mp4',
    codec: 'aac',
    bitrate: kbps * 1000,
    lossless: false,
    quality: `${kbps} kbps`
  }))
}

export function normalizeSearchItem(item) {
  const id = String(item?.id || '').trim()
  if (!id) return null
  const more = detailsOf(item)
  return {
    id,
    name: String(item?.title || item?.song || '').trim() || id,
    artists: artistsOf(item, more),
    album: String(more?.album || '').trim(),
    duration: Math.max(Math.round(Number(more?.duration) || 0), 0),
    pic: bigImage(item?.image),
    externalUri: String(item?.perma_url || '').trim(),
    preview: false,
    // 解密要用的原始字段，随曲目一起带上，避免播放时再搜一次
    encryptedMediaUrl: String(more?.encrypted_media_url || ''),
    has320: String(more?.['320kbps'] || '') === 'true'
  }
}

export async function fetchSearch(api, { wd, limit = 20 } = {}) {
  const size = Math.min(Math.max(limit, 1), MAX_LIMIT)
  const url = apiUrl(api, 'search.getResults', { q: wd, n: size, p: 1 })
  const data = await getJson(url, { timeout: 10000 })
  const items = toArray(data?.results)
  const out = []
  for (const item of items) {
    // 搜索会混进 album / playlist / artist 条目，只要 song
    if (item?.type && item.type !== 'song') continue
    const track = normalizeSearchItem(item)
    if (track) out.push(cacheTrack(track))
  }
  return out
}

export async function fetchStreams(api, { id, track } = {}) {
  if (!id) throw new Error('缺少曲目 id')
  const known = track?.encryptedMediaUrl ? track : cachedTrack(id)
  let encrypted = String(known?.encryptedMediaUrl || '').trim()
  let has320 = Boolean(known?.has320)
  let title = known?.name || ''
  let duration = known?.duration || 0
  let pic = known?.pic || ''
  if (!encrypted) {
    // 直接按 id 播放（收藏/历史恢复）时补一次详情查询
    const url = apiUrl(api, 'song.getDetails', { pids: id })
    const data = await getJson(url, { timeout: 10000 })
    const item = toArray(data?.songs)[0]
    if (!item) throw new Error('曲目不存在或已下架')
    const normalized = normalizeSearchItem(item)
    encrypted = normalized?.encryptedMediaUrl || ''
    has320 = Boolean(normalized?.has320)
    title = normalized?.name || title
    duration = normalized?.duration || duration
    pic = normalized?.pic || pic
  }
  if (!encrypted) throw new Error('该曲目没有可用的播放地址')
  return { title, duration, pic, streams: qualityVariants(decryptMediaUrl(encrypted), has320) }
}

export async function check(api) {
  const url = apiUrl(api, 'search.getResults', { q: 'test', n: 1, p: 1 })
  const data = await getJson(url, { timeout: 8000 })
  if (typeof data?.total === 'undefined' && !Array.isArray(data?.results)) {
    throw new Error('接口返回格式异常')
  }
  return 'JioSaavn API v4'
}
