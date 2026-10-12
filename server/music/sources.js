// 音乐源管理
//
// 与影视源（server/vod/sources.js）同构，但「源」的粒度不同：
// 影视源是从 TVBox 配置里解析出来的 CMS 接口；音乐源是「一条音源通路 + 一个实例地址」，
// 内置一批公开实例，用户也可以自己加 Piped / Invidious 实例。
//
//   - 内置实例：server/music/default-sources.json（随仓库更新）
//   - 自定义实例：data/music-sources.json（源管理页新增，持久化）
//   - 启停偏好：data/music-source-prefs.json（只记被停用的 id）
//
// 音源 kind 与 Spotube 的对应关系见各适配器文件头部注释。
import crypto from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPublicTarget } from '../proxy-core.js'
import * as piped from './piped.js'
import * as invidious from './invidious.js'
import * as jiosaavn from './jiosaavn.js'
import * as itunes from './itunes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../../data')
const CUSTOM_FILE = path.join(DATA_DIR, 'music-sources.json')
const PREFS_FILE = path.join(DATA_DIR, 'music-source-prefs.json')
const DEFAULTS_FILE = path.join(__dirname, 'default-sources.json')

const ADAPTERS = { piped, invidious, jiosaavn, itunes }
// 只有「实例型」音源允许用户自己加地址；jiosaavn / itunes 是固定官方接口
const ADDABLE_KINDS = ['piped', 'invidious']

const HEALTH_TTL_OK = 10 * 60 * 1000
const HEALTH_TTL_FAIL = 30 * 60 * 1000

const KIND_INFO = {
  piped: {
    label: 'Piped',
    group: 'YouTube',
    desc: 'Spotube 默认音源：YouTube 音频，经 Piped 实例取流（国内需配 VOD_HTTP_PROXY）'
  },
  invidious: {
    label: 'Invidious',
    group: 'YouTube',
    desc: 'YouTube 音频，经 Invidious 实例取流（国内需配 VOD_HTTP_PROXY）'
  },
  jiosaavn: {
    label: 'JioSaavn',
    group: 'JioSaavn',
    desc: 'Spotube 内置音源：JioSaavn，可直连、无需代理'
  },
  itunes: {
    label: 'Apple 试听',
    group: '试听',
    desc: '兜底音源：iTunes 30 秒试听片段，没有出网代理时也能出声'
  }
}

export function adapterFor(kind) {
  return ADAPTERS[String(kind || '')] || null
}

export function kindInfo(kind) {
  return KIND_INFO[String(kind || '')] || { label: String(kind || ''), group: '其它', desc: '' }
}

export function addableKinds() {
  return ADDABLE_KINDS.map((kind) => ({ kind, label: KIND_INFO[kind].label }))
}

// 源 id 取「kind:host」：稳定、可读，且换路径不会影响已存的启停偏好
export function sourceId(kind, api) {
  let host = String(api || '')
  try {
    host = new URL(api).hostname.toLowerCase()
  } catch {
    // 地址非法时退化成原文，交由校验环节报错
  }
  return `${kind}:${host}`
}

