// /api/music/* 路由（在 server/index.js 里以 assertProxyToken 挂到 /api/music）
import express from 'express'
import { tokenFromRequest } from '../proxy-core.js'
import { proxyStatus } from '../net.js'
import { handleImageProxy } from '../vod/image.js'
import { handleHlsProxy } from '../vod/hls.js'
import {
  activeSources,
  addSource,
  adapterFor,
  checkSource,
  checkSources,
  getSources,
  rankSources,
  removeSource,
  resolveSource,
  setSourceEnabled,
  sourcesWithHealth,
  spreadByGroup,
  addableKinds,
  slowKinds
} from './sources.js'
import { matchTrack, resolveStreams, searchAll } from './query.js'

const router = express.Router()

// 搜索要扇出到多个实例，默认只挑前几个：源太多会让一次搜索等最慢的那个
const SEARCH_SOURCES = Math.min(Math.max(Number(process.env.MUSIC_SEARCH_SOURCES) || 6, 1), 20)
// 硬截止要盖得住 yt-dlp 的一次搜索（实测 6-15 秒），否则它经常赶不上
const SEARCH_DEADLINE = Math.min(Math.max(Number(process.env.MUSIC_SEARCH_DEADLINE) || 15000, 2000), 40000)
// 拿到第一个结果就先回，不让慢源拖住搜索框
const SEARCH_SOFT_DEADLINE = Math.min(
  Math.max(Number(process.env.MUSIC_SEARCH_SOFT_DEADLINE) || 3500, 500),
  SEARCH_DEADLINE
)
// 自动匹配（换源播放）时最多试几个源
const MATCH_SOURCES = Math.min(Math.max(Number(process.env.MUSIC_MATCH_SOURCES) || 4, 1), 10)

function musicError(res, err, fallbackMessage = '音乐源请求失败') {
  const raw = Number(err?.status)
  const status = raw >= 400 && raw < 600 ? raw : 502
  res.status(status).json({ error: err?.message || fallbackMessage })
}

// 把流地址换成经过本站的代理地址：<audio> 发不出自定义头，令牌只能挂在 query 上
function withPlayUrl(streams, req) {
  const token = tokenFromRequest(req)
  const suffix = token ? `&token=${encodeURIComponent(token)}` : ''
  return (Array.isArray(streams) ? streams : []).map((stream) => ({
    ...stream,
    playUrl: `/api/music/proxy?url=${encodeURIComponent(stream.url)}${suffix}`
  }))
}

router.get('/sources', async (req, res) => {
  try {
    const list = await getSources()
    let withHealth = sourcesWithHealth(list)
    if (req.query.check === '1') {
      withHealth = await checkSources(list, { deadline: 10000 })
    }
    res.json({
      sources: withHealth.map((item) => ({ ...item })),
      meta: {
        proxy: proxyStatus(),
        addableKinds: addableKinds(),
        slowKinds: slowKinds(),
        searchSources: SEARCH_SOURCES
      }
    })
  } catch (err) {
    musicError(res, err, '加载音乐源失败')
  }
})

router.post('/sources', async (req, res) => {
  try {
    const source = await addSource({
      kind: req.body?.kind,
      api: req.body?.api,
      name: req.body?.name
    })
    res.json({ ok: true, source })
  } catch (err) {
    res.status(400).json({ error: err.message || '新增音源失败' })
  }
})

router.put('/sources/:id', async (req, res) => {
  try {
    const source = await resolveSource(String(req.params.id))
    if (!source) return res.status(404).json({ error: '音源不存在' })
    const enabled = req.body?.enabled !== false
    await setSourceEnabled(source.id, enabled)
    res.json({ ok: true, id: source.id, enabled })
  } catch (err) {
    musicError(res, err, '设置音源状态失败')
  }
})

router.post('/sources/:id/check', async (req, res) => {
  try {
    const source = await resolveSource(String(req.params.id))
    if (!source) return res.status(404).json({ error: '音源不存在' })
    const result = await checkSource(source)
    res.json({ ok: true, ...result })
  } catch (err) {
    musicError(res, err, '检测音源失败')
  }
})

router.delete('/sources/:id', async (req, res) => {
  try {
    await removeSource(String(req.params.id))
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err.message || '删除音源失败' })
  }
})

