// 订阅解析（参考 LibreTV 的 tvbox-parser / source-list 语义重写，AGPL 不复制代码）。
// 一个订阅入口兼容三种格式，自动识别：
//  1) TVBox 配置：顶层含 sites / lives 数组 —— 只导入 Web 端可用的「直连类」条目：
//     点播 type=1/4 的苹果 CMS 接口（csp_/js: 等伪协议跳过），直播 type=0/省略的 M3U；
//  2) LibreTV-SourceList：{ name?, sources:[{name,url}], liveSources:[{name,url,epg?}] }，
//     也接受裸数组 [{name,url}]；
//  3) 接口目录：裸数组 [{ name?, baseUrl, enabled? }]，全部条目带 baseUrl 才按目录处理。
// 混用 baseUrl 与 url 两种字段的裸数组直接报错——静默丢一半都是无声的数据损失。
//
// 本模块只做字段裁剪、去重与上限控制；出网与 SSRF 校验由调用方负责。
// 跳过与截断都计入 stats：「配置里 200 条只导入 120 条」必须能解释。

export const MAX_VOD_SOURCES = 100
export const MAX_LIVE_SOURCES = 50

/** 跳过原因（与展示文案解耦，前端按 key 自己拼） */
export const SKIP_REASONS = {
  spider: '需要 TVBox 引擎（csp_/jar/js/py）',
  xml: 'XML 接口（本站解析不了）',
  nonM3uLive: '非 M3U 直播（txt/单仓 JSON）',
  disabled: '发布者主动停用',
  invalidUrl: '地址不可用'
}

