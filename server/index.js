import express from 'express'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import {
  proxyFetch,
  tokenAllowed
} from './proxy-core.js'
import { collectOnly, crawlAndSave, isAllowedBase, getCrawlBases } from './crawler.js'
import { fetchCategories, fetchList, fetchDetail } from './vod/maccms.js'
import {
  getSources,
  resolveSource,
  checkSources,
  checkSource,
  markHealth,
  sourcesWithHealth,
  spreadByGroup,
  activeSources,
  getConfigStatus,
  refreshConfigs,
  invalidateSources
} from './vod/sources.js'
import { setSourceEnabled } from './vod/source-prefs.js'
import { proxyStatus } from './net.js'
import { resolveMediaUrl, handleHlsProxy, isHttpUrl } from './vod/hls.js'
import { listConfigs, addConfig, updateConfig, removeConfig } from './vod/config-store.js'
import { findBestLines } from './vod/best.js'

const app = express()
const PORT = Number(process.env.PORT) || 8787
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '../dist')
const DATA_DIR = path.resolve(__dirname, '../data')
const ALLOWED_DATA_EXT = ['.m3u', '.m3u8', '.txt']
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

// 校验 data 目录文件名，防路径穿越（仅允许纯文件名 + 允许的扩展名）
function safeDataName(name) {
  if (typeof name !== 'string' || !name) return null
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null
  const ext = path.extname(name).toLowerCase()
  if (!ALLOWED_DATA_EXT.includes(ext)) return null
  return name
}

async function listDataFiles() {
  let entries
  try {
    entries = await readdir(DATA_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!ALLOWED_DATA_EXT.includes(path.extname(entry.name).toLowerCase())) continue
    try {
      const info = await stat(path.join(DATA_DIR, entry.name))
      files.push({ name: entry.name, size: info.size, modifiedAt: info.mtimeMs })
    } catch {
      // 忽略不可读文件
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name))
  return files
}

app.use(express.json({ limit: '1mb' }))
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

function assertProxyToken(req, res, next) {
  if (!tokenAllowed(req.query.token, req.headers.authorization || '')) {
    return res.status(401).json({ error: '缺少有效的访问令牌' })
  }
  next()
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'flow-player-proxy', time: Date.now() })
})

app.get('/api/proxy', assertProxyToken, async (req, res) => {
  const rawUrl = req.query.url
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return res.status(400).json({ error: '缺少 url 参数' })
  }
  try {
    const result = await proxyFetch(rawUrl)
    res.set('Content-Type', result.contentType)
    res.send(result.text)
  } catch (err) {
    const status = err.status || 500
    const message = err.message || '代理请求失败'
    res.status(status).json({ error: message })
  }
})

// ---- data 目录播放列表管理 ----

app.get('/api/playlists', async (_req, res) => {
  const files = await listDataFiles()
  res.json({ files })
})

app.get('/api/playlists/content', async (req, res) => {
  const name = safeDataName(req.query.name)
  if (!name) return res.status(400).json({ error: '文件名非法' })
  try {
    const content = await readFile(path.join(DATA_DIR, name), 'utf8')
    res.set('Content-Type', 'text/plain; charset=utf-8')
    res.send(content)
  } catch {
    res.status(404).json({ error: '文件不存在' })
  }
})

app.post(
  '/api/playlists',
  assertProxyToken,
  express.text({ limit: '10mb', type: '*/*' }),
  async (req, res) => {
    const name = safeDataName(req.query.name)
    if (!name) return res.status(400).json({ error: '文件名非法，仅支持 .m3u/.m3u8/.txt' })
    const content = req.body
    if (typeof content !== 'string' || content.trim() === '') {
      return res.status(400).json({ error: '上传内容为空' })
    }
    if (Buffer.byteLength(content) > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: '文件超过 10MB 限制' })
    }
    try {
      await writeFile(path.join(DATA_DIR, name), content, 'utf8')
      res.json({ ok: true, name })
    } catch {
      res.status(500).json({ error: '写入文件失败' })
    }
  }
)

// 站点可用域名列表（含自动发现的新域名）
app.get('/api/crawl-domains', assertProxyToken, (_req, res) => {
  const bases = getCrawlBases()
  res.json({ bases, current: bases[0] || '' })
})

// 解析播放地址（网页播放页 → 真实 m3u8），返回可直接播放的代理地址
app.get('/api/vod/play', async (req, res) => {
  const raw = String(req.query.url || '')
  if (!isHttpUrl(raw)) return res.status(400).json({ error: 'url 参数非法' })
  try {
    const url = await resolveMediaUrl(raw)
    res.json({ url, playUrl: `/api/vod/hls?url=${encodeURIComponent(url)}` })
  } catch (err) {
    vodError(res, err, '解析播放地址失败')
  }
})

