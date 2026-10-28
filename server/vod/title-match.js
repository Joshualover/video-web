// 片名匹配（搜索相关性 + 选线同名判定）——思路参考 LibreTV 的 cms-parser，按其语义重写。
//
// 要解决的实际问题：
//  1) 聚合搜索把源站返回的原始目录直接当结果：搜「咒术回战」会出现一堆
//     名称里根本不包含该词的影片（部分 CMS 的 wd 检索是模糊全库、或按推荐位凑数）。
//  2) 用户习惯「庆余年2」这种无空格写法，而采集站标题多是「庆余年 第二季」；
//     纯子串匹配两边都对不上，好源被当成不相关丢掉。
//  3) best.js 的选线匹配只做小写+去常见标点，标题带【影视解说】、全角符号等
//     噪声时匹配失败。
//
// 规则：
//  - 归一化去掉空白与全部标点/符号（Unicode 类别），比逐字符枚举覆盖面广；
//  - 多词查询要求每个词都命中（「庆余年 第一季」= 庆余年 ∧ 第一季）；
//  - 末尾独立数字可当季数别名：查询侧「A2」↔ 标题侧「A 第二季」；
//    但标题侧的裸数字必须前有空格（避免把片名自带的「电影2」误判成第二季），
//    查询侧允许无空格（迁就用户输入习惯）；
//  - 数字别名要求完整命中：第 2 季不能匹配「第12集」「20」这类数字的一部分；
//  - 年份形态（四位数字）不作为季数。

const DIGITS = '零一二三四五六七八九'

// 归一化：小写 + 去掉所有空白与标点/符号（Unicode \p{P} \p{S}）
export function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

// 解析「季数后缀」：显式「第N季」或（按侧规则）末尾独立数字。
// 返回 { base, season, explicit }；解析不出返回 undefined。
// allowAnnotations：标题侧允许「第二季粤语」「第二季【解说】」等附注
// bareNeedsSpace：裸数字两侧是否要求前置空格（查询侧 false，标题侧 true）
function parseSeasonSuffix(title, allowAnnotations = false, bareNeedsSpace = true) {
  const trimmed = String(title || '').trim()
  const explicitPattern = allowAnnotations
    ? /^(.*?)\s*第\s*([1-9]\d?|[一二两三四五六七八九十]{1,3})\s*季.*$/u
    : /^(.*?)\s*第\s*([1-9]\d?|[一二两三四五六七八九十]{1,3})\s*季$/u
  const barePattern = bareNeedsSpace ? /^(.*?)\s+([1-9]\d?)$/u : /^(.*?)\s*([1-9]\d?)$/u
  const match = trimmed.match(explicitPattern) || trimmed.match(barePattern)
  if (!match || !normalizeForMatch(match[1])) return undefined

  const value = match[2]
  let season = Number(value)
  if (!Number.isFinite(season)) {
    const chinese = value.replace('两', '二')
    if (/^[一二三四五六七八九]$/u.test(chinese)) {
      season = DIGITS.indexOf(chinese)
    } else if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/u.test(chinese)) {
      const [tens, units] = chinese.split('十')
      season = (tens ? DIGITS.indexOf(tens) : 1) * 10 + (units ? DIGITS.indexOf(units) : 0)
    }
  }
  if (!Number.isFinite(season) || season < 1) return undefined
  return { base: match[1], season, explicit: Boolean(trimmed.match(explicitPattern)) }
}

// 关键词命中，但数字必须完整命中：搜「庆余年2」不匹配「庆余年12」。
// 判定方式：命中的数字片段左右不得再邻接其他数字。
function includesKeyword(title, keyword) {
  if (!title || !keyword) return false
  let index = title.indexOf(keyword)
  while (index >= 0) {
    const before = title[index - 1] ?? ''
    const after = title[index + keyword.length] ?? ''
    const digitKeyword = /^\d/.test(keyword)
    const digitTail = /\d$/.test(keyword)
    if ((!digitKeyword || !/\d/.test(before)) && (!digitTail || !/\d$/.test(after))) return true
    index = title.indexOf(keyword, index + 1)
  }
  return false
}

// 查询解析一次、结果复用于整批过滤（一次搜索要对几百条结果判相关）
function prepareQuery(wd) {
  const raw = String(wd || '').trim()
  const normalized = normalizeForMatch(raw)
  if (!normalized) return undefined
  return {
    normalized,
    // 查询侧允许「庆余年2」这种数字前无空格的写法
    season: parseSeasonSuffix(raw, false, false),
    tokens: raw.split(/\s+/).map(normalizeForMatch).filter(Boolean)
  }
}

function matchesPrepared(name, query) {
  if (includesKeyword(name, query.normalized)) return true
  return query.tokens.length > 1 && query.tokens.every((token) => includesKeyword(name, token))
}

function isRelevantPrepared(name, query) {
  const nName = normalizeForMatch(name)
  if (!nName) return false
  // 标题侧默认要求裸数字前有空格（防「电影2」被误判成第二季）；
  // 但当查询是显式「第N季」时，目标本身就是集数，采集站标题的常见形态恰恰是
  // 「庆余年2」这种不带空格的写法——此时放行无空格数字，否则搜「庆余年 第二季」
  // 会漏掉所有写成「庆余年2」的源。数字仍需完整命中（2 不匹配 12/20）。
  const titleSeason =
    parseSeasonSuffix(name, true, true) ??
    (query.season?.explicit ? parseSeasonSuffix(name, true, false) : undefined)
  if (query.season && titleSeason) {
    if (query.season.season !== titleSeason.season) return false
    if (query.season.explicit || titleSeason.explicit) {
      const baseQuery = prepareQuery(query.season.base)
      if (baseQuery) return matchesPrepared(normalizeForMatch(titleSeason.base), baseQuery)
    }
  }
  return matchesPrepared(nName, query)
}

// 单条判定：影片名 name 是否与查询 wd 相关。空查询视为全放行。
export function isRelevant(name, wd) {
  const query = prepareQuery(wd)
  if (!query) return true
  return isRelevantPrepared(String(name || ''), query)
}

// 批量过滤：全不相关时返回空数组——绝不能把源站的原始目录当搜索结果回给用户。
export function filterRelevantResults(list, wd) {
  const query = prepareQuery(wd)
  if (!query) return Array.isArray(list) ? list : []
  if (!Array.isArray(list)) return []
  return list.filter((item) => item && isRelevantPrepared(String(item.name || ''), query))
}

// 选线用「同名」判定：与搜索相关性同语义，但方向上允许
// 「查询是结果名的一部分」（详情接口给出的片名可能比搜索词长/带副标题）。
// 原 best.js 的 titleMatch 就是归一化后互为子串；这里在其基础上补季数规则。
export function titleMatch(a, b) {
  const qa = prepareQuery(String(a || ''))
  const qb = prepareQuery(String(b || ''))
  if (!qa || !qb) return false
  if (isRelevantPrepared(String(b || ''), qa)) return true
  return isRelevantPrepared(String(a || ''), qb)
}