// Spider 特征：csp_ 前缀，或 jar / js / py 资源（含查询串）
const SPIDER_RE = /^csp_|\.(?:jar|js|py)(?:[?#].*)?$/i
// 任意伪协议前缀（py:/push:/custom:/oper:/open:/json: 等，冒号后不带 // 的都是 TVBox 引擎协议）
const PSEUDO_PROTOCOL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\/)/
const SPIDER_PREFIX_RE = /^(csp_|js:|file:|assets:|clan:|mitv:|push:)/i
// 相对/本地资源同样需要 TVBox 引擎
const LOCAL_ASSET_RE = /^\.{0,2}\//
// 苹果 CMS 直连接口特征：api.php/provide/vod，且排除 XML 通道（/at/xml）
const CMS_API_RE = /\/api\.php\/provide\/vod(?![^?#]*\/at\/xml)(?:[/?#]|$)/i
const M3U_RE = /\.m3u8?(?:[?#].*)?$/i
const TXT_RE = /\.txt(?:[?#].*)?$/i
const HTTP_RE = /^https?:\/\//i

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// URL 归一化：非 http(s) 一律拒绝；requireProtocol 时给裸域名补 https://。
// 去尾部空的 ?/# 与尾斜杠——同一订阅两种写法不该存成两条
// （https://host/ 会裁成 https://host；https://host/path/ 裁成 https://host/path）。
export function normalizeUrl(raw, requireProtocol = false) {
  let value = optionalString(raw)
  if (!value) return ''
  if (requireProtocol && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`
  if (!HTTP_RE.test(value)) return ''
  return value.replace(/[?#]+$/, '').replace(/(?<=\S)\/+$/, '')
}

// ---- 宽容 JSON：剥离字符串外的注释与尾随逗号（TVBox 配置常见的 fastjson 痕迹）----

function escapeControlChar(code) {
  if (code === 0x0a) return '\\n'
  if (code === 0x0d) return '\\r'
  if (code === 0x09) return '\\t'
  return `\\u${code.toString(16).padStart(4, '0')}`
}

export function stripJsonArtifacts(text) {
  const stripped = stripComments(String(text || '').replace(/^\uFEFF/, ''))
  return stripTrailingCommas(stripped)
}

function stripComments(text) {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (ch === '\n' || ch === '\r') {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false
        i += 1
      }
      continue
    }
    if (inString) {
      const code = ch.charCodeAt(0)
      if (code < 0x20) {
        out += escapeControlChar(code) // 字符串里的裸控制字符转成合法转义
        continue
      }
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 1
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      inLine = true
      i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      inBlock = true
      i += 1
      continue
    }
    out += ch
  }
  return out
}

function stripTrailingCommas(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 1
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j += 1
      if (text[j] === '}' || text[j] === ']') continue
    }
    out += ch
  }
  return out
}

export function parseSubscriptionJson(text) {
  const raw = String(text || '')
  // 先按标准 JSON 试：绝大多数订阅不需要动文本
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    // 再剥离 fastjson 痕迹重试
  }
  try {
    return JSON.parse(stripJsonArtifacts(raw))
  } catch {
    throw new Error('订阅内容不是合法的 JSON')
  }
}

// ---- 格式判别 ----

export function isTvboxPayload(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false
  return Array.isArray(json.sites) || Array.isArray(json.lives)
}

function isCatalogEntry(entry) {
  return !!entry && typeof entry === 'object' && !Array.isArray(entry) && 'baseUrl' in entry
}

export function isSourceCatalogPayload(json) {
  return Array.isArray(json) && json.length > 0 && json.every(isCatalogEntry)
}

function isMixedCatalogPayload(json) {
  return Array.isArray(json) && json.some(isCatalogEntry) && !json.every(isCatalogEntry)
}

// ---- 统一入口 ----

function emptyStats(format) {
  return { format, skipped: 0, skippedByReason: {}, truncated: 0 }
}

export function parseSubscriptionPayload(text) {
  let json
  try {
    json = parseSubscriptionJson(text)
  } catch {
    throw new Error('订阅内容不是合法的 JSON')
  }
  if (isTvboxPayload(json)) return parseTvboxPayload(json)
  if (isSourceCatalogPayload(json)) return parseCatalogPayload(json)
  if (isMixedCatalogPayload(json)) {
    throw new Error('订阅内容混用了 baseUrl 与 url 两种条目，请统一为一种格式（接口目录用 baseUrl，源列表用 url）')
  }
  return parseSourceListPayload(json)
}

// ---- 苹果 CMS 站点判别（与 sources.js 的 isCmsSite 同口径，type 缺失时按 URL 特征宽容识别）----

function classifySite(site) {
  const api = optionalString(site?.api)
  if (!api) return { ok: false, reason: 'invalidUrl' }
  // spider 特征先于 type 判定：部分配置给 js/py 资源也标 type=1
  if (SPIDER_PREFIX_RE.test(api) || LOCAL_ASSET_RE.test(api) || PSEUDO_PROTOCOL_RE.test(api)) {
    return { ok: false, reason: 'spider' }
  }
  if (SPIDER_RE.test(api)) return { ok: false, reason: 'spider' }
  const type = Number(site?.type)
  if (type === 1 || type === 4) {
    return { ok: true, url: api }
  }
  if (type === 0) return { ok: false, reason: 'xml' }
  if (type === 3) return { ok: false, reason: 'spider' }
  // type 缺失/为其他：命中苹果 CMS 特征才宽容导入
  if (CMS_API_RE.test(api)) return { ok: true, url: api }
  return { ok: false, reason: 'spider' }
}

function collectVod(rawSites, skipped, seen, sources) {
  for (const site of rawSites) {
    if (!site || typeof site !== 'object') {
      skipped.skipped += 1
      skipped.byReason.invalidUrl = (skipped.byReason.invalidUrl || 0) + 1
      continue
    }
    const verdict = classifySite(site)
    const name = optionalString(site.name)
    if (!verdict.ok) {
      skipped.skipped += 1
      skipped.byReason[verdict.reason] = (skipped.byReason[verdict.reason] || 0) + 1
      if (skipped.samples.length < 3) skipped.samples.push(name || verdict.reason)
      continue
    }
    const url = normalizeUrl(verdict.url)
    if (!url) {
      skipped.skipped += 1
      skipped.byReason.invalidUrl = (skipped.byReason.invalidUrl || 0) + 1
      continue
    }
    if (seen.has(url)) continue // 重复条目静默跳过
    if (sources.length >= MAX_VOD_SOURCES) {
      skipped.truncated += 1
      continue
    }
    seen.add(url)
    sources.push({ name: name || hostnameOf(url), url })
  }
}

function collectLive(rawLives, skipped, seen, liveSources) {
  for (const live of rawLives) {
    if (!live || typeof live !== 'object') {
      skipped.skipped += 1
      skipped.byReason.invalidUrl = (skipped.byReason.invalidUrl || 0) + 1
      continue
    }
    const type = Number(live.type)
    const url = normalizeUrl(live.url)
    const name = optionalString(live.name)
    if (!url || !HTTP_RE.test(url)) {
      skipped.skipped += 1
      skipped.byReason.invalidUrl = (skipped.byReason.invalidUrl || 0) + 1
      continue
    }
    // 只有 M3U 直播是本站可播的；txt/单仓 JSON 跳过
    if ((Number.isFinite(type) && type !== 0) || !M3U_RE.test(url)) {
      skipped.skipped += 1
      skipped.byReason.nonM3uLive = (skipped.byReason.nonM3uLive || 0) + 1
      if (skipped.samples.length < 3) skipped.samples.push(name || '直播源')
      continue
    }
    if (seen.has(url)) continue
    if (liveSources.length >= MAX_LIVE_SOURCES) {
      skipped.truncated += 1
      continue
    }
    seen.add(url)
    const epg = normalizeUrl(live.epg || '')
    liveSources.push({ name: name || hostnameOf(url), url, epg: epg || undefined })
  }
}

function parseTvboxPayload(json) {
  const skipped = { skipped: 0, byReason: {}, samples: [], truncated: 0 }
  const seenVod = new Set()
  const seenLive = new Set()
  const sources = []
  const liveSources = []
  collectVod(Array.isArray(json.sites) ? json.sites : [], skipped, seenVod, sources)
  collectLive(Array.isArray(json.lives) ? json.lives : [], skipped, seenLive, liveSources)
  return {
    name: optionalString(json.name),
    sources,
    liveSources,
    stats: finalizeStats('tvbox', skipped)
  }
}

function parseCatalogPayload(json) {
  const skipped = { skipped: 0, byReason: {}, samples: [], truncated: 0 }
  const seen = new Set()
  const sources = []
  for (const entry of json) {
    if (!entry || typeof entry !== 'object') {
      skipped.skipped += 1
      skipped.byReason.invalidUrl = (skipped.byReason.invalidUrl || 0) + 1
      continue
    }
    const name = optionalString(entry.name)
    if (entry.enabled === false) {
      skipped.skipped += 1
      skipped.byReason.disabled = (skipped.byReason.disabled || 0) + 1
      continue
    }
    const url = normalizeUrl(entry.baseUrl, true)
    if (!url) {
      skipped.skipped += 1
      skipped.byReason.invalidUrl = (skipped.byReason.invalidUrl || 0) + 1
      if (skipped.samples.length < 3) skipped.samples.push(name || '条目')
      continue
    }
    if (seen.has(url)) continue
    if (sources.length >= MAX_VOD_SOURCES) {
      skipped.truncated += 1
      continue
    }
    seen.add(url)
    sources.push({ name: name || hostnameOf(url), url })
  }
  return { sources, liveSources: [], stats: finalizeStats('source-catalog', skipped) }
}

function parseSourceListPayload(json) {
  // LibreTV-SourceList：{ name?, sources[], liveSources[] } 或裸数组 [{name,url}]
  const entries = Array.isArray(json) ? json : Array.isArray(json?.sources) ? json.sources : []
  if (!Array.isArray(json) && !Array.isArray(json?.sources) && !Array.isArray(json?.liveSources)) {
    throw new Error('订阅格式不认识：既不是 TVBox 配置，也没有 sources 列表')
  }
  const skipped = { skipped: 0, byReason: {}, samples: [], truncated: 0 }
  const seenVod = new Set()
  const sources = []
  for (const item of entries) {
    const name = optionalString(item?.name)
    const url = normalizeUrl(item?.url)
    if (!url) {
      skipped.skipped += 1
      skipped.byReason.invalidUrl = (skipped.byReason.invalidUrl || 0) + 1
      if (skipped.samples.length < 3) skipped.samples.push(name || '条目')
      continue
    }
    if (seenVod.has(url)) continue
    if (sources.length >= MAX_VOD_SOURCES) {
      skipped.truncated += 1
      continue
    }
    seenVod.add(url)
    sources.push({ name: name || hostnameOf(url), url })
  }
  const seenLive = new Set()
  const liveSources = []
  for (const item of Array.isArray(json?.liveSources) ? json.liveSources : []) {
    const name = optionalString(item?.name)
    const url = normalizeUrl(item?.url)
    if (!url || seenLive.has(url)) continue
    if (liveSources.length >= MAX_LIVE_SOURCES) {
      skipped.truncated += 1
      continue
    }
    seenLive.add(url)
    const epg = normalizeUrl(item?.epg || '')
    liveSources.push({ name: name || hostnameOf(url), url, epg: epg || undefined })
  }
  return {
    name: Array.isArray(json) ? undefined : optionalString(json?.name),
    sources,
    liveSources,
    stats: finalizeStats('libretv', skipped)
  }
}

function finalizeStats(format, s) {
  const stats = { format, skipped: s.skipped, skippedByReason: s.byReason, truncated: s.truncated }
  if (s.samples.length) stats.skippedSamples = s.samples
  return stats
}

// 把统计拼成一句人话（供错误提示/前端 toast）
export function describeParseStats(stats) {
  if (!stats) return ''
  const parts = []
  for (const [reason, count] of Object.entries(stats.skippedByReason || {})) {
    parts.push(`${SKIP_REASONS[reason] || reason} ${count}`)
  }
  let text = stats.skipped ? `已跳过 ${stats.skipped} 项${parts.length ? `（${parts.join('、')}）` : ''}` : ''
  if (stats.truncated) text += `${text ? '，' : ''}超出上限截断 ${stats.truncated} 项`
  return text
}
