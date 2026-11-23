// GD音乐台音源 —— 对齐 AlgerMusicPlayer 的音源模型
//
// 参考项目（algerkong/AlgerMusicPlayer）把「曲目元数据」和「音频来源」彻底拆开，
// 由一组 Provider 注册成一条解析链：网易云官方 → GD音乐台 → unblock 平台。
// 其中 GD音乐台是免鉴权的聚合解析口，背后再聚合 netease / joox / tidal 等平台，
// 是国内网络下最省心的一条通路（不需要任何密钥，也不需要登录 cookie）。
//
// 本项目只移植「取流」这一层，接口是 MusicApi 的 api.php：
//
//   GET {base}/api.php?types=search&source=<平台>&name=<关键词>&count=<1-99>&pages=<页>
//   GET {base}/api.php?types=url&source=<平台>&id=<曲目 id 或 url_id>&br=<128|320|740|999>
//   GET {base}/api.php?types=lyric&source=<平台>&id=<曲目 id>
//   GET {base}/api.php?types=pic&source=<平台>&id=<pic_id>&size=<300>
//
// 实测要点（2026-11 验证）：
//   - br=128/320 返回 mp3；br=740/999 返回 flac（无损，约 21MB/首），实际码率见返回的 br 字段
//   - 取不到流时接口仍回 200，但 url 为空串、br=-1 —— 必须显式判空，不能只看状态码
//   - joox 平台的 id 是 base64 风格的 url_id（含 +/= ），必须整串 URL 编码后传回
//   - count 上限 99，超过会回 422（FastAPI 校验）
import { getJson, sleep } from './http.js'

export const kind = 'gdmusic'
export const capabilities = { search: true, stream: true, lyric: true, slow: false }

const MAX_COUNT = 99

// 音质档位：与歌曲列表上的「音质」选择器一一对应。
// AlgerMusicPlayer 用 higher/lossless 这类语义值，这里保留语义值，
// 在适配器内部映射成 api.php 认识的 br 数字。
export const QUALITY_LEVELS = [
  { value: '128', label: '标准 128 kbps', br: 128 },
  { value: '320', label: '较高 320 kbps', br: 320 },
  { value: '740', label: '无损 FLAC', br: 740 }
]

const DEFAULT_QUALITY = '320'

export function normalizeQuality(value) {
  const raw = String(value || '').trim().toLowerCase()
  const hit = QUALITY_LEVELS.find((item) => item.value === raw)
  return hit ? hit.value : DEFAULT_QUALITY
}

export function qualityLabel(value) {
  const level = QUALITY_LEVELS.find((item) => item.value === normalizeQuality(value))
  return level ? level.label : ''
}

// 语义音质 → api.php 的 br 数字
export function qualityToBr(value) {
  const level = QUALITY_LEVELS.find((item) => item.value === normalizeQuality(value))
  return level ? level.br : 320
}

// 实际文件码率 → 展示文案（接口回的 br 是真实码率，无损时是 700~1500 那种值）
export function describeBitrate(br, format) {
  const value = Number(br) || 0
  const lossless = String(format || '').toLowerCase() === 'flac' || value > 500
  if (lossless) return `无损 FLAC${value > 0 ? ` · ${value} kbps` : ''}`
  if (value > 0) return `${value} kbps`
  return ''
}

function artistsOf(raw) {
  const value = Array.isArray(raw) ? raw : raw ? [raw] : []
  return value
    .map((item) => (typeof item === 'string' ? item : item?.name || ''))
    .map((item) => String(item || '').trim())
    .filter(Boolean)
}

// 接口给的 pic 有时是 pic_id 而不是图片地址，前端统一走封面代理，这里只保证是 http(s)
function normalizePic(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  return /^https?:\/\//i.test(value) ? value : ''
}

export function normalizeSearchItem(item, source) {
  if (!item) return null
  const id = String(item.url_id || item.id || '').trim()
  if (!id) return null
  const name = String(item.name || '').trim()
  if (!name) return null
  // 搜索结果里 pic 通常只有 pic_id（数字串），真正地址要再调 types=pic 换
  const rawPic = String(item.pic || '').trim()
  const picId = String(item.pic_id || '').trim()
  return {
    id,
    name,
    artists: artistsOf(item.artist),
    album: String(item.album || '').trim(),
    // 搜索接口不返回时长，取到流时再补
    duration: 0,
    pic: normalizePic(rawPic),
    picId: picId || (/^\d+$/.test(rawPic) ? rawPic : ''),
    externalUri: '',
    preview: false,
    // 记住这条结果来自哪个平台：取流/取词要用同一个 source
    platform: String(item.source || source || '').trim()
  }
}

function baseOf(api) {
  return String(api || '').replace(/\/+$/, '')
}

function buildUrl(api, params) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    query.set(key, String(value))
  }
  return `${baseOf(api)}/api.php?${query.toString()}`
}

// 上游偶发 503（实测同一首歌不同音质会随机 503，几秒后重试即可成功）。
// 对齐 AlgerMusicPlayer resolver 的「单步预算 + 失败降级」思路：
// 一次失败不立刻判死，先短暂退避重试一次；仍失败就退到相邻音质再试一次。
const RETRY_DELAY_MS = 600
const STREAM_ATTEMPTS = 2

