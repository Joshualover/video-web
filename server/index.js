import express from 'express'
import compression from 'compression'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import {
  ALLOW_PRIVATE_NETWORK,
  PROXY_TOKEN,
  proxyFetch,
  sanitizeProxyContentType,
  tokenAllowed,
  tokenFromRequest
} from './proxy-core.js'
import { collectOnly, crawlAndSave, isAllowedBase, getCrawlBases } from './crawler.js'
import {
  getSources,
  resolveSource,
  checkSources,
  checkSource,
  markHealth,
  sourcesWithHealth,
  spreadByGroup,
  activeSources,
  rankSources,
  getConfigStatus,
  refreshConfigs,
  invalidateSources
} from './vod/sources.js'
import { setSourceEnabled } from './vod/source-prefs.js'
import { proxyStatus } from './net.js'
import { resolveMediaUrl, handleHlsProxy, isHttpUrl } from './vod/hls.js'
import { loadCategories, loadList, loadDetail } from './vod/query.js'
import { handleImageProxy } from './vod/image.js'
import { doubanOptions, fetchDoubanHot } from './vod/douban.js'
import { listConfigs, addConfig, updateConfig, removeConfig } from './vod/config-store.js'
import { findBestLines } from './vod/best.js'

const app = express()
app.disable('x-powered-by')

// gzip 压缩：m3u 播放列表（纯文本，可达 ~85% 压缩率）与前端 JS 都受益，
// 显著改善 WiFi / 远程访问时的加载速度。
app.use(compression())
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

// CORS：默认只服务同源页面（生产下前端由本服务托管，天然同源）。
// 需要让其它站点/设备跨源调用时显式设置 CORS_ORIGIN（"*" 或逗号分隔的白名单）。
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').trim()

function resolveCorsOrigin(origin) {
  if (!CORS_ORIGIN || !origin) return ''
  if (CORS_ORIGIN === '*') return '*'
  const list = CORS_ORIGIN.split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return list.includes(origin) ? origin : ''
}