// HLS 代理（m3u8 重写 + 片段透传，解决 Referer / 跨域）
app.get('/api/vod/hls', assertProxyToken, handleHlsProxy)

// ---- 影视聚合（数据源来自 awesome-zhuiju-free 的 TVBox 配置） ----

function vodError(res, err, fallbackMessage = '影视源请求失败') {
  const message = err?.message || fallbackMessage
  res.status(502).json({ error: message })
}

// ---- 影视配置定时自动刷新 ----
const VOD_REFRESH_HOURS = Math.max(Number(process.env.VOD_AUTO_REFRESH_HOURS ?? 6) || 0, 0)
const vodRefreshState = {
  intervalHours: VOD_REFRESH_HOURS,
  lastAt: 0,
  running: false,
  error: ''
}

async function autoRefreshVod() {
  if (vodRefreshState.running) return
  vodRefreshState.running = true
  try {
    const sources = await refreshConfigs()
    await checkSources(sources, { deadline: 12000, concurrency: 6 })
    vodRefreshState.lastAt = Date.now()
    vodRefreshState.error = ''
    console.log(`[vod] 配置已自动刷新：${sources.length} 个源`)
  } catch (err) {
    vodRefreshState.lastAt = Date.now()
    vodRefreshState.error = err?.message || '自动刷新失败'
    console.error('[vod] 自动刷新失败:', vodRefreshState.error)
  } finally {
    vodRefreshState.running = false
  }
}

if (VOD_REFRESH_HOURS > 0) {
  // 启动后预热一次，之后按间隔刷新
  setTimeout(() => void autoRefreshVod(), 20000)
  setInterval(() => void autoRefreshVod(), VOD_REFRESH_HOURS * 3600 * 1000)
}

// 可用影视源列表（带健康状态 + 自动刷新元信息）
app.get('/api/vod/sources', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1'
    const sources = await getSources({ refresh })
    if (req.query.check === '1') {
      const deadline = Math.min(Math.max(Number(req.query.deadline) || 8000, 1500), 20000)
      await checkSources(sources, { deadline })
    }
    res.json({
      sources: sourcesWithHealth(sources),
      meta: {
        autoRefreshHours: vodRefreshState.intervalHours,
        lastRefreshAt: vodRefreshState.lastAt,
        refreshing: vodRefreshState.running,
        lastError: vodRefreshState.error,
        proxy: proxyStatus()
      }
    })
  } catch (err) {
    vodError(res, err, '加载影视源失败')
  }
})

// 单个源的启用/停用（源级偏好，持久化到 data/vod-source-prefs.json）
app.put('/api/vod/sources/:id', async (req, res) => {
  try {
    const source = await resolveSource(String(req.params.id))
    if (!source) return res.status(404).json({ error: '源不存在' })
    const enabled = req.body?.enabled !== false
    await setSourceEnabled(source.id, enabled)
    res.json({ ok: true, id: source.id, enabled })
  } catch (err) {
    vodError(res, err, '设置源状态失败')
  }
})

// 单个源健康检测（源管理页「测试」按钮）
app.post('/api/vod/sources/:id/check', async (req, res) => {
  try {
    const source = await resolveSource(String(req.params.id))
    if (!source) return res.status(404).json({ error: '源不存在' })
    const result = await checkSource(source)
    res.json({ ok: true, ...result })
  } catch (err) {
    vodError(res, err, '检测源失败')
  }
})

// ---- 影视配置管理（源分组） ----

async function configsWithStatus() {
  const configs = await listConfigs()
  let sources = []
  try {
    sources = await getSources()
  } catch {
    sources = []
  }
  const counts = new Map()
  for (const s of sources) {
    if (!s.configId) continue
    counts.set(s.configId, (counts.get(s.configId) || 0) + 1)
  }
  return configs.map((c) => ({
    ...c,
    ...getConfigStatus(c.id),
    sourceCount: counts.get(c.id) || 0
  }))
}

app.get('/api/vod/configs', async (_req, res) => {
  try {
    res.json({ configs: await configsWithStatus() })
  } catch (err) {
    vodError(res, err, '加载配置失败')
  }
})

app.post('/api/vod/configs', async (req, res) => {
  try {
    const item = await addConfig({
      name: req.body?.name,
      url: req.body?.url,
      group: req.body?.group
    })
    invalidateSources()
    res.json({ ok: true, config: item })
  } catch (err) {
    res.status(400).json({ error: err.message || '新增配置失败' })
  }
})

