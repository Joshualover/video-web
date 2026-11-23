// GD音乐台音源 + 歌词解析的单元测试（离线，不访问网络）
//
// 覆盖三块最容易出错的纯逻辑：
//   1. 搜索结果的归一化（平台透传、pic_id → picId、url_id 优先）
//   2. 音质映射（语义档位 → 上游 br，以及降级顺序）
//   3. LRC 解析（多时间标签、元信息标签、毫秒/百分秒、按进度定位）
import assert from 'node:assert/strict'
import {
  kind,
  capabilities,
  QUALITY_LEVELS,
  normalizeQuality,
  qualityToBr,
  qualityLabel,
  describeBitrate,
  normalizeSearchItem
} from '../server/music/gdmusic.js'
import { parseLrc, activeLyricIndex, NO_LYRIC_TEXT } from '../src/lib/lyric.js'

// ─── 1. 适配器身份与音质映射 ────────────────────────────────────────────
assert.equal(kind, 'gdmusic')
assert.equal(capabilities.search, true)
assert.equal(capabilities.stream, true)
assert.equal(capabilities.lyric, true)
// 不走子进程，不该被当成「慢音源」对待（否则搜索会被拖进第二趟）
assert.equal(capabilities.slow, false)

assert.deepEqual(
  QUALITY_LEVELS.map((item) => item.value),
  ['128', '320', '740']
)
assert.equal(qualityToBr('128'), 128)
assert.equal(qualityToBr('320'), 320)
assert.equal(qualityToBr('740'), 740)
// 未知/空值退回默认档，不能把 undefined 传给上游
assert.equal(normalizeQuality(''), '320')
assert.equal(normalizeQuality('bad'), '320')
assert.equal(normalizeQuality('740'), '740')
assert.equal(qualityToBr('bad'), 320)
assert.equal(qualityLabel('740'), '无损 FLAC')

// 展示文案：无损要标 flac，普通档给真实 kbps
assert.equal(describeBitrate(320, 'mp3'), '320 kbps')
assert.match(describeBitrate(1497, 'flac'), /无损 FLAC/)
assert.match(describeBitrate(0, 'flac'), /无损 FLAC/)
assert.equal(describeBitrate(0, 'mp3'), '')

// ─── 2. 搜索结果归一化 ──────────────────────────────────────────────────
const raw = {
  id: '2668397359',
  name: '晴天',
  artist: ['RyaVocal'],
  album: '晴天',
  pic_id: '109951170413587092',
  url_id: '2668397359',
  lyric_id: '2668397359',
  source: 'netease'
}
const track = normalizeSearchItem(raw, 'netease')
assert.equal(track.id, '2668397359')
assert.equal(track.name, '晴天')
assert.deepEqual(track.artists, ['RyaVocal'])
assert.equal(track.platform, 'netease')
// pic 只有 pic_id 时要单独带下去，取流时再换真实地址
assert.equal(track.pic, '')
assert.equal(track.picId, '109951170413587092')

// joox 的 id 是 base64 风格字符串，含 +/= —— 不能被截断或转义
const joox = normalizeSearchItem(
  { id: 'x', url_id: 'bLnv0PqDX_qAlIqapc+Okw==', name: '晴天', artist: ['周杰倫'], source: 'joox' },
  'netease'
)
assert.equal(joox.id, 'bLnv0PqDX_qAlIqapc+Okw==')
// item.source 优先于入参 platform：搜索结果自己声明的平台才是准的
assert.equal(joox.platform, 'joox')
// 纯数字 pic 也能当 picId 用
assert.equal(joox.artists[0], '周杰倫')

// 缺 id / 缺曲名 的脏数据直接丢掉，别让前端拿到点不开的条目
assert.equal(normalizeSearchItem(null), null)
assert.equal(normalizeSearchItem({ url_id: '', name: 'x' }), null)
assert.equal(normalizeSearchItem({ url_id: '1', name: '' }), null)

// pic 已经是地址时原样保留，不再当 picId
const withPic = normalizeSearchItem(
  { url_id: '1', name: 'x', pic: 'https://p2.music.126.net/a.jpg' },
  'netease'
)
assert.equal(withPic.pic, 'https://p2.music.126.net/a.jpg')

// ─── 3. LRC 解析 ────────────────────────────────────────────────────────
const lrc = [
  '[ti:晴天]',
  '[ar:周杰伦]',
  '[00:02.15]你坐在窗边看云走散',
  '[00:05.90]我假装翻书心却慌乱',
  '[00:10.053]想说的话在嘴边打转',
  '[00:20.10][00:35.30]我不敢问',
  '[by:someone]'
].join('\n')

const lines = parseLrc(lrc)
// 元信息标签不能变成歌词行
assert.ok(!lines.some((line) => line.text.includes('晴天]')))
assert.equal(lines.length, 5)
// 时间升序
assert.deepEqual(
  lines.map((line) => line.time),
  [2.15, 5.9, 10.053, 20.1, 35.3]
)
// 一行多个时间标签要展开成多行
assert.equal(lines[3].text, '我不敢问')
assert.equal(lines[4].text, '我不敢问')

// 空输入 / 只有元信息 都返回空数组
assert.deepEqual(parseLrc(''), [])
assert.deepEqual(parseLrc('[ti:x]\n[ar:y]'), [])

// 内嵌逐字标签要清掉，否则界面上会出现 <00:12.50>
const inline = parseLrc('[00:01.00]<00:01.50>你<00:02.00>好')
assert.equal(inline.length, 1)
assert.equal(inline[0].text, '你好')

// 按进度定位：还没到第一句时 -1，到了就落到对应行
assert.equal(activeLyricIndex(lines, 0), -1)
assert.equal(activeLyricIndex(lines, 3), 0)
assert.equal(activeLyricIndex(lines, 6), 1)
assert.equal(activeLyricIndex(lines, 21), 3)
// 超过最后一句仍停在最后一行
assert.equal(activeLyricIndex(lines, 999), 4)
// 空歌词不能崩
assert.equal(activeLyricIndex([], 10), -1)
assert.equal(activeLyricIndex(null, 10), -1)

assert.equal(NO_LYRIC_TEXT, '暂无歌词')

console.log('gdmusic source tests passed')
