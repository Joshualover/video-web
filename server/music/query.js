// 音乐源查询统一入口：按 source.kind 分派到具体适配器
//  对齐 Spotube 的音频源插件契约：
//    matches(track) -> 若干候选匹配（本项目的 GET /api/music/match）
//    streams(match) -> 可播放的流列表（GET /api/music/stream）
//  差别是这里不依赖 Spotify 曲目元数据 —— 直接用关键词搜音源本身。
import { adapterFor, markHealth } from './sources.js'
import { sleep } from './http.js'

// 曲目里的 encryptedMediaUrl / has320 这类字段是适配器的内部信息，不下发给前端
export function publicTrack(track, source) {
  return {
    key: `${source.id}:${track.id}`,
    id: String(track.id),
    source: source.id,
    sourceName: source.name,
    kind: source.kind,
    name: track.name || '',
    artists: Array.isArray(track.artists) ? track.artists : [],
    album: track.album || '',
    duration: Number(track.duration) || 0,
    pic: track.pic || '',
    externalUri: track.externalUri || '',
    preview: Boolean(track.preview)
  }
}

// 搜索用不到解密地址，可以安全地精简后再转发
function slimTrack(track) {
  return {
    id: track.id,
    name: track.name,
    artists: track.artists,
    album: track.album,
    duration: track.duration,
    pic: track.pic,
    externalUri: track.externalUri,
    preview: track.preview
  }
}

export async function searchSource(source, wd, limit) {
  const adapter = adapterFor(source.kind)
  if (!adapter || !adapter.capabilities.search) throw new Error('该音源不支持搜索')
  const list = await adapter.fetchSearch(source.api, { wd, limit })
  markHealth(source.id, true, { latency: 0 })
  return list
}

export async function resolveStreams(source, id, track) {
  const adapter = adapterFor(source.kind)
  if (!adapter) throw new Error('未知音源类型')
  return adapter.fetchStreams(source.api, { id, track })
}

// 并发搜多个源，按源轮流交错，避免某一条通路把结果名单占满。
//
// 两个截止时间：国内没配代理时 Piped/Invidious 大多是「连不上、等超时」，
// 如果一定等全部源结束，搜索框要转 9 秒。所以只要**已经有一个源出了结果**，
// 到软截止就直接返回，剩下的源继续在后台跑完（顺带把健康状态更新掉），
// 用户下次搜索就会自动绕开这些慢源。
export async function searchAll(
  sources,
  { wd, limit = 40, perSource = 10, deadline = 9000, softDeadline = 3500 } = {}
) {
  const outcomes = new Array(sources.length).fill(null)
  let finished = false
  const allDone = Promise.all(
    sources.map((source, index) =>
      searchSource(source, wd, perSource).then(
        (list) => {
          outcomes[index] = { ok: true, source, list }
        },
        (err) => {
          markHealth(source.id, false, { error: err?.message || '搜索失败' })
          outcomes[index] = { ok: false, source, error: err?.message || '搜索失败' }
        }
      )
    )
  ).then(() => {
    finished = true
  })

  const soft = Math.min(Math.max(softDeadline, 0), deadline)
  await Promise.race([allDone, sleep(soft)])
  // 一个结果都没拿到就再多等一会儿 —— 空手而归还快，对用户没有价值
  const hasHits = () => outcomes.some((item) => item?.ok && item.list.length > 0)
  if (!finished && !hasHits()) await Promise.race([allDone, sleep(deadline - soft)])

  const errors = []
  const buckets = []
  for (const item of outcomes) {
    if (!item) continue // 仍在后台跑的源这次不参与
    if (item.ok) buckets.push({ source: item.source, list: item.list })
    else errors.push({ source: item.source.id, sourceName: item.source.name, error: item.error })
  }
  const results = []
  const seen = new Set()
  let index = 0
  while (results.length < limit && buckets.some((bucket) => bucket.list.length > index)) {
    for (const bucket of buckets) {
      if (results.length >= limit) break
      const track = bucket.list[index]
      if (!track) continue
      const publicItem = publicTrack(track, bucket.source)
      if (seen.has(publicItem.key)) continue
      seen.add(publicItem.key)
      results.push(publicItem)
    }
    index += 1
  }
  return { results, errors }
}

// 关键词归一化：去括号内容、去「官方/MV/歌词」这类噪声词、去标点
function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[（(\[【][^）)】\]]*[）)】\]]/g, ' ')
    .replace(/official\s*(music\s*)?video|lyric\s*video|lyrics|audio|mv|hd|4k|官方|高清|完整版|无损/gi, ' ')
    .replace(/[\s\-_:：·・,，.。!！?？'"“”‘’&+/\\|]/g, '')
}

// 给候选曲目打分：曲名是硬条件，艺术家与时长用来在多个同名结果里挑更靠谱的那个
export function scoreMatch(track, { title, artists = [], duration = 0 }) {
  const want = normalizeText(title)
  const got = normalizeText(track?.name)
  if (!want || !got) return 0
  let score = 0
  if (want === got) score += 5
  else if (got.includes(want) || want.includes(got)) score += 3
  else return 0

  const wanted = (Array.isArray(artists) ? artists : []).map(normalizeText).filter(Boolean)
  const gotArtists = (track?.artists || []).map(normalizeText)
  if (wanted.length && wanted.some((name) => gotArtists.some((other) => other.includes(name) || name.includes(other)))) {
    score += 2
  }
  const seconds = Number(duration) || 0
  if (seconds > 0 && Number(track?.duration) > 0 && Math.abs(Number(track.duration) - seconds) <= 10) {
    score += 1
  }
  return score
}

// 依次到各音源里找「最像」的那一首并取流 —— 对应 Spotube 的 matches() + streams()
export async function matchTrack({ title, artists = [], duration = 0, sources, deadline = 9000 }) {
  const tried = []
  for (const source of sources) {
    try {
      const candidates = await searchSource(source, [title, artists[0]].filter(Boolean).join(' '), 10)
      const ranked = candidates
        .map((track) => ({ track, score: scoreMatch(track, { title, artists, duration }) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
      if (!ranked.length) {
        tried.push({ source: source.id, sourceName: source.name, error: '没有找到匹配的曲目' })
        continue
      }
      const best = ranked[0]
      const data = await resolveStreams(source, best.track.id, best.track)
      markHealth(source.id, true, { latency: 0 })
      return {
        matched: true,
        source: source.id,
        sourceName: source.name,
        kind: source.kind,
        score: best.score,
        match: publicTrack(best.track, source),
        streams: data.streams,
        tried
      }
    } catch (err) {
      markHealth(source.id, false, { error: err?.message || '匹配失败' })
      tried.push({ source: source.id, sourceName: source.name, error: err?.message || '匹配失败' })
    }
  }
  return { matched: false, tried }
}

export { slimTrack }