function normalizeApi(raw) {
  try {
    const url = new URL(String(raw || '').trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function cleanName(name, api) {
  const value = String(name || '').trim().slice(0, 30)
  if (value) return value
  try {
    return new URL(api).hostname
  } catch {
    return '未命名音源'
  }
}

let cache = null
let loadPromise = null
const health = new Map() // id -> { ok, at, latency, error, version }

async function readJson(file, fallback) {
  try {
    const text = await readFile(file, 'utf8')
    const data = JSON.parse(text)
    return data ?? fallback
  } catch {
    return fallback
  }
}

async function persist(file, data) {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(file, JSON.stringify(data, null, 2), 'utf8')
}

async function loadDefaults() {
  const list = await readJson(DEFAULTS_FILE, [])
  if (!Array.isArray(list)) return []
  return list
    .map((item) => {
      const api = normalizeApi(item?.api)
      const kind = String(item?.kind || '')
      if (!api || !ADAPTERS[kind]) return null
      return {
        id: sourceId(kind, api),
        kind,
        name: cleanName(item?.name, api),
        api,
        group: String(item?.group || '').trim() || kindInfo(kind).group,
        from: '内置',
        builtin: true
      }
    })
    .filter(Boolean)
}

async function loadCustom() {
  const list = await readJson(CUSTOM_FILE, [])
  if (!Array.isArray(list)) return []
  return list
    .map((item) => {
      const api = normalizeApi(item?.api)
      const kind = String(item?.kind || '')
      if (!api || !ADDABLE_KINDS.includes(kind)) return null
      return {
        id: sourceId(kind, api),
        kind,
        name: cleanName(item?.name, api),
        api,
        group: String(item?.group || '').trim() || kindInfo(kind).group,
        from: '自定义',
        builtin: false
      }
    })
    .filter(Boolean)
}

async function loadDisabled() {
  const data = await readJson(PREFS_FILE, { disabled: [] })
  const list = Array.isArray(data?.disabled) ? data.disabled : []
  return new Set(list.map(String).filter(Boolean))
}

// 内置 + 自定义，去重（同 id 保留先出现的），并挂上启停状态与健康状态
export async function getSources({ refresh = false } = {}) {
  if (!refresh && cache) return cache.map((item) => ({ ...item }))
  if (!refresh && loadPromise) return loadPromise
  const build = async () => {
    const [defaults, custom, disabled] = await Promise.all([
      loadDefaults(),
      loadCustom(),
      loadDisabled()
    ])
    const seen = new Set()
    const list = []
    for (const item of [...defaults, ...custom]) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      list.push({ ...item, enabled: !disabled.has(item.id) })
    }
    cache = list
    return list.map((item) => ({ ...item }))
  }
  loadPromise = build().finally(() => {
    loadPromise = null
  })
  return loadPromise
}

export function invalidateSources() {
  cache = null
}

export async function resolveSource(id) {
  const list = await getSources()
  return list.find((item) => item.id === String(id)) || null
}

export async function setSourceEnabled(id, enabled) {
  const disabled = await loadDisabled()
  const key = String(id)
  if (enabled) disabled.delete(key)
  else disabled.add(key)
  await persist(PREFS_FILE, { disabled: [...disabled].sort() })
  if (cache) {
    const hit = cache.find((item) => item.id === key)
    if (hit) hit.enabled = Boolean(enabled)
  }
  return Boolean(enabled)
}

export async function addSource({ kind, api, name }) {
  const cleanKind = String(kind || '').trim()
  if (!ADDABLE_KINDS.includes(cleanKind)) throw new Error('只支持新增 Piped / Invidious 实例')
  const cleanApi = normalizeApi(api)
  if (!cleanApi) throw new Error('实例地址需以 http/https 开头')
  // 地址会被服务端反复请求，落库前先过出网校验（否则等于把 SSRF 目标存下来）
  await assertPublicTarget(cleanApi)
  const list = await loadCustom()
  if (list.some((item) => item.api === cleanApi)) throw new Error('该实例地址已存在')
  const merged = [...(await getSources()), { kind: cleanKind, api: cleanApi }]
  if (merged.some((item) => item.id === sourceId(cleanKind, cleanApi) && item.api !== cleanApi)) {
    throw new Error('同主机下已存在另一个实例地址')
  }
  const item = {
    id: sourceId(cleanKind, cleanApi),
    kind: cleanKind,
    api: cleanApi,
    name: cleanName(name, cleanApi),
    group: kindInfo(cleanKind).group
  }
  list.push(item)
  await persist(CUSTOM_FILE, list)
  invalidateSources()
  return { ...item, from: '自定义', builtin: false, enabled: true }
}

export async function removeSource(id) {
  const list = await loadCustom()
  const next = list.filter((item) => item.id !== String(id))
  if (next.length === list.length) throw new Error('只能删除自定义音源')
  await persist(CUSTOM_FILE, next)
  invalidateSources()
  return true
}

export function markHealth(id, ok, { latency = 0, error = '', version = '' } = {}) {
  health.set(String(id), { ok: Boolean(ok), at: Date.now(), latency, error, version })
}

function healthOf(id) {
  const hit = health.get(String(id))
  if (!hit) return { status: 'unknown', latency: 0, error: '', version: '' }
  const ttl = hit.ok ? HEALTH_TTL_OK : HEALTH_TTL_FAIL
  if (Date.now() - hit.at > ttl) return { status: 'unknown', latency: 0, error: '', version: '' }
  return {
    status: hit.ok ? 'ok' : 'fail',
    latency: hit.latency || 0,
    error: hit.error || '',
    version: hit.version || ''
  }
}

export function sourcesWithHealth(list) {
  return list.map((item) => {
    const info = healthOf(item.id)
    return {
      ...item,
      desc: item.desc || kindInfo(item.kind).desc,
      status: info.status,
      latency: info.latency,
      error: info.error,
      version: info.version
    }
  })
}

// 参与搜索/播放的源（已停用的不参与）
export function activeSources(list) {
  return list.filter((item) => item.enabled !== false)
}

// 排序：可用优先 → 未知次之 → 已知失败最后；同档按延迟升序
export function rankSources(list) {
  const weight = (item) => (item.status === 'ok' ? 0 : item.status === 'unknown' ? 1 : 2)
  const latency = (item) => (Number(item.latency) > 0 ? Number(item.latency) : 99999)
  return [...list].sort((a, b) => {
    const diff = weight(a) - weight(b)
    if (diff !== 0) return diff
    return latency(a) - latency(b)
  })
}

// 按分组轮流取源：否则 8 个 Piped/Invidious 实例会把搜索名额吃光，
// JioSaavn、Apple 试听这类「单个源独占一个分组」的音源永远轮不到。
export function spreadByGroup(list, budget) {
  const groups = new Map()
  for (const item of list) {
    const key = item.group || kindInfo(item.kind).group
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  const buckets = [...groups.values()]
  const out = []
  let index = 0
  while (out.length < budget && buckets.some((bucket) => bucket.length > index)) {
    for (const bucket of buckets) {
      if (out.length >= budget) break
      if (bucket[index]) out.push(bucket[index])
    }
    index += 1
  }
  return out
}

// 单源健康检测
export async function checkSource(source) {
  const adapter = adapterFor(source?.kind)
  if (!adapter) {
    const result = { status: 'fail', latency: 0, error: '未知音源类型' }
    markHealth(source?.id, false, result)
    return result
  }
  const started = Date.now()
  try {
    const version = await adapter.check(source.api)
    const latency = Date.now() - started
    markHealth(source.id, true, { latency, version })
    return { status: 'ok', latency, error: '', version }
  } catch (err) {
    const latency = Date.now() - started
    const error = err?.message || '检测失败'
    markHealth(source.id, false, { latency, error })
    return { status: 'fail', latency, error, version: '' }
  }
}

// 并发健康检测，受总截止时间约束
export async function checkSources(list, { deadline = 10000, concurrency = 6 } = {}) {
  const queue = [...list]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift()
      if (!item) break
      await checkSource(item)
    }
  })
  await Promise.race([
    Promise.all(workers),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, deadline)
      if (typeof timer.unref === 'function') timer.unref()
    })
  ])
  return sourcesWithHealth(list)
}

export function hashId(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 12)
}
