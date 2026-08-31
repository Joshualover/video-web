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

assert.equal(result.count, 4)
assert.deepEqual(result.groups, ['体育', '新闻', '音乐', '未分类'])

const [sports, news, mp4, audio] = result.channels
assert.equal(sports.name, 'CCTV5 高清')
assert.equal(sports.group, '体育')
assert.equal(sports.logo, 'http://x/logo.png')
assert.equal(sports.duration, -1)
assert.equal(news.name, '晚间新闻')
assert.equal(news.group, '新闻')
assert.equal(news.duration, 120)
assert.equal(mp4.name, 'direct.mp4')
assert.equal(mp4.group, '未分类')
assert.equal(mp4.valid, true)
assert.equal(audio.name, '纯音频')
assert.equal(audio.url, 'https://audio.example/song.mp3')

const plain = parseM3u(['https://plain.example/one.m3u8', 'https://plain.example/two.mp4'].join('\n'))
assert.equal(plain.count, 2)
assert.deepEqual(plain.groups, ['未分类'])

console.log('m3u parser tests passed')