app.use(express.json({ limit: '1mb' }))
app.use((req, res, next) => {
  // 上游内容不可信：禁止浏览器对响应做 MIME 嗅探
  res.set('X-Content-Type-Options', 'nosniff')
  if (req.path.startsWith('/api')) {
    // API 只产出 JSON / 文本 / 媒体，任何情况下都不该在响应里执行脚本
    res.set('Content-Security-Policy', "default-src 'none'; sandbox")
    res.set('Referrer-Policy', 'no-referrer')
    const allowed = resolveCorsOrigin(req.headers.origin)
    if (allowed) {
      res.set('Access-Control-Allow-Origin', allowed)
      res.set('Vary', 'Origin')
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    }
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ---- 轻量限流（无第三方依赖，进程内存态）----
// 目的：挡住脚本循环调用「放大型」端点（全源搜索 / 选路 / 全量刷新 / 站内抓取），
// 否则一次调用就会扇出几十次上游请求，既打满出口带宽也会让源站封掉本机 IP。
// 0 = 关闭；部署在反向代理后面、需要真实客户端 IP 时设 TRUST_PROXY=1（否则按 socket 地址计）。
const RATE_LIMIT_PER_MIN = Math.max(Number(process.env.RATE_LIMIT_PER_MIN ?? 600) || 0, 0)
const RATE_LIMIT_HEAVY_PER_MIN = Math.max(Number(process.env.RATE_LIMIT_HEAVY_PER_MIN ?? 30) || 0, 0)
// 登录单独一档：防止拿口令爆破（WEB_LOGIN 场景）
const RATE_LIMIT_LOGIN_PER_MIN = Math.max(Number(process.env.RATE_LIMIT_LOGIN_PER_MIN ?? 10) || 0, 0)
const HEAVY_ROUTE_RE = /^\/api\/(vod\/search|vod\/best|site-search|site-crawl)/
const RATE_LIMITS = {
  l: RATE_LIMIT_LOGIN_PER_MIN,
  h: RATE_LIMIT_HEAVY_PER_MIN,
  n: RATE_LIMIT_PER_MIN
}

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1)

function isHeavyRoute(req) {
  if (HEAVY_ROUTE_RE.test(req.path)) return true
  if (req.path === '/api/vod/configs/refresh') return true
  // ?check=1 / ?refresh=1 会触发全源健康检查或全量重抓，:id/check 同理
  if (req.path === '/api/vod/sources' && (req.query.check === '1' || req.query.refresh === '1')) return true
  if (req.path.startsWith('/api/vod/sources/')) return true
  return false
}

const rateBuckets = new Map() // `${class}:${ip}` -> { count, resetAt }

function hitRateLimit(key, limit) {
  const now = Date.now()
  const bucket = rateBuckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    if (rateBuckets.size > 5000) {
      for (const [k, v] of rateBuckets) {
        if (v.resetAt <= now) rateBuckets.delete(k)
      }
    }
    rateBuckets.set(key, { count: 1, resetAt: now + 60_000 })
    return 0
  }
  bucket.count += 1
  if (bucket.count > limit) return Math.max(Math.ceil((bucket.resetAt - now) / 1000), 1)
  return 0
}

app.use((req, res, next) => {
  if (!req.path.startsWith('/api') || req.path === '/api/health') return next()
  const cls = req.path === '/api/login' ? 'l' : isHeavyRoute(req) ? 'h' : 'n'
  const limit = RATE_LIMITS[cls]
  if (!limit) return next()
  const ip = req.ip || req.socket?.remoteAddress || 'unknown'
  const retryAfter = hitRateLimit(`${cls}:${ip}`, limit)
  if (!retryAfter) return next()
  res.set('Retry-After', String(retryAfter))
  return res.status(429).json({ error: `请求过于频繁，请 ${retryAfter} 秒后再试` })
})

// ---- 可选：整站 Basic 鉴权（默认关闭）----
// 前端「登录」只是本地 UI 门槛（口令存在浏览器里，服务端不校验它）。
// 要真正挡住未授权访问，可以交给反向代理，或者设 BASIC_AUTH="user:pass" 让本服务自己把关。
const BASIC_AUTH = (process.env.BASIC_AUTH || '').trim()
if (BASIC_AUTH) {
  const expectedBuf = Buffer.from(`Basic ${Buffer.from(BASIC_AUTH).toString('base64')}`)
  app.use((req, res, next) => {
    // 探活放行，便于反向代理 / 监控检查
    if (req.path === '/api/health') return next()
    const header = String(req.headers.authorization || '')
    const buf = Buffer.from(header)
    // 恒定时间比较，避免用长度/前缀去试探口令
    const okBasic = buf.length === expectedBuf.length && crypto.timingSafeEqual(buf, expectedBuf)
    // 与 PROXY_TOKEN 兼容：带有效 Bearer 的请求（前端 fetch / API 客户端）同样放行
    const okBearer = Boolean(PROXY_TOKEN) && tokenAllowed(null, header)
    if (okBasic || okBearer) {
      // 整站 Basic 已认证的请求不再要求令牌：浏览器的 Basic 凭据对同源请求自动生效，
      // 若同时设了 PROXY_TOKEN，再加一道令牌会让「页面能开、接口全 401」
      req.flowAuthed = true
      return next()
    }
    res.set('WWW-Authenticate', 'Basic realm="flow-player", charset="UTF-8"')
    return res.status(401).send('需要登录')
  })
  console.log('[flow-player] 已开启整站 Basic 鉴权（BASIC_AUTH）')
}

// ---- 可选：服务端会话登录（WEB_LOGIN="user:pass"）----
// 前端默认的「登录」只是本地 UI 门槛（口令存在浏览器里）。设置 WEB_LOGIN 后改为服务端会话：
// 登录成功下发 HttpOnly + SameSite=Lax 的签名 Cookie，/api 请求（含 <video>/<img> 这类发不出
// 自定义头的）都会自动携带，比 PROXY_TOKEN 更适合浏览器场景。默认不设置 = 行为完全不变。
const WEB_LOGIN = (process.env.WEB_LOGIN || '').trim()
const SESSION_COOKIE = 'flow_session'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
// 用口令做 HMAC 密钥：签名不可伪造、口令一改旧会话全部失效，且 HMAC 不会泄漏口令本身
const SESSION_KEY = process.env.SESSION_SECRET || WEB_LOGIN || 'flow-player'
const SESSION_EXEMPT = ['/api/login', '/api/logout', '/api/session', '/api/health']

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''))
  const bufB = Buffer.from(String(b ?? ''))
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)
}

