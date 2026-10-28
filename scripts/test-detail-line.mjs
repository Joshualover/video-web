// server/vod/maccms.js 详情选线/简介兜底的单元测试（不触网：只测纯解析函数）
import assert from 'node:assert/strict'
import { parsePlayUrl, pickPreferredLine, extractM3u8FromContent, normalizeVideo } from '../server/vod/maccms.js'

// ---- pickPreferredLine：含 m3u8 的线路优先 ----
{
  const playUrl = [
    [{ name: '第1集', url: 'https://a.example/play/1.html' }], // 线路0：网页播放页
    [{ name: '第1集', url: 'https://b.example/1.m3u8' }], // 线路1：m3u8 → 应被选中
    [{ name: '第1集', url: 'https://c.example/1.mp4' }]
  ]
  assert.equal(pickPreferredLine(playUrl), 1)
  assert.equal(pickPreferredLine([playUrl[0], playUrl[2]]), 0) // 没有任何 m3u8 线路 → 保持 0
  assert.equal(pickPreferredLine([]), 0)
  assert.equal(pickPreferredLine(null), 0)
  // 带 query / 大写也认
  assert.equal(pickPreferredLine([[{ url: 'https://x/v.mp4' }], [{ url: 'https://y/a.M3U8?token=1' }]]), 1)
}

// ---- normalizeVideo 带出 preferredLine ----
{
  const v = normalizeVideo({
    vod_id: 7,
    vod_name: '测试片',
    vod_play_from: 'web线路$$$m3u8线路',
    vod_play_url:
      '第1集$https://a.example/play/1.html#第2集$https://a.example/play/2.html' +
      '$$$第1集$https://b.example/1.m3u8#第2集$https://b.example/2.m3u8'
  })
  assert.equal(v.preferredLine, 1)
  assert.equal(v.playUrl.length, 2)
}

// ---- extractM3u8FromContent：简介兜底 ----
{
  // $ 前缀形态（CMS 惯例）
  const t1 = '免费在线观看 $https://cdn.example.com/vod/2024/1/index.m3u8 $https://cdn.example.com/vod/2024/2/index.m3u8'
  const out1 = extractM3u8FromContent(t1)
  assert.equal(out1.length, 2)
  assert.equal(out1[0].url, 'https://cdn.example.com/vod/2024/1/index.m3u8')
  assert.equal(out1[0].name, '第1集')
  assert.equal(out1[1].name, '第2集')

  // 裸链形态 + 去重
  const t2 = '播放地址：https://a.example/1.m3u8 备用 https://a.example/1.m3u8'
  const out2 = extractM3u8FromContent(t2)
  assert.equal(out2.length, 1)

  // ||| 播放器参数剥离（normalizePlayUrl 语义）
  const t3 = '$https://b.example/1.m3u8|||eyJhbGci'
  const out3 = extractM3u8FromContent(t3)
  assert.equal(out3.length, 1)
  assert.equal(out3[0].url, 'https://b.example/1.m3u8')

  // 无 m3u8 / 空内容
  assert.deepEqual(extractM3u8FromContent('什么都没有'), [])
  assert.deepEqual(extractM3u8FromContent(''), [])
  assert.deepEqual(extractM3u8FromContent(null), [])
}

// ---- parsePlayUrl 回归：#t= 片段保留（既有行为不能被改坏）----
{
  const lines = parsePlayUrl('第1集$https://a.example/1.m3u8#t=10#第2集$https://a.example/2.m3u8')
  assert.equal(lines[0].length, 2)
  assert.equal(lines[0][0].url, 'https://a.example/1.m3u8#t=10')
}

console.log('maccms detail: all assertions passed')