function isTransientError(err) {
  const message = String(err?.message || '')
  return /\b(429|500|502|503|504)\b/.test(message) || /ECONNRESET|ETIMEDOUT|socket hang up/i.test(message)
}

async function fetchJsonWithRetry(url, { timeout, attempts = STREAM_ATTEMPTS } = {}) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await getJson(url, { timeout })
    } catch (err) {
      lastError = err
      if (!isTransientError(err) || attempt === attempts - 1) break
      await sleep(RETRY_DELAY_MS)
    }
  }
  throw lastError
}

// 音质降级顺序：目标档失败时退到更低的档位，宁可少一点音质也别直接没声
const QUALITY_FALLBACK = {
  '740': ['740', '320', '128'],
  '320': ['320', '128'],
  '128': ['128']
}

function fallbackChain(quality) {
  const key = normalizeQuality(quality)
  return QUALITY_FALLBACK[key] || [key]
}

// 搜索：一次只打一个平台。多平台的互补交给上层「按分组轮流取源」，
// 这样单个平台的失败/风控不会拖垮整条搜索。
export async function fetchSearch(api, { wd, limit = 20, platform = '', page = 1 } = {}) {
  const count = Math.min(Math.max(Number(limit) || 20, 1), MAX_COUNT)
  const source = String(platform || '').trim()
  const url = buildUrl(api, {
    types: 'search',
    ...(source ? { source } : {}),
    name: wd,
    count,
    pages: Math.min(Math.max(Number(page) || 1, 1), 20)
  })
  const data = await fetchJsonWithRetry(url, { timeout: 12000 })
  if (!Array.isArray(data)) throw new Error('音源返回格式异常')
  const out = []
  for (const item of data) {
    const track = normalizeSearchItem(item, source)
    if (track) out.push(track)
  }
  // 搜索阶段不补封面：上游搜索本身就要 2-3 秒，再等封面会把这次搜索拖过
  // 聚合搜索的软截止（3.5s）而被整条丢掉。封面交给两处补：
  //   1) 后台预热缓存（不阻塞本次响应），下次搜同一个词直接命中
  //   2) 播放时的取流响应（那里本来就有一次请求，顺手带回封面）
  void fillCovers(api, out).catch(() => {})
  return out
}

// 后台预热封面时的并发：**故意调低**。
// 搜索已经返回，这里只是填空；并发太高会和用户下一次搜索抢同一条出网代理/连接池，
// 实测 6 并发会把后续搜索从 4s 拖到 10s+，所以压到 2。
const COVER_CONCURRENCY = 2
const COVER_SIZE = 300
// 后台预热封面时，单个批次最多跑这么久（纯粹是让后台任务别无限期挂着；
// 它不参与搜索响应 —— 搜索早已返回，这里只是继续填空）
const COVER_BUDGET_MS = 8000

// 封面缓存：pic_id -> 图片地址（含失败标记，避免反复重试坏 id）
const picCache = new Map()
const PIC_TTL_OK = 60 * 60 * 1000
const PIC_TTL_FAIL = 5 * 60 * 1000
const PIC_CACHE_LIMIT = 2000

function picCacheGet(key) {
  const hit = picCache.get(key)
  if (!hit) return undefined
  const ttl = hit.url ? PIC_TTL_OK : PIC_TTL_FAIL
  if (Date.now() - hit.at > ttl) {
    picCache.delete(key)
    return undefined
  }
  return hit.url
}

function picCacheSet(key, url) {
  if (picCache.size >= PIC_CACHE_LIMIT) {
    // 简单淘汰：删掉最早插入的一批，别让缓存无限长
    let drop = Math.ceil(PIC_CACHE_LIMIT / 10)
    for (const oldKey of picCache.keys()) {
      picCache.delete(oldKey)
      if (--drop <= 0) break
    }
  }
  picCache.set(key, { url: url || '', at: Date.now() })
}

// 已补过封面的搜索结果：第二次搜同一个词时直接带上封面，不用再等
async function fillCovers(api, tracks, { budgetMs = COVER_BUDGET_MS } = {}) {
  const pending = []
  for (const track of tracks) {
    if (track.pic || !track.picId) continue
    const key = `${track.platform}:${track.picId}`
    const cached = picCacheGet(key)
    if (cached) track.pic = cached
    else pending.push({ track, key })
  }
  if (!pending.length) return

  let cursor = 0
  const workers = Array.from({ length: Math.min(COVER_CONCURRENCY, pending.length) }, async () => {
    while (cursor < pending.length) {
      const { track, key } = pending[cursor]
      cursor += 1
      try {
        const url = await fetchPic(api, {
          id: track.picId,
          size: COVER_SIZE,
          platform: track.platform
        })
        picCacheSet(key, url)
        if (url) track.pic = url
      } catch {
        picCacheSet(key, '')
      }
    }
  })
  // 时间到就放行：没补到的封面保持空，前端显示首字母占位。
  // 后台继续跑完并把结果写进缓存，下次搜索 / 播放时就能直接带上。
  const all = Promise.all(workers)
  await Promise.race([all, sleep(budgetMs)])
  void all.catch(() => {})
}

