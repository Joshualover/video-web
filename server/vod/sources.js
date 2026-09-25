// 影视源管理：
//  1) 配置地址来自 data/vod-configs.json（可在「源管理」页增删改、分组、启停）
//  2) 逐个拉取 TVBox/影视仓 配置，解析出 type===1 的「苹果 CMS」站点
//     （type=3 的 csp_ 蜘蛛源依赖 TVBox 内核，Web 端用不了，直接跳过；
//       部分订阅平台把同样是 http 接口的苹果 CMS 统一标成 type=4，也一并收下）
//  3) 与内置兜底源合并、去重；带 TTL 缓存 + 健康检查缓存
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { httpGetText, parseJsonLoose } from './maccms.js'
import { listConfigs } from './config-store.js'
import { disabledSourceIds } from './source-prefs.js'
import { HGD_SITE, HGD_CATEGORIES } from './hgdju.js'
import { VIDHUB_SITE } from './vidhub.js'
import { loadCategories } from './query.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FALLBACK_FILE = path.join(__dirname, 'fallback-sources.json')

// 内置短剧源（黄瓜短剧，走专用适配器；不是苹果 CMS 接口）
export const HGD_SOURCE = {
  id: 'hgdju',
  name: '黄瓜短剧',
  api: HGD_SITE,
  from: '内置',
  group: '短剧',
  kind: 'hgdju',
  configId: ''
}

// 内置影视站（vidhub.tv，苹果 CMS 模板站但采集接口关闭，走页面适配器）
export const VIDHUB_SOURCE = {
  id: 'vidhub',
  name: 'Vidhub 影视',
  api: VIDHUB_SITE,
  from: '内置',
  group: '影视站',
  kind: 'vidhub',
  configId: ''
}

const SOURCES_TTL = 6 * 60 * 60 * 1000
const HEALTH_TTL = 10 * 60 * 1000
const HEALTH_TTL_FAIL = 30 * 60 * 1000 // 失败源退避：避免频繁重试已失效的源
const CONFIG_TIMEOUT = 6000
const MAX_SUB_CONFIGS = 12

let sourcesCache = null // { at, sources }
let loadPromise = null
const configStatus = new Map() // configId -> { at, sources, error, count }
const health = new Map() // id -> { ok, at, latency, classes, error }

export function siteId(api) {
  return crypto.createHash('sha1').update(api).digest('hex').slice(0, 12)
}