function signSession(exp) {
  return crypto.createHmac('sha256', SESSION_KEY).update(String(exp)).digest('hex')
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return ''
}

function validSession(req) {
  const [exp, sig] = readCookie(req.headers.cookie, SESSION_COOKIE).split('.')
  if (!exp || !sig || Number(exp) < Date.now()) return false
  return constantTimeEqual(sig, signSession(exp))
}

function sessionCookie(exp) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : ''
  const maxAge = Math.max(Math.floor((exp - Date.now()) / 1000), 0)
  return `${SESSION_COOKIE}=${exp}.${signSession(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

app.get('/api/session', (req, res) => {
  res.json({
    enabled: Boolean(WEB_LOGIN),
    authenticated: WEB_LOGIN ? validSession(req) || Boolean(req.flowAuthed) : true
  })
})

app.post('/api/login', (req, res) => {
  if (!WEB_LOGIN) return res.json({ enabled: false, ok: false })
  const user = String(req.body?.username || '').trim()
  const pass = String(req.body?.password || '')
  if (!constantTimeEqual(`${user}:${pass}`, WEB_LOGIN)) {
    return res.status(401).json({ error: '账号或密码错误' })
  }
  res.set('Set-Cookie', sessionCookie(Date.now() + SESSION_TTL_MS))
  res.json({ enabled: true, ok: true })
})

app.post('/api/logout', (_req, res) => {
  res.set('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  res.json({ ok: true })
})

if (WEB_LOGIN) {
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) return next()
    if (SESSION_EXEMPT.includes(req.path)) return next()
    if (req.flowAuthed || validSession(req)) {
      // 会话已认证同样标记为已授权：否则同时设了 PROXY_TOKEN 时会出现「能登录、接口全 401」
      req.flowAuthed = true
      return next()
    }
    return res.status(401).json({ error: '未登录或登录已过期' })
  })
  console.log('[flow-player] 已开启服务端会话登录（WEB_LOGIN）')
}

function assertProxyToken(req, res, next) {
  // 已通过整站 Basic 鉴权的请求直接放行（见上面的 BASIC_AUTH 中间件）
  if (req.flowAuthed) return next()
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
    // 只回传文本类类型：上游给 text/html 时不能原样落到本站 origin（同源 XSS）
    res.set('Content-Type', sanitizeProxyContentType(result.contentType))
    res.send(result.text)
  } catch (err) {
    const status = err.status || 500
    const message = err.message || '代理请求失败'
    res.status(status).json({ error: message })
  }
})

// ---- data 目录播放列表管理 ----

app.get('/api/playlists', assertProxyToken, async (_req, res) => {
  const files = await listDataFiles()
  res.json({ files })
})

app.get('/api/playlists/content', assertProxyToken, async (req, res) => {
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
app.get('/api/vod/play', assertProxyToken, async (req, res) => {
  const raw = String(req.query.url || '')
  if (!isHttpUrl(raw)) return res.status(400).json({ error: 'url 参数非法' })
  try {
    const url = await resolveMediaUrl(raw)
    // 令牌链：生成的播放地址必须把调用方令牌带上，否则 <video> 拿不到 Authorization 会 401
    const token = tokenFromRequest(req)
    const suffix = token ? `&token=${encodeURIComponent(token)}` : ''
    res.json({ url, playUrl: `/api/vod/hls?url=${encodeURIComponent(url)}${suffix}` })
  } catch (err) {
    vodError(res, err, '解析播放地址失败')
  }
})

// HLS 代理（m3u8 重写 + 片段透传，解决 Referer / 跨域）
app.get('/api/vod/hls', assertProxyToken, handleHlsProxy)

// 图片代理（海报防盗链 / http 图片在 https 页面被浏览器拦截）
app.get('/api/vod/image', assertProxyToken, handleImageProxy)

// 豆瓣热门榜单（发现页用，不依赖任何采集源）
app.get('/api/vod/douban/options', assertProxyToken, (_req, res) => {
  res.json({ kinds: doubanOptions() })
})

app.get('/api/vod/douban/hot', assertProxyToken, async (req, res) => {
  try {
    const data = await fetchDoubanHot({
      kind: String(req.query.kind || 'movie'),
      category: String(req.query.category || ''),
      type: String(req.query.type || ''),
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 24
    })
    res.json(data)
  } catch (err) {
    vodError(res, err, '获取豆瓣榜单失败')
  }
})

// ---- 影视聚合（数据源来自 awesome-zhuiju-free 的 TVBox 配置） ----

function vodError(res, err, fallbackMessage = '影视源请求失败') {
  const message = err?.message || fallbackMessage
  // 出口校验拒绝（400/403）等明确状态原样透出，其余按上游失败处理
  const raw = Number(err?.status)
  const status = raw >= 400 && raw < 600 ? raw : 502
  res.status(status).json({ error: message })
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

// 启动预热：只建立缓存，不强制重抓配置。getSources 内部有并发保护，
// 与用户首次访问共享同一份抓取，避免重复请求源站导致卡顿。
async function warmupVod() {
  if (vodRefreshState.running) return
  vodRefreshState.running = true
  try {
    const sources = await getSources()
    await checkSources(sources, { deadline: 12000 })
    vodRefreshState.lastAt = Date.now()
    vodRefreshState.error = ''
    console.log(`[vod] 启动预热完成：${sources.length} 个源`)
  } catch (err) {
    vodRefreshState.lastAt = Date.now()
    vodRefreshState.error = err?.message || '预热失败'
    console.error('[vod] 启动预热失败:', vodRefreshState.error)
  } finally {
    vodRefreshState.running = false
  }
}

if (VOD_REFRESH_HOURS > 0) {
  // 启动后预热缓存（避免重启后首次访问缓存为空而卡顿），之后按间隔强制刷新
  setTimeout(() => void warmupVod(), 3000)
  setInterval(() => void autoRefreshVod(), VOD_REFRESH_HOURS * 3600 * 1000)
}

// 可用影视源列表（带健康状态 + 自动刷新元信息）
app.get('/api/vod/sources', assertProxyToken, async (req, res) => {
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
app.put('/api/vod/sources/:id', assertProxyToken, async (req, res) => {
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
app.post('/api/vod/sources/:id/check', assertProxyToken, async (req, res) => {
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

app.get('/api/vod/configs', assertProxyToken, async (_req, res) => {
  try {
    res.json({ configs: await configsWithStatus() })
  } catch (err) {
    vodError(res, err, '加载配置失败')
  }
})

app.post('/api/vod/configs', assertProxyToken, async (req, res) => {
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

app.put('/api/vod/configs/:id', assertProxyToken, async (req, res) => {
  try {
    const item = await updateConfig(req.params.id, req.body || {})
    invalidateSources({ configId: item.id })
    res.json({ ok: true, config: item })
  } catch (err) {
    res.status(400).json({ error: err.message || '更新配置失败' })
  }
})

app.delete('/api/vod/configs/:id', assertProxyToken, async (req, res) => {
  try {
    await removeConfig(req.params.id)
    invalidateSources({ configId: req.params.id })
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err.message || '删除配置失败' })
  }
})

// 重新抓取配置（可指定单个 id）
app.post('/api/vod/configs/refresh', assertProxyToken, async (req, res) => {
  try {
    const id = req.body?.id ? String(req.body.id) : null
    await refreshConfigs(id)
    res.json({ ok: true, configs: await configsWithStatus() })
  } catch (err) {
    vodError(res, err, '刷新配置失败')
  }
})

// 多源同片自动选最快线路
app.get('/api/vod/best', assertProxyToken, async (req, res) => {
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
app.get('/api/vod/categories', assertProxyToken, async (req, res) => {
  const source = await resolveSource(String(req.query.site || ''))
  if (!source) return res.status(404).json({ error: '影视源不存在' })
  try {
    const { classes } = await loadCategories(source)
    markHealth(source.id, true)
    res.json({ site: source.id, classes })
  } catch (err) {
    markHealth(source.id, false, err.message)
    vodError(res, err)
  }
})

// 分类列表（分页）
app.get('/api/vod/list', assertProxyToken, async (req, res) => {
  const source = await resolveSource(String(req.query.site || ''))
  if (!source) return res.status(404).json({ error: '影视源不存在' })
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), 1000)
  const typeId = String(req.query.type || '')
  try {
    const data = await loadList(source, { typeId, page })
    markHealth(source.id, true)
    res.json({ site: source.id, siteName: source.name, ...data })
  } catch (err) {
    markHealth(source.id, false, err.message)
    vodError(res, err)
  }
})

// 详情（含线路与剧集播放地址）
app.get('/api/vod/detail', assertProxyToken, async (req, res) => {
  const source = await resolveSource(String(req.query.site || ''))
  if (!source) return res.status(404).json({ error: '影视源不存在' })
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: '缺少 id 参数' })
  try {
    const detail = await loadDetail(source, id)
    if (!detail) return res.status(404).json({ error: '未找到该影片' })
    markHealth(source.id, true)
    res.json({ site: source.id, siteName: source.name, detail })
  } catch (err) {
    markHealth(source.id, false, err.message)
    vodError(res, err)
  }
})

// 聚合搜索：并发查询多个源，按 名称+年份 去重
app.get('/api/vod/search', assertProxyToken, async (req, res) => {
  const wd = String(req.query.wd || '').trim()
  if (!wd) return res.status(400).json({ error: '缺少搜索关键词' })
  const limit = Math.min(Math.max(Number(req.query.limit) || 120, 1), 200)
  try {
    const all = await getSources()
    const requested = String(req.query.sites || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    // 参考 LunaTV：默认同时搜所有可用源（不再是固定的前十几个，否则好源会被挤掉），
    // 按「可用+延迟」排序 + 分组轮流取，可用 VOD_SEARCH_SOURCES 调小/调大
    const budget = Math.min(Math.max(Number(process.env.VOD_SEARCH_SOURCES) || 30, 1), 60)
    let targets = requested.length
      ? activeSources(all).filter((s) => requested.includes(s.id))
      : spreadByGroup(
          rankSources(activeSources(sourcesWithHealth(all)).filter((s) => s.status !== 'fail')),
          budget
        )
    if (!targets.length) targets = spreadByGroup(rankSources(activeSources(all)), Math.min(budget, 8))

    const settled = await Promise.allSettled(
      targets.map(async (source) => {
        const data = await loadList(source, { wd, page: 1 })
        markHealth(source.id, true)
        return { source, list: data.list }
      })
    )

    const seen = new Map()
    const results = []
    // 每个源最多取几条：否则一个「什么都搜得到」的源（B站/聚合类）会把总名额吃光，
    // 后面那些正好收录了该片的源反而进不了结果页
    const perSource = Math.min(Math.max(Number(req.query.perSource) || 8, 1), 30)
    for (const item of settled) {
      if (item.status !== 'fulfilled') continue
      const { source, list } = item.value
      let taken = 0
      for (const video of list) {
        const key = `${video.name}|${video.year}`
        const same = seen.get(key)
        // 同名同年的片合并成一条，记录它出现在哪些源（详情/播放页可一键换源）
        if (same) {
          if (!same.sources.some((s) => s.site === source.id)) {
            same.sources.push({
              site: source.id,
              siteName: source.name,
              id: video.id,
              remarks: video.remarks || ''
            })
          }
          continue
        }
        if (results.length >= limit) break
        const entry = {
          ...video,
          site: source.id,
          siteName: source.name,
          sources: [
            { site: source.id, siteName: source.name, id: video.id, remarks: video.remarks || '' }
          ]
        }
        seen.set(key, entry)
        results.push(entry)
        taken += 1
        if (taken >= perSource) break
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
let crawlRunning = null // 当前占用任务锁的 taskId（null = 空闲）

// 任务级硬上限：到点后协作式终止并释放锁。
// 否则一次脚本执行挂起就会把锁永久占住，之后所有人的搜片都只能拿到 409。
const CRAWL_TASK_MAX_MS = Math.max(Number(process.env.CRAWL_TASK_MAX_MS) || 20 * 60 * 1000, 60 * 1000)
const CRAWL_TASK_TTL_MS = Math.max(Number(process.env.CRAWL_TASK_TTL_MS) || 30 * 60 * 1000, 60 * 1000)

function pruneTasks() {
  const now = Date.now()
  for (const [key, task] of crawlTasks) {
    if (task.state === 'running') continue
    if (now - (task.startedAt || now) > CRAWL_TASK_TTL_MS) crawlTasks.delete(key)
  }
}

function cleanTaskMap() {
  pruneTasks()
  if (crawlTasks.size <= 30) return
  for (const [k, t] of crawlTasks) {
    if (t.state !== 'running' && crawlTasks.size > 20) crawlTasks.delete(k)
  }
}

// 统一跑抓取类任务：占用/释放任务锁 + 看门狗超时（协作式终止）
function runCrawlTask(task, job, fallbackMessage = '任务失败') {
  let expired = false
  const watchdog = setTimeout(() => {
    expired = true
    if (task.state === 'running') {
      task.state = 'error'
      task.error = `任务超过 ${Math.round(CRAWL_TASK_MAX_MS / 60000)} 分钟上限，已终止`
    }
    if (crawlRunning === task.id) crawlRunning = null
    console.warn(`[crawler] 任务 ${task.id} 超过上限，已终止并释放任务锁`)
  }, CRAWL_TASK_MAX_MS)

  crawlRunning = task.id
  void (async () => {
    try {
      await job(() => expired)
    } catch (err) {
      if (task.state === 'running') {
        task.state = 'error'
        task.error = err?.message || fallbackMessage
      }
    } finally {
      clearTimeout(watchdog)
      // 只释放自己的锁：看门狗可能已经放锁并让新任务接管
      if (!expired && crawlRunning === task.id) crawlRunning = null
    }
  })()
}

// 阶段一：仅搜索，返回候选列表（不抓 m3u8）
app.post('/api/site-search', assertProxyToken, async (req, res) => {
  const wd = String(req.body?.wd || '').trim()
  const base = String(req.body?.base || 'https://444.aakck.cc').replace(/\/+$/, '')
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
  runCrawlTask(
    task,
    async (stopped) => {
      const list = await collectOnly(wd, { base, limit, shouldStop: stopped })
      task.state = 'done'
      task.items = list
    },
    '搜索失败'
  )
  res.json({ ok: true, taskId })
})

// 阶段二：抓取所选条目 → 生成新文件或并入目标 m3u
app.post('/api/site-crawl', assertProxyToken, async (req, res) => {
  const base = String(req.body?.base || 'https://444.aakck.cc').replace(/\/+$/, '')
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
  runCrawlTask(
    task,
    async (stopped) => {
      const r = await crawlAndSave({
        base,
        items,
        mode,
        group,
        target,
        outDir: DATA_DIR,
        shouldStop: stopped,
        onProgress: (done, total, title) => {
          task.done = done
          task.total = total
          task.current = String(title || '').slice(0, 60)
        }
      })
      task.state = 'done'
      task.file = r.file
      task.result = r
    },
    '抓取失败'
  )
  res.json({ ok: true, taskId })
})

app.get('/api/site-search/status', assertProxyToken, (req, res) => {
  pruneTasks()
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

// /api 下未匹配的路径统一返回 JSON 404，避免前端把 HTML 错误页当成后端故障
app.use('/api', (_req, res) => {
  res.status(404).json({ error: '接口不存在' })
})

// 统一错误处理：对外只给通用文案，细节留在服务端日志（避免泄漏上游/内网信息到响应体）
app.use((err, _req, res, _next) => {
  const status = err?.status || 500
  console.error('[flow-player] 请求处理失败:', err)
  if (res.headersSent) {
    res.end()
    return
  }
  res.status(status).json({ error: status >= 500 ? '服务器内部错误' : err?.message || '请求失败' })
})

// data 目录被 .gitignore 忽略（不随代码部署），启动时自动创建
await mkdir(DATA_DIR, { recursive: true })

const HOST = process.env.HOST || '0.0.0.0'

app.listen(PORT, HOST, () => {
  console.log(`[flow-player] API 代理已启动: http://${HOST}:${PORT}`)
  // 启动自检：把「默认对公网不安全」的组合显式喊出来
  if (!PROXY_TOKEN && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    console.warn(
      '[flow-player] 安全提示：未设置 PROXY_TOKEN 且监听 %s —— 任何能访问该端口的设备都可调用全部接口。' +
        '公网部署请设置 PROXY_TOKEN，或让反向代理做鉴权，并建议 HOST=127.0.0.1。',
      HOST
    )
  }
  if (ALLOW_PRIVATE_NETWORK) {
    console.warn(
      '[flow-player] 安全提示：ALLOW_PRIVATE_NETWORK=true，服务端可直连内网/云元数据地址（SSRF 防护关闭）。' +
        '仅在你确实需要局域网/IPTV 直连时保持开启。'
    )
  }
})
