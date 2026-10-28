// server/vod/title-match.js 的单元测试（node:assert 裸脚本，风格同 test-hls.mjs）
import assert from 'node:assert/strict'
import { normalizeForMatch, isRelevant, filterRelevantResults, titleMatch } from '../server/vod/title-match.js'

// ---- 归一化 ----
assert.equal(normalizeForMatch('《A》-b!'), 'ab')
assert.equal(normalizeForMatch(' 中文 · 测试 '), '中文测试')
assert.equal(normalizeForMatch('【影视解说】'), '影视解说')
assert.equal(normalizeForMatch(''), '')

// ---- 基础相关性：全词命中、多词都要命中 ----
assert.equal(isRelevant('庆余年 第一季', '庆余年'), true)
assert.equal(isRelevant('庆余年 第一季', '庆余年 第一季'), true)
assert.equal(isRelevant('庆余年', '庆余年 第一季'), false) // 多词查询要求每个词都命中
assert.equal(isRelevant('庆余年第二季', '第二季 庆余年'), true) // 词序无关
assert.equal(isRelevant('三个字', '咒术回战'), false) // 不相关就丢弃
assert.equal(isRelevant('《繁花》', '繁花'), true) // 标点不影响
assert.equal(isRelevant('繁花', '  '), true) // 空查询放行

// ---- 季数别名：查询「A2」 ↔ 标题「A 第二季」 ----
assert.equal(isRelevant('庆余年 第二季', '庆余年2'), true)
assert.equal(isRelevant('庆余年第二季', '庆余年 2'), true)
assert.equal(isRelevant('庆余年2', '庆余年 第二季'), true) // 查询点名季数时，标题裸数字「庆余年2」认作同名同季
assert.equal(isRelevant('庆余年 第二季 粤语', '庆余年 第二季'), true) // 标题侧显式季数允许附注
assert.equal(isRelevant('庆余年12', '庆余年2'), false) // 数字必须完整命中
assert.equal(isRelevant('庆余年20', '庆余年2'), false)
assert.equal(isRelevant('庆余年 第一季', '庆余年2'), false) // 季数不同不匹配
assert.equal(isRelevant('某某电影2', '某某电影 第二季'), true) // 有意放宽：基数名完整命中+数字等于显式季数
// （聚合器场景漏掉一个正源比多留一条近似结果代价高；不放宽则「庆余年2」这类标题会被误杀）

// 中文数字季数
assert.equal(isRelevant('庆余年 第十季', '庆余年10'), true)
assert.equal(isRelevant('庆余年 第二季', '庆余年2'), true)
assert.equal(isRelevant('庆余年 第二十季', '庆余年20'), true)
assert.equal(isRelevant('庆余年 第二季 粤语', '庆余年 第二季'), true)

// 四位年份不当季数
assert.equal(isRelevant('影片 2024', '影片2'), false)

// ---- 批量过滤 ----
{
  const list = [{ name: '庆余年 第一季' }, { name: '无关影片' }, { name: '庆余年2' }]
  const out = filterRelevantResults(list, '庆余年')
  assert.deepEqual(out.map((x) => x.name), ['庆余年 第一季', '庆余年2'])
  assert.deepEqual(filterRelevantResults(list, '查无此片'), [])
  assert.deepEqual(filterRelevantResults(null, 'x'), [])
}

// ---- 选线同名（双向子串 + 季数规则）----
assert.equal(titleMatch('庆余年', '庆余年'), true)
assert.equal(titleMatch('庆余年 第一季', '庆余年'), true) // 结果名比查询长也可以
assert.equal(titleMatch('庆余年', '庆余年 第一季'), true) // 反方向同理
assert.equal(titleMatch('庆余年 第二季', '庆余年2'), true)
assert.equal(titleMatch('庆余年1', '庆余年2'), false)
assert.equal(titleMatch('', '庆余年'), false)
assert.equal(titleMatch('x', ''), false)

console.log('title-match: all assertions passed')
