// server/vod/subscription-parser.js 的单元测试（纯解析，不触网）
import assert from 'node:assert/strict'
import {
  normalizeUrl,
  parseSubscriptionJson,
  parseSubscriptionPayload,
  isTvboxPayload,
  isSourceCatalogPayload,
  describeParseStats,
  MAX_VOD_SOURCES
} from '../server/vod/subscription-parser.js'

// ---- URL 归一化 ----
assert.equal(normalizeUrl('  https://a.com/api.php/provide/vod/  '), 'https://a.com/api.php/provide/vod')
assert.equal(normalizeUrl('https://a.com?'), 'https://a.com')
assert.equal(normalizeUrl('https://a.com/#'), 'https://a.com')
assert.equal(normalizeUrl('http://a.com/p/'), 'http://a.com/p')
assert.equal(normalizeUrl('ftp://a.com/x'), '') // 非 http(s) 拒绝
assert.equal(normalizeUrl('a.com/x', true), 'https://a.com/x') // 裸域名补协议
assert.equal(normalizeUrl('a.com/x'), '') // 不要求协议时裸域名拒绝
assert.equal(normalizeUrl('js:https://x/y.js'), '') // 伪协议不是 http 开头？——js: 不是 http(s)，拒绝

// ---- 宽容 JSON（fastjson 痕迹）----
{
  const withComments = `{
    // 行注释
    "sites": [ { "name": "A", "api": "https://a.com/api.php/provide/vod", "type": 1 } ], // 尾逗号在下行
  }`
  const data = parseSubscriptionJson(withComments)
  assert.equal(data.sites.length, 1)
}
{
  // 块注释 + 字符串里的 // 不受影响
  const data = parseSubscriptionJson(`{"url": "https://a.com//x" /* 块 */ ,}`)
  assert.equal(data.url, 'https://a.com//x')
}
{
  // 字符串里的裸换行转义
  const data = parseSubscriptionJson('{"a": "line1\nline2"}')
  assert.equal(data.a, 'line1\nline2')
}
assert.throws(() => parseSubscriptionJson('not json at all'), /不是合法的 JSON/)

// ---- TVBox 配置 ----
{
  const payload = parseSubscriptionPayload(JSON.stringify({
    name: '测试订阅',
    sites: [
      { name: 'CMS一', type: 1, api: 'https://a.com/api.php/provide/vod' },
      { name: 'CMS四', type: 4, api: 'https://b.com/api.php/provide/vod/' },
      { name: '蜘蛛', type: 3, api: 'csp_Douban' },
      { name: 'JS资源', type: 1, api: 'https://c.com/x.js' },
      { name: 'XML接口', type: 0, api: 'https://d.com/x.xml' },
      { name: '省略type的CMS', api: 'https://e.com/api.php/provide/vod/at/json' },
      { name: '重复的CMS一', type: 1, api: 'https://a.com/api.php/provide/vod' }
    ],
    lives: [
      { name: '直播A', type: 0, url: 'https://live.com/a.m3u8' },
      { name: '直播txt', type: 0, url: 'https://live.com/b.txt' },
      { name: '直播单仓', type: 1, url: 'https://live.com/c.json' },
      { name: '直播带EPG', type: 0, url: 'https://live.com/d.m3u8', epg: 'https://epg.com/x.xml' }
    ]
  }))
  assert.equal(payload.stats.format, 'tvbox')
  // 导入：CMS一、CMS四、省略type但命中CMS特征 = 3 条；重复被去重
  assert.deepEqual(payload.sources.map((s) => s.name), ['CMS一', 'CMS四', '省略type的CMS'])
  // 但「JS资源」是 type=1 且 api 命中 .js —— spider 类
  assert.ok(payload.stats.skippedByReason.spider >= 2)
  assert.equal(payload.stats.skippedByReason.xml, 1)
  assert.equal(payload.liveSources.length, 2)
  assert.equal(payload.liveSources[1].epg, 'https://epg.com/x.xml')
  assert.ok(payload.stats.skippedByReason.nonM3uLive === 2)
}

// ---- 接口目录（source-catalog）----
{
  const payload = parseSubscriptionPayload(JSON.stringify([
    { name: '目录A', baseUrl: 'a.com/provide/vod' },
    { name: '停用B', baseUrl: 'https://b.com/api.php/provide/vod', enabled: false },
    { name: '坏条目', baseUrl: '' }
  ]))
  assert.equal(payload.stats.format, 'source-catalog')
  assert.deepEqual(payload.sources.map((s) => s.name), ['目录A'])
  assert.equal(payload.stats.skippedByReason.disabled, 1)
  assert.equal(payload.stats.skippedByReason.invalidUrl, 1)
}

// ---- LibreTV-SourceList 对象与裸数组 ----
{
  const obj = parseSubscriptionPayload(JSON.stringify({
    name: '我的列表',
    sources: [{ name: 'S1', url: 'https://s1.com/api.php/provide/vod' }],
    liveSources: [{ name: 'L1', url: 'https://l1.com/a.m3u8', epg: 'https://e/x' }]
  }))
  assert.equal(obj.stats.format, 'libretv')
  assert.equal(obj.name, '我的列表')
  assert.equal(obj.sources.length, 1)
  assert.equal(obj.liveSources[0].epg, 'https://e/x')

  const bare = parseSubscriptionPayload(JSON.stringify([
    { name: 'S2', url: 'https://s2.com/api.php/provide/vod' }
  ]))
  assert.equal(bare.stats.format, 'libretv')
  assert.equal(bare.sources.length, 1)
}

// ---- 混用 baseUrl 与 url：必须报错，绝不静默丢一半 ----
assert.throws(
  () => parseSubscriptionPayload(JSON.stringify([{ baseUrl: 'https://a.com/x' }, { url: 'https://b.com/y' }])),
  /混用/
)

// ---- 不认识的格式：明确报错而不是返回空 ----
assert.throws(() => parseSubscriptionPayload('{"foo": 1}'), /不认识/)

// ---- 上限截断计入 stats ----
{
  const many = Array.from({ length: MAX_VOD_SOURCES + 10 }, (_, i) => ({
    name: `S${i}`,
    url: `https://s${i}.com/api.php/provide/vod`
  }))
  const payload = parseSubscriptionPayload(JSON.stringify(many))
  assert.equal(payload.sources.length, MAX_VOD_SOURCES)
  assert.equal(payload.stats.truncated, 10)
}

// ---- 判别函数 ----
assert.equal(isTvboxPayload({ sites: [] }), true)
assert.equal(isTvboxPayload({ sources: [] }), false)
assert.equal(isSourceCatalogPayload([{ baseUrl: 'x' }]), true)
assert.equal(isSourceCatalogPayload([{ url: 'x' }]), false)

// ---- 人话统计 ----
assert.match(
  describeParseStats({ skipped: 3, skippedByReason: { spider: 2, xml: 1 }, truncated: 0 }),
  /已跳过 3 项.*2.*1/
)
assert.match(describeParseStats({ skipped: 0, skippedByReason: {}, truncated: 5 }), /截断 5/)

console.log('subscription parser: all assertions passed')
