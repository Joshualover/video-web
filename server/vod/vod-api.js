// /api/* 顶层别名路由：让第三方 LibreTV 客户端（TVBox 壳/浏览器插件等）不改配置直连本站。
// 契约对齐 LibreTV 的接口形态（语义重写）：
//   POST /api/search          { wd, sources: [{key,name,url}], filterAdult? } → { list, failures }
//   GET  /api/detail          ?id=&source={"key","name","url"} → { episodes: string[], videoInfo }
//   GET  /api/status          站点状态（passwordRequired/verified/version/defaultSources）
// （/api/proxy 已由 index.js 的既有实现覆盖，不在此重复注册）
//   GET  /api/hot-list        ?id=<榜单>
//   GET  /api/bangumi/calendar
//   GET  /api/source-list     ?url=<订阅> 三格式自动识别（TVBox / SourceList / 接口目录）
//
// 安全边界与站内接口一致：全部过 assertProxyToken 与限流；
// 用户传入的源地址逐条过出网校验（协议/内网），搜索扇出限制在重型限流档内。
import { Router } from 'express'
import { loadList, loadDetail } from './query.js'
import { filterRelevantResults, normalizeForMatch } from './title-match.js'
import { mapLimit } from './sources.js'
import { parseSubscriptionPayload, describeParseStats } from './subscription-parser.js'
import { fetchHotList, isHotListId, HOT_LIST_IDS } from './hot-list.js'
import { fetchBangumiCalendar } from './bangumi.js'
import { httpGetText } from './maccms.js'
import { assertPublicTarget, tokenAllowed, tokenFromRequest } from '../proxy-core.js'

const router = Router()

// ---- 成人内容过滤（与发现页解耦的独立一档关键词，默认开启）----
const ADULT_KEYWORDS = [
  '伦理片', '福利', '倫理片', '日本伦理', '擦边短剧', '里番动漫', '门事件', '国产传媒',
  'cosplay', '黑丝诱惑', '无码', '有码', 'SWAG', '色情片', '同性片', '91视频', '自拍偷拍'
]

export function isAdultContent(typeName) {
  const name = String(typeName || '')
  if (!name) return false
  return ADULT_KEYWORDS.some((k) => name.toLowerCase().includes(k.toLowerCase()))
}

// 用户传入的源必须逐条校验（可能是内网/元数据地址）；通过才留下，坏地址整条拒绝
async function assertSourcesValid(urls) {
  for (const url of urls) {
    await assertPublicTarget(url)
  }
}

function sourceFromUrl(url) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