// 搜索：不指定 source 时并搜所有已启用音源（失败/停用的先排除）
router.get('/search', async (req, res) => {
  const wd = String(req.query.wd || '').trim()
  if (!wd) return res.status(400).json({ error: '缺少搜索关键词' })
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 80)
  const perSource = Math.min(Math.max(Number(req.query.perSource) || 10, 1), 30)
  try {
    // slow=exclude：只要快源（前端第一趟）；slow=only：只要慢源（前端第二趟）。
    // 缺省不拆，一次搜完 —— 直接调接口的人仍然只发一个请求就能拿全。
    const slow = String(req.query.slow || '').trim()
    const isSlow = (item) => Boolean(adapterFor(item.kind)?.capabilities?.slow)
    const all = await getSources()
    const requested = String(req.query.source || '').trim()
    let targets
    if (requested) {
      const hit = all.find((item) => item.id === requested)
      if (!hit) return res.status(404).json({ error: '音源不存在' })
      targets = [hit]
    } else {
      const healthy = sourcesWithHealth(activeSources(all)).filter((item) => item.status !== 'fail')
      const ranked = rankSources(healthy.length ? healthy : activeSources(all))
      let pool = ranked
      if (slow === 'exclude') pool = ranked.filter((item) => !isSlow(item))
      else if (slow === 'only') pool = ranked.filter(isSlow)
      targets = spreadByGroup(pool, slow === 'only' ? pool.length : SEARCH_SOURCES)
    }
    // slow=only 且没有慢音源时不是错误，正常回一个空结果（前端第二趟会经常走到这里）
    if (!targets.length) {
      if (slow) return res.json({ wd, results: [], errors: [], searched: [] })
      return res.status(400).json({ error: '没有可用的音乐源，请先在音源管理里启用' })
    }
    const { results, errors } = await searchAll(targets, {
      wd,
      limit,
      perSource,
      deadline: SEARCH_DEADLINE,
      softDeadline: SEARCH_SOFT_DEADLINE
    })
    res.json({ wd, results, errors, searched: targets.map((item) => item.id) })
  } catch (err) {
    musicError(res, err, '搜索音乐失败')
  }
})

// 取某首歌的可播放流
router.get('/stream', async (req, res) => {
  const source = await resolveSource(String(req.query.source || ''))
  if (!source) return res.status(404).json({ error: '音源不存在' })
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: '缺少曲目 id' })
  try {
    const data = await resolveStreams(source, id)
    res.json({
      track: {
        key: `${source.id}:${id}`,
        id,
        source: source.id,
        sourceName: source.name,
        kind: source.kind,
        name: data.title || '',
        artists: [],
        album: '',
        duration: data.duration || 0,
        pic: data.pic || '',
        externalUri: '',
        preview: Boolean(data.preview)
      },
      streams: withPlayUrl(data.streams, req)
    })
  } catch (err) {
    musicError(res, err, '解析播放地址失败')
  }
})

// 「换源播放」：只知道曲名/艺术家时，逐源找最佳匹配并直接返回可播流
router.get('/match', async (req, res) => {
  const title = String(req.query.title || '').trim()
  if (!title) return res.status(400).json({ error: '缺少 title 参数' })
  const artists = String(req.query.artists || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const duration = Number(req.query.duration) || 0
  try {
    const all = await getSources()
    // 换源是逐个试的：先把「快」的试完（JioSaavn / 试听通常 1 秒内出结果），
    // 再拿 yt-dlp 兜底（一次十几秒），免得本来一首 JioSaavn 就有的歌也等十几秒
    const ranked = spreadByGroup(
      rankSources(sourcesWithHealth(activeSources(all)).filter((item) => item.status !== 'fail')),
      MATCH_SOURCES
    )
    const targets = [
      ...ranked.filter((item) => !adapterFor(item.kind)?.capabilities?.slow),
      ...ranked.filter((item) => adapterFor(item.kind)?.capabilities?.slow)
    ]
    if (!targets.length) return res.status(400).json({ error: '没有可用的音乐源' })
    const result = await matchTrack({ title, artists, duration, sources: targets })
    res.json({ ...result, streams: result.matched ? withPlayUrl(result.streams, req) : [] })
  } catch (err) {
    musicError(res, err, '匹配音源失败')
  }
})

// 封面代理（音乐封面同样有防盗链 / http 混合内容问题）
router.get('/image', (req, res) => handleImageProxy(req, res))
// 音频流代理：Range 透传，m3u8 清单会被重写（个别源给的是 HLS）
router.get('/proxy', (req, res) => handleHlsProxy(req, res))

export default router
