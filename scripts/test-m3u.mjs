import assert from 'node:assert/strict'
import { parseM3u } from '../src/lib/m3u.js'

const content = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="a" tvg-logo="http://x/logo.png" group-title="体育",CCTV5 高清',
  'http://stream1/live.m3u8',
  '#EXTGRP:新闻',
  '#EXTINF:120 tvg-name="News",晚间新闻',
  'http://stream2/news.m3u8',
  'http://stream3/direct.mp4',
  'not-a-url',
  '#EXTINF:-1 group-title="音乐",纯音频',
  'https://audio.example/song.mp3'
].join('\n')

const result = parseM3u(content)

// 修复后：direct.mp4 仍在 #EXTGRP:新闻 上下文内，归属「新闻」而非「未分类」
assert.equal(result.count, 4)
assert.deepEqual(result.groups, ['体育', '新闻', '音乐'])

const [sports, news, mp4, audio] = result.channels
assert.equal(sports.name, 'CCTV5 高清')
assert.equal(sports.group, '体育')
assert.equal(sports.logo, 'http://x/logo.png')
assert.equal(sports.duration, -1)
assert.equal(news.name, '晚间新闻')
assert.equal(news.group, '新闻')
assert.equal(news.duration, 120)
assert.equal(mp4.name, 'direct.mp4')
assert.equal(mp4.group, '新闻')
assert.equal(mp4.valid, true)
assert.equal(audio.name, '纯音频')
assert.equal(audio.url, 'https://audio.example/song.mp3')

// 纯 URL 列表：无 EXTINF / EXTGRP，归「未分类」
const plain = parseM3u(['https://plain.example/one.m3u8', 'https://plain.example/two.mp4'].join('\n'))
assert.equal(plain.count, 2)
assert.deepEqual(plain.groups, ['未分类'])

// 回归 1：#EXTGRP 写在 #EXTINF 之后、URL 之前（部分生成器格式）
const extgrpAfterExtinf = parseM3u(
  [
    '#EXTM3U',
    '#EXTINF:-1,频道A',
    '#EXTGRP:体育',
    'http://a.m3u8',
    '#EXTINF:-1,频道B',
    '#EXTGRP:电影',
    'http://b.m3u8'
  ].join('\n')
)
assert.equal(extgrpAfterExtinf.count, 2)
assert.deepEqual(
  extgrpAfterExtinf.channels.map((c) => c.group),
  ['体育', '电影']
)

// 回归 2：同一 #EXTGRP 下连续多个 URL，分组不丢失
const multiUrlGroup = parseM3u(
  ['#EXTM3U', '#EXTGRP:纪录片', 'http://d1.m3u8', 'http://d2.m3u8', 'http://d3.mp4'].join('\n')
)
assert.equal(multiUrlGroup.count, 3)
assert.deepEqual(
  multiUrlGroup.channels.map((c) => c.group),
  ['纪录片', '纪录片', '纪录片']
)

// 回归 3：EXTINF 的 group-title 优先于 #EXTGRP
const groupTitlePriority = parseM3u(
  ['#EXTM3U', '#EXTGRP:体育', '#EXTINF:-1 group-title="新闻",频道X', 'http://x.m3u8'].join('\n')
)
assert.equal(groupTitlePriority.channels[0].group, '新闻')

// 回归 4：无 EXTINF、无 EXTGRP 的裸 URL 归「未分类」
const bare = parseM3u(['#EXTM3U', 'https://bare.example/one.m3u8'].join('\n'))
assert.equal(bare.channels[0].group, '未分类')

console.log('m3u parser tests passed')