app.put('/api/vod/configs/:id', async (req, res) => {
  try {
    const item = await updateConfig(req.params.id, req.body || {})
    invalidateSources({ configId: item.id })
    res.json({ ok: true, config: item })
  } catch (err) {
    res.status(400).json({ error: err.message || '更新配置失败' })
  }
})

app.delete('/api/vod/configs/:id', async (req, res) => {
  try {
    await removeConfig(req.params.id)
    invalidateSources({ configId: req.params.id })
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err.message || '删除配置失败' })
  }
})

// 重新抓取配置（可指定单个 id）
app.post('/api/vod/configs/refresh', async (req, res) => {
  try {
    const id = req.body?.id ? String(req.body.id) : null
    await refreshConfigs(id)
    res.json({ ok: true, configs: await configsWithStatus() })
  } catch (err) {
    vodError(res, err, '刷新配置失败')
  }
})

// 多源同片自动选最快线路
app.get('/api/vod/best', async (req, res) => {
  const wd = String(req.query.wd || '').trim()
  if (!wd) return res.status(400).json({ error: '缺少 wd 参数' })
  const year = String(req.query.year || '').trim()
  const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 20)
  try {
    const data = await findBestLines({ wd, year, limit, probe: req.query.probe !== '0' })
    res.json(data)
  } catch (err) {
    vodError(res, err, '选路失败')
  }
})

// 分类列表
app.get('/api/vod/categories', async (req, res) => {
  const source = await resolveSource(String(req.query.site || ''))
  if (!source) return res.status(404).json({ error: '影视源不存在' })
  try {
    const { classes } = await fetchCategories(source.api)
    markHealth(source.id, true)
    res.json({ site: source.id, classes })
  } catch (err) {
    markHealth(source.id, false, err.message)
    vodError(res, err)
  }
})

// 分类列表（分页）
app.get('/api/vod/list', async (req, res) => {
  const source = await resolveSource(String(req.query.site || ''))
  if (!source) return res.status(404).json({ error: '影视源不存在' })
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), 1000)
  const typeId = String(req.query.type || '')
  try {
    const data = await fetchList(source.api, { typeId, page })
    markHealth(source.id, true)
    res.json({ site: source.id, siteName: source.name, ...data })
  } catch (err) {
    markHealth(source.id, false, err.message)
    vodError(res, err)
  }
})

// 详情（含线路与剧集播放地址）
app.get('/api/vod/detail', async (req, res) => {
  const source = await resolveSource(String(req.query.site || ''))
  if (!source) return res.status(404).json({ error: '影视源不存在' })
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: '缺少 id 参数' })
  try {
    const detail = await fetchDetail(source.api, id)
    if (!detail) return res.status(404).json({ error: '未找到该影片' })
    markHealth(source.id, true)
    res.json({ site: source.id, siteName: source.name, detail })
  } catch (err) {
    markHealth(source.id, false, err.message)
    vodError(res, err)
  }
})