// 时长：搜索接口不返回，只有 types=url 那次取流里带 size/br。
// 不在搜索阶段为每首歌多打一次请求（50 条 = 50 个额外请求，会被风控），
// 而是播放时从解码出的 audio.duration 回填到队列项上（见前端 fillDuration）。
export function durationFromSizeBytes(size, bitrate) {
  const bytes = Number(size) || 0
  const kbps = Number(bitrate) || 0
  if (bytes <= 0 || kbps <= 0) return 0
  // bytes * 8 / (kbps * 1000) = 秒
  return Math.round((bytes * 8) / (kbps * 1000))
}

// 从 track 里推断平台：曲目 id 以 source.id 形式存过，也支持适配器从搜索结果带回的 platform
function platformOf(track, fallback) {
  return String(track?.platform || fallback || 'netease').trim()
}

// 搜索结果的完整信息要能被「取流」复用：取流接口只拿得到 id + platform，
// 曲名/封面/时长得由前端回传，或由这里从 url 接口补。缺失时不要用空串覆盖调用方已有的值。
export async function fetchStreams(api, { id, track, quality } = {}) {
  const trackId = String(id || '').trim()
  if (!trackId) throw new Error('缺少曲目 id')
  const source = platformOf(track)

  // 按「目标音质 → 降级档位」逐档尝试。上游偶发 503 时，
  // 重试一次通常就能成功；仍不成功就退到更低的音质，不直接让播放失败。
  let data = null
  const chain = fallbackChain(quality)
  for (let index = 0; index < chain.length; index += 1) {
    const br = qualityToBr(chain[index])
    const url = buildUrl(api, { types: 'url', source, id: trackId, br })
    try {
      const payload = await fetchJsonWithRetry(url, { timeout: 15000 })
      const playable = String(payload?.url || '').trim()
      // 取不到时接口仍回 200，只有 url 为空、br=-1 —— 换下一档
      if (/^https?:\/\//i.test(playable)) {
        data = payload
        break
      }
    } catch (err) {
      // 已经是最后一档才把错误抛出去，让上层去试别的音源
      if (index === chain.length - 1) throw err
    }
    // 降级之间稍微停顿，给上游一点喘息时间
    await sleep(RETRY_DELAY_MS)
  }
  if (!data) throw new Error('该音源没有给出可用地址')

  const br = qualityToBr(quality)
  const playable = String(data.url || '').trim()
  const actualBr = Number(data?.br) > 0 ? Number(data.br) : br
  const ext = (playable.split('?')[0].split('.').pop() || '').toLowerCase()
  const format = ext === 'flac' ? 'flac' : ext === 'm4a' ? 'm4a' : 'mp3'
  const lossless = format === 'flac'
  const size = Number(data?.size) || 0
  // 接口不给时长，但给了文件大小与码率：用它们估算，够把列表上的 0:00 填掉
  const duration = Number(track?.duration) || durationFromSizeBytes(size, actualBr)

  return {
    title: String(track?.name || '').trim(),
    duration,
    pic: normalizePic(track?.pic),
    // 曲目封面单独再取一次：搜索结果里的 pic 常常是 pic_id 而不是地址
    picId: String(track?.picId || '').trim(),
    preview: false,
    streams: [
      {
        url: playable,
        container: format,
        codec: lossless ? 'flac' : 'mp3',
        bitrate: actualBr * 1000,
        lossless,
        quality: describeBitrate(actualBr, format),
        size
      }
    ]
  }
}

// 歌词：接口回 { lyric, tlyric, from }，都是标准 LRC 文本
export async function fetchLyric(api, { id, track } = {}) {
  const trackId = String(id || '').trim()
  if (!trackId) return null
  const source = platformOf(track)
  const url = buildUrl(api, { types: 'lyric', source, id: trackId })
  const data = await fetchJsonWithRetry(url, { timeout: 12000 })
  const lyric = String(data?.lyric || '').trim()
  const tlyric = String(data?.tlyric || '').trim()
  if (!lyric && !tlyric) return null
  return { lyric, tlyric }
}

export async function fetchPic(api, { id, size = 300, platform = '' } = {}) {
  const picId = String(id || '').trim()
  if (!picId) return ''
  // pic_id 是各平台自己的坐标：不给 source 会落到默认平台、换出错图
  const source = String(platform || '').trim()
  const url = buildUrl(api, {
    types: 'pic',
    ...(source ? { source } : {}),
    id: picId,
    size
  })
  const data = await fetchJsonWithRetry(url, { timeout: 10000 })
  return normalizePic(data?.url)
}

export async function check(api) {
  const url = buildUrl(api, { types: 'search', source: 'netease', name: 'test', count: 1 })
  const data = await getJson(url, { timeout: 9000 })
  if (!Array.isArray(data)) throw new Error('接口返回格式异常')
  return 'GD 音乐台'
}