function normalizeApi(api) {
  try {
    const u = new URL(String(api).trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}

function dedupeKey(api) {
  try {
    const u = new URL(api)
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return api
  }
}

function cleanName(name, api) {
  let n = String(name || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[┃│|｜]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!n) {
    try {
      n = new URL(api).host
    } catch {
      n = '未知源'
    }
  }
  return n.slice(0, 24)
}

async function loadFallback() {
  try {
    const text = await readFile(FALLBACK_FILE, 'utf8')
    const arr = JSON.parse(text)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

// 伪协议 api（蜘蛛/JS 源）需要 TVBox 内核，Web 端用不了
const SPIDER_API_RE = /^(csp_|js:|file:|assets:|clan:|mitv:|push:)/i

// 是否是 Web 端可用的苹果 CMS 站点：type=1 是标准苹果 CMS；type=4 里 api 直接给 http 接口的同样是 CMS（部分订阅平台统一标 4）
function isCmsSite(site) {
  const type = Number(site?.type)
  if (type !== 1 && type !== 4) return false
  return !SPIDER_API_RE.test(String(site?.api ?? '').trim())
}

// 解析单个配置 JSON 文本，返回站点列表
function parseConfigSites(text, meta) {
  let data
  try {
    data = parseJsonLoose(text)
  } catch {
    return []
  }
  const sites = Array.isArray(data?.sites) ? data.sites : []
  const out = []
  for (const site of sites) {
    if (!isCmsSite(site)) continue
    const api = normalizeApi(site?.api)
    if (!api) continue
    out.push({
      name: cleanName(site?.name, api),
      api,
      from: meta.name,
      group: meta.group || '默认配置',
      configId: meta.id || ''
    })
  }
  return out
}

// 拉取一个配置（支持多仓 urls 嵌套一层）
async function fetchConfigSources(config) {
  const collected = []
  const visit = async (url, name, depth) => {
    const text = await httpGetText(url, { timeout: CONFIG_TIMEOUT })
    let parsed = null
    try {
      parsed = parseJsonLoose(text)
    } catch {
      parsed = null
    }
    if (parsed && Array.isArray(parsed.sites)) {
      collected.push(...parseConfigSites(text, { id: config.id, name, group: config.group }))
      return
    }
    // 多仓：{ urls: [{name,url}] } 或 { urls: ["..."] }
    const subUrls = Array.isArray(parsed?.urls) ? parsed.urls : []
    if (!subUrls.length || depth > 1) return
    const subs = subUrls
      .slice(0, MAX_SUB_CONFIGS)
      .map((item) => (typeof item === 'string' ? { url: item } : item))
      .filter((item) => /^https?:\/\//i.test(String(item?.url || '')))
    const results = await Promise.allSettled(
      subs.map((sub) => visit(String(sub.url), String(sub.name || name).slice(0, 24), depth + 1))
    )
    void results
  }
  await visit(config.url, config.name, 0)
  return collected
}

async function buildSources({ force = false, onlyConfigId = null } = {}) {
  const configs = await listConfigs()
  const targets = configs.filter(
    (c) => c.enabled !== false && (!onlyConfigId || c.id === onlyConfigId)
  )

  const fromConfigs = []
  await Promise.all(
    targets.map(async (config) => {
      const cached = configStatus.get(config.id)
      const fresh = cached && Date.now() - cached.at < SOURCES_TTL
      if (fresh && (!force || (onlyConfigId && config.id !== onlyConfigId))) {
        fromConfigs.push(...cached.sources)
        return
      }
      try {
        const sources = await fetchConfigSources(config)
        configStatus.set(config.id, {
          at: Date.now(),
          sources,
          error: '',
          count: sources.length
        })
        fromConfigs.push(...sources)
      } catch (err) {
        configStatus.set(config.id, {
          at: Date.now(),
          sources: [],
          error: err?.message || '拉取失败',
          count: 0
        })
      }
    })
  )

  const collected = [...fromConfigs]
  for (const item of await loadFallback()) {
    const api = normalizeApi(item.api)
    if (api) collected.push({ name: cleanName(item.name, api), api, from: '内置', group: '内置', configId: '' })
  }
  // 内置适配器源固定挂在内置兜底源后面
  collected.push({ ...HGD_SOURCE }, { ...VIDHUB_SOURCE })

  const seen = new Map()
  for (const item of collected) {
    const key = dedupeKey(item.api)
    if (seen.has(key)) continue
    seen.set(key, {
      id: item.id || siteId(item.api),
      name: item.name,
      api: item.api,
      from: item.from,
      group: item.group || '默认配置',
      kind: item.kind || 'maccms',
      configId: item.configId || ''
    })
  }
  return [...seen.values()]
}

// 带上源级启停状态（不写回缓存，停用表改了立即生效）
async function withPrefs(sources) {
  const disabled = await disabledSourceIds()
  if (!disabled.size) return sources.map((s) => ({ ...s, enabled: true }))
  return sources.map((s) => ({ ...s, enabled: !disabled.has(s.id) }))
}

// 参与聚合搜索/选路的源（已停用的不参与）
export function activeSources(sources) {
  return sources.filter((s) => s.enabled !== false)
}

// 源排序：可用优先 → 已知延迟小的优先 → 其余保持原顺序（保证顺序稳定）
export function rankSources(sources) {
  const weight = (s) => (s.status === 'ok' ? 0 : s.status === 'unknown' ? 1 : 2)
  const latency = (s) => (Number(s.latency) > 0 ? Number(s.latency) : 99999)
  return [...sources].sort((a, b) => {
    const wa = weight(a)
    const wb = weight(b)
    if (wa !== wb) return wa - wb
    return latency(a) - latency(b)
  })
}

export async function getSources({ refresh = false, configId = null } = {}) {
  if (!refresh && !configId && sourcesCache && Date.now() - sourcesCache.at < SOURCES_TTL) {
    return withPrefs(sourcesCache.sources)
  }
  if (!loadPromise) {
    loadPromise = buildSources({ force: refresh, onlyConfigId: configId })
      .then((sources) => {
        sourcesCache = { at: Date.now(), sources }
        return sources
      })
      .finally(() => {
        loadPromise = null
      })
  }
  return withPrefs(await loadPromise)
}

// 清理缓存（增删改配置后调用）
export function invalidateSources({ configId = null, clearStatus = false } = {}) {
  sourcesCache = null
  if (configId) configStatus.delete(configId)
  if (clearStatus) configStatus.clear()
}

// 重新抓取配置并重建聚合源列表
export async function refreshConfigs(configId = null) {
  if (configId) configStatus.delete(configId)
  else configStatus.clear()
  sourcesCache = null
  await buildSources({ force: true, onlyConfigId: configId })
  const sources = await buildSources({ force: false })
  sourcesCache = { at: Date.now(), sources }
  return sources
}

// 单个配置的解析状态（供「源管理」页展示）
export function getConfigStatus(id) {
  const item = configStatus.get(id)
  if (!item) return { status: 'unknown' }
  return {
    status: item.error ? 'fail' : 'ok',
    count: item.count || 0,
    error: item.error || '',
    checkedAt: item.at
  }
}

export async function resolveSource(id) {
  const sources = await getSources()
  return sources.find((s) => s.id === id) || null
}

export function getHealth(id) {
  const h = health.get(id)
  if (!h) return { status: 'unknown' }
  const ttl = h.ok ? HEALTH_TTL : HEALTH_TTL_FAIL
  if (Date.now() - h.at > ttl) return { status: 'unknown', stale: true }
  return h.ok
    ? { status: 'ok', latency: h.latency, classes: h.classes, checkedAt: h.at }
    : { status: 'fail', error: h.error, checkedAt: h.at }
}

export async function checkSource(source, timeout = 4500) {
  const started = Date.now()
  try {
    const { classes } = await loadCategories(source, { timeout })
    const latency = Date.now() - started
    if (!classes.length) throw new Error('接口无分类数据')
    health.set(source.id, { ok: true, at: Date.now(), latency, classes: classes.length })
    return { id: source.id, status: 'ok', latency, classes: classes.length }
  } catch (err) {
    const message = err?.message || '不可用'
    health.set(source.id, { ok: false, at: Date.now(), error: message })
    return { id: source.id, status: 'fail', error: message }
  }
}

export function hgdCategories() {
  return HGD_CATEGORIES.map((c) => ({ id: c.id, pid: '0', name: c.name }))
}

export function markHealth(id, ok, error = '') {
  if (ok) health.set(id, { ok: true, at: Date.now(), latency: 0, classes: health.get(id)?.classes || 0 })
  else health.set(id, { ok: false, at: Date.now(), error })
}

function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  return Promise.all(runners).then(() => results)
}

export { mapLimit }

export async function checkSources(sources, { deadline = 8000, concurrency = 8 } = {}) {
  const started = Date.now()
  return mapLimit(sources, concurrency, async (source) => {
    const remain = deadline - (Date.now() - started)
    if (remain <= 500) return { id: source.id, status: 'unknown' }
    const cached = getHealth(source.id)
    if (cached.status !== 'unknown') return { id: source.id, ...cached }
    return checkSource(source, Math.min(remain, 4500))
  })
}

export function sourcesWithHealth(sources) {
  return sources.map((s) => ({ ...s, ...getHealth(s.id) }))
}

// 按分组轮流取源：聚合搜索/选路只取前 N 个源，如果某个分组（例如新加的多仓订阅有 20 多个源）
// 把名额占满，其它分组的源就永远搜不到，所以这里按分组轮询，保证每个分组都有份。
export function spreadByGroup(sources, limit) {
  const buckets = new Map()
  for (const source of sources) {
    const key = source.group || '默认配置'
    const list = buckets.get(key)
    if (list) list.push(source)
    else buckets.set(key, [source])
  }
  const lists = [...buckets.values()]
  const out = []
  for (let round = 0; out.length < limit; round += 1) {
    let added = false
    for (const list of lists) {
      if (round >= list.length) continue
      out.push(list[round])
      added = true
      if (out.length >= limit) break
    }
    if (!added) break
  }
  return out
}