// 聚合搜索：并发查询多个源，按 名称+年份 去重
app.get('/api/vod/search', async (req, res) => {
  const wd = String(req.query.wd || '').trim()
  if (!wd) return res.status(400).json({ error: '缺少搜索关键词' })
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 120)
  try {
    const all = await getSources()
    const requested = String(req.query.sites || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    let targets = requested.length
      ? activeSources(all).filter((s) => requested.includes(s.id))
      : spreadByGroup(
          activeSources(sourcesWithHealth(all)).filter((s) => s.status !== 'fail'),
          14
        )
    if (!targets.length) targets = spreadByGroup(activeSources(all), 8)

    const settled = await Promise.allSettled(
      targets.map(async (source) => {
        const data = await fetchList(source.api, { wd, page: 1 })
        markHealth(source.id, true)
        return { source, list: data.list }
      })
    )

    const seen = new Set()
    const results = []
    for (const item of settled) {
      if (item.status !== 'fulfilled') continue
      const { source, list } = item.value
      for (const video of list) {
        const key = `${video.name}|${video.year}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({
          ...video,
          site: source.id,
          siteName: source.name
        })
        if (results.length >= limit) break
      }
      if (results.length >= limit) break
    }
    res.json({ wd, total: results.length, list: results })
  } catch (err) {
    vodError(res, err, '搜索失败')
  }
})

// ---- 站内搜索 / 抓取任务（两阶段） ----
const crawlTasks = new Map()
let crawlRunning = false

function cleanTaskMap() {
  if (crawlTasks.size <= 30) return
  for (const [k, t] of crawlTasks) {
    if (t.state !== 'running' && crawlTasks.size > 20) crawlTasks.delete(k)
  }
}

// 阶段一：仅搜索，返回候选列表（不抓 m3u8）
app.post('/api/site-search', assertProxyToken, async (req, res) => {
  const wd = String(req.body?.wd || '').trim()
  const base = String(req.body?.base || 'https://678060.xyz').replace(/\/+$/, '')
  const limit = Math.min(Math.max(Number(req.body?.limit) || 500, 1), 500)
  if (!wd || wd.length > 50) {
    return res.status(400).json({ error: '请输入 1-50 字关键词' })
  }
  if (!isAllowedBase(base)) {
    return res.status(400).json({ error: '站点地址不在支持范围' })
  }
  if (crawlRunning) {
    return res.status(409).json({ error: '已有搜索/抓取任务进行中，请稍候再试' })
  }
  const taskId = crypto.randomBytes(6).toString('hex')
  const task = {
    id: taskId,
    type: 'search',
    keyword: wd,
    state: 'running',
    items: [],
    error: null,
    startedAt: Date.now()
  }
  crawlTasks.set(taskId, task)
  cleanTaskMap()
  crawlRunning = true
  void (async () => {
    try {
      const list = await collectOnly(wd, { base, limit })
      task.state = 'done'
      task.items = list
    } catch (err) {
      task.state = 'error'
      task.error = err.message || '搜索失败'
    } finally {
      crawlRunning = false
    }
  })()
  res.json({ ok: true, taskId })
})

// 阶段二：抓取所选条目 → 生成新文件或并入目标 m3u
app.post('/api/site-crawl', assertProxyToken, async (req, res) => {
  const base = String(req.body?.base || 'https://678060.xyz').replace(/\/+$/, '')
  const mode = req.body?.mode === 'merge' ? 'merge' : 'new'
  const group = String(req.body?.group || '').trim().slice(0, 30)
  const target = req.body?.target ? safeDataName(String(req.body.target)) : null
  const rawItems = Array.isArray(req.body?.items) ? req.body.items.slice(0, 500) : []
  const items = rawItems
    .filter((it) => it && typeof it.href === 'string' && it.href.startsWith('/') && it.href.length < 120)
    .map((it) => ({ title: String(it.title || '').slice(0, 150), href: it.href }))
  if (!isAllowedBase(base)) {
    return res.status(400).json({ error: '站点地址不在支持范围' })
  }
  if (!items.length) {
    return res.status(400).json({ error: '未选择任何结果' })
  }
  if (mode === 'merge' && !target) {
    return res.status(400).json({ error: '请选择要并入的目标文件' })
  }
  if (crawlRunning) {
    return res.status(409).json({ error: '已有搜索/抓取任务进行中，请稍候再试' })
  }
  const taskId = crypto.randomBytes(6).toString('hex')
  const task = {
    id: taskId,
    type: 'crawl',
    mode,
    group,
    target,
    state: 'running',
    done: 0,
    total: items.length,
    current: '',
    file: null,
    result: null,
    error: null,
    startedAt: Date.now()
  }
  crawlTasks.set(taskId, task)
  cleanTaskMap()
  crawlRunning = true
  void (async () => {
    try {
      const r = await crawlAndSave({
        base,
        items,
        mode,
        group,
        target,
        outDir: DATA_DIR,
        onProgress: (done, total, title) => {
          task.done = done
          task.total = total
          task.current = String(title || '').slice(0, 60)
        }
      })
      task.state = 'done'
      task.file = r.file
      task.result = r
    } catch (err) {
      task.state = 'error'
      task.error = err.message || '抓取失败'
    } finally {
      crawlRunning = false
    }
  })()
  res.json({ ok: true, taskId })
})

app.get('/api/site-search/status', (req, res) => {
  const task = crawlTasks.get(String(req.query.taskId || ''))
  if (!task) return res.status(404).json({ error: '任务不存在' })
  res.json({
    id: task.id,
    type: task.type,
    state: task.state,
    keyword: task.keyword || '',
    done: task.done || 0,
    total: task.total || 0,
    current: task.current || '',
    items: task.items || [],
    mode: task.mode || '',
    file: task.file || null,
    result: task.result || null,
    error: task.error || null
  })
})

if (existsSync(distDir)) {
  app.use(
    express.static(distDir, {
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          // Vite 构建产物带内容 hash，可长期缓存
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        } else {
          // index.html 等入口文件不缓存，保证拿到最新版本
          res.setHeader('Cache-Control', 'no-cache')
        }
      }
    })
  )
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      return res.sendFile(path.join(distDir, 'index.html'))
    }
    next()
  })
}

// data 目录被 .gitignore 忽略（不随代码部署），启动时自动创建
await mkdir(DATA_DIR, { recursive: true })

app.listen(PORT, () => {
  console.log(`[flow-player] API 代理已启动: http://localhost:${PORT}`)
})