// POST /api/search：LibreTV 形态的聚合搜索
router.post('/search', async (req, res) => {
  const body = req.body || {}
  const wd = String(body.wd || '').trim()
  if (!wd) return res.status(400).json({ error: '搜索关键词无效' })
  const rawSources = Array.isArray(body.sources) ? body.sources : []
  const sources = rawSources
    .slice(0, 50)
    .map((s) => ({
      key: String(s?.key || s?.url || ''),
      name: String(s?.name || sourceFromUrl(s?.url || '')),
      url: String(s?.url || '').trim()
    }))
    .filter((s) => /^https?:\/\//i.test(s.url))
  if (!sources.length) return res.status(400).json({ error: '请至少选择一个点播源' })

  try {
    await assertSourcesValid(sources.map((s) => s.url))
  } catch (err) {
    return res.status(err.status || 403).json({ error: err.message || '源地址不被允许' })
  }

  const filterAdult = body.filterAdult !== false
  // 扇出并发上限 6：一次请求最多 50 个源，全并发会把出口打满、也会被源站封 IP
  const outcomes = new Array(sources.length)
  await mapLimit(sources, 6, async (source, i) => {
    try {
      const data = await loadList({ api: source.url, kind: 'maccms' }, { wd, page: 1 }, { timeout: 10000 })
      const list = filterRelevantResults(data.list, wd).map((video) => ({
        sourceKey: source.key || source.url,
        sourceName: source.name,
        vodId: video.id,
        name: video.name,
        pic: video.pic || undefined,
        typeName: video.type || undefined,
        year: video.year || undefined,
        area: video.area || undefined,
        remarks: video.remarks || undefined,
        sourceUrl: source.url
      }))
      outcomes[i] = { sourceKey: source.key || source.url, ok: true, list, error: undefined }
    } catch (err) {
      const message = err?.message || '搜索失败'
      outcomes[i] = { sourceKey: source.key || source.url, ok: false, list: [], error: message, timedOut: /超时|timeout/i.test(message) }
    }
  })

  let list = outcomes.filter(Boolean).flatMap((o) => o.list)
  if (filterAdult) list = list.filter((item) => !isAdultContent(item.typeName))
  // 精确命中优先：按归一化名比较（标点/大小写差异不影响），与站内搜索同语义
  const nWd = normalizeForMatch(wd)
  const rank = (item) => {
    const n = normalizeForMatch(item.name)
    if (n === nWd) return 0
    if (n.startsWith(nWd)) return 1
    return 2
  }
  list.sort((a, b) => rank(a) - rank(b))
  const failures = outcomes
    .filter(Boolean)
    .filter((o) => !o.ok)
    .map((o) => ({ sourceKey: o.sourceKey, error: o.error, timedOut: o.timedOut || undefined }))
  res.json({ list, failures })
})

// GET /api/detail：LibreTV 形态的详情（source 参数是内嵌 JSON 的源配置）
router.get('/detail', async (req, res) => {
  const id = String(req.query.id || '').trim()
  if (!id || !/^[\w-]+$/.test(id)) return res.status(400).json({ error: '无效的视频ID' })
  let source = null
  try {
    const parsed = JSON.parse(String(req.query.source || ''))
    if (parsed && /^https?:\/\//i.test(String(parsed.url || ''))) {
      source = { key: String(parsed.key || parsed.url), name: String(parsed.name || ''), url: String(parsed.url) }
    }
  } catch {
    // 非法 source 参数走下面的统一报错
  }
  if (!source) return res.status(400).json({ error: '无效的点播源配置' })
  try {
    await assertPublicTarget(source.url)
  } catch (err) {
    return res.status(err.status || 403).json({ error: err.message || '源地址不被允许' })
  }
  try {
    const video = await loadDetail({ api: source.url, kind: 'maccms' }, id, { timeout: 10000 })
    if (!video) return res.status(404).json({ error: '未找到该影片' })
    // 拍平成 LibreTV 契约：episodes 是 URL 数组（取首选线路），videoInfo 是驼峰字段
    const preferred = Math.max(Math.min(Number(video.preferredLine) || 0, (video.playUrl || []).length - 1), 0)
    const episodes = (video.playUrl || [])[preferred]?.map((ep) => ep.url) || []
    res.json({
      episodes,
      videoInfo: {
        title: video.name,
        cover: video.pic,
        desc: video.content,
        typeName: video.type,
        year: video.year,
        area: video.area,
        director: video.director,
        actor: video.actor,
        remarks: video.remarks,
        sourceKey: source.key,
        sourceName: source.name,
        sourceUrl: source.url
      }
    })
  } catch (err) {
    res.status(502).json({ error: err.message || '详情获取失败' })
  }
})

// GET /api/status：站点状态（客户端据此决定是否弹登录框 / 拉预置源）
router.get('/status', (req, res) => {
  const passwordRequired = Boolean(process.env.PROXY_TOKEN)
  res.json({
    passwordRequired,
    verified: tokenAllowed(tokenFromRequest(req), String(req.headers.authorization || '')),
    version: process.env.APP_VERSION || 'dev',
    // 本站的采集源由服务端配置管理，别名接口不代管源清单：给空数组保持契约形状
    defaultSources: [],
    defaultLiveSources: [],
    defaultSubscriptions: []
  })
})

// GET /api/hot-list：热榜（豆瓣五个周榜 + 百度热播剧）
router.get('/hot-list', async (req, res) => {
  const id = String(req.query.id || '')
  if (!isHotListId(id)) return res.status(400).json({ error: `未知榜单: ${id.slice(0, 30)}`, allowed: HOT_LIST_IDS })
  try {
    const items = await fetchHotList(id)
    res.json({ items })
  } catch (err) {
    res.status(502).json({ error: err.message || '榜单获取失败' })
  }
})

// GET /api/bangumi/calendar：追番日历（按星期分组 1-7）
router.get('/bangumi/calendar', async (_req, res) => {
  try {
    const days = await fetchBangumiCalendar()
    res.json({ days })
  } catch (err) {
    res.status(502).json({ error: err.message || '放送表获取失败' })
  }
})

// GET /api/source-list?url=<订阅>：拉远程订阅并自动识别三种格式（TVBox / LibreTV-SourceList / 接口目录）
router.get('/source-list', async (req, res) => {
  const target = String(req.query.url || '').trim()
  if (!/^https?:\/\//i.test(target)) return res.status(400).json({ error: '无效的订阅地址' })
  try {
    await assertPublicTarget(target)
  } catch (err) {
    return res.status(err.status || 403).json({ error: err.message || '目标地址不被允许' })
  }
  try {
    const text = await httpGetText(target, { timeout: 8000, headers: { Accept: 'application/json' } })
    const payload = parseSubscriptionPayload(text)
    if (!payload.sources.length && !payload.liveSources.length) {
      const detail = describeParseStats(payload.stats)
      return res.status(422).json({ error: `配置中没有可导入的源${detail ? `：${detail}` : ''}`, stats: payload.stats })
    }
    res.json({
      name: payload.name || undefined,
      sources: payload.sources,
      liveSources: payload.liveSources,
      stats: payload.stats,
      statsText: describeParseStats(payload.stats) || undefined
    })
  } catch (err) {
    if (err?.status === 403 || err?.status === 400) return res.status(err.status).json({ error: err.message })
    res.status(502).json({ error: err.message || '订阅获取失败' })
  }
})

export default router
