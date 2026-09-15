// 多源同片「自动选最快线路」：
//  搜索所有可用源 → 找到同名影片 → 取首个剧集地址 → 实测延迟 → 按「可用优先、延迟升序」排序
import { getSources, sourcesWithHealth, spreadByGroup, activeSources, mapLimit } from './sources.js'
import { fetchList, fetchDetail } from './maccms.js'
import { probeMediaUrl } from './hls.js'

const CACHE_TTL = 10 * 60 * 1000
const cache = new Map()

function norm(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\-_:：·・,，.。!！?？()（）[\]【】"“”'’]/g, '')
}

function titleMatch(a, b) {
  const na = norm(a)
  const nb = norm(b)
  if (!na || !nb) return false
  return na.includes(nb) || nb.includes(na)
}

export async function findBestLines({ wd, year = '', limit = 8, probe = true, maxSources = 12 }) {
  const key = `${wd}|${year}|${limit}|${probe}|${maxSources}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data

  const all = await getSources()
  const ranked = activeSources(sourcesWithHealth(all)).filter((s) => s.status !== 'fail')
  // 按分组轮流取源，避免一个多仓订阅把选路名额占满
  const targets = spreadByGroup(ranked.length ? ranked : activeSources(all), maxSources)

  // 1) 并发搜索，收集同名结果
  const found = []
  await mapLimit(targets, 6, async (source) => {
    try {
      const data = await fetchList(source.api, { wd, page: 1 })
      for (const video of data.list) {
        if (!titleMatch(video.name, wd)) continue
        if (year && video.year && String(video.year) !== String(year)) continue
        found.push({ source, video })
      }
    } catch {
      // 忽略单个源失败
    }
  })

  // 去重（同一源同一 id 只留一次）
  const seen = new Set()
  const unique = []
  for (const item of found) {
    const k = `${item.source.id}|${item.video.id}`
    if (seen.has(k)) continue
    seen.add(k)
    unique.push(item)
  }

  // 2) 并发取详情 + 探测首集延迟
  const probed = await mapLimit(unique.slice(0, limit * 4), 5, async (item) => {
    try {
      const detail = await fetchDetail(item.source.api, item.video.id)
      const episode = (detail?.playUrl || [])[0]?.[0]
      if (!episode) return null
      const result = probe ? await probeMediaUrl(episode.url, { timeout: 6000 }) : { ok: true, latency: 0 }
      return {
        site: item.source.id,
        siteName: item.source.name,
        group: item.source.group,
        id: item.video.id,
        name: detail.name,
        pic: detail.pic,
        year: detail.year,
        type: detail.type,
        remarks: detail.remarks,
        episodeName: episode.name,
        episodeUrl: episode.url,
        ok: Boolean(result.ok),
        latency: result.latency || 0,
        error: result.error || ''
      }
    } catch {
      return null
    }
  })

  let list = probed.filter(Boolean)
  list.sort((a, b) => Number(b.ok) - Number(a.ok) || a.latency - b.latency)
  list = list.slice(0, limit)

  const data = { wd, year, total: list.length, list }
  cache.set(key, { at: Date.now(), data })
  if (cache.size > 300) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100)
    for (const [k] of oldest) cache.delete(k)
  }
  return data
}
