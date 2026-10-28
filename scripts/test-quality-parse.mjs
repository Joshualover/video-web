// server/vod/quality.js 纯函数部分的单元测试
import assert from 'node:assert/strict'
import {
  parseBestHeight,
  qualityLabel,
  describeQualityBadge,
  createHostGate,
  createQualityCache
} from '../server/vod/quality.js'

// ---- master playlist 分辨率解析 ----
{
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
    'mid/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
    'high/index.m3u8'
  ].join('\n')
  assert.equal(parseBestHeight(master), 1080)
}
// 宽高写反（采集站常见）：取短边
assert.equal(parseBestHeight('#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1080x1920\nv.m3u8'), 1080)
// 竖屏短视频：短边就是「高度维」，480x854 → 480
assert.equal(parseBestHeight('#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=480x854\nv.m3u8'), 480)

// CRLF 行尾也要能解析
assert.equal(
  parseBestHeight('#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080\r\nv.m3u8\r\n'),
  1080
)

// 只有 BANDWIDTH：按档位表保守反推
assert.equal(parseBestHeight('#EXT-X-STREAM-INF:BANDWIDTH=6000000\nv.m3u8'), 1440)
assert.equal(parseBestHeight('#EXT-X-STREAM-INF:BANDWIDTH=2500000\nv.m3u8'), 1080)
assert.equal(parseBestHeight('#EXT-X-STREAM-INF:BANDWIDTH=300000\nv.m3u8'), undefined) // 够不到任何档

// 非 master（单码率媒体清单）→ undefined = 未知，绝不是「标清」
{
  const media = ['#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXTINF:10,', 'seg0.ts', '#EXT-X-ENDLIST'].join('\n')
  assert.equal(parseBestHeight(media), undefined)
}
// 没有变体 URI 的残缺 STREAM-INF 行要忽略
assert.equal(parseBestHeight('#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160\n#EXT-X-ENDLIST'), undefined)
assert.equal(parseBestHeight(''), undefined)
assert.equal(parseBestHeight(null), undefined)

// 4K
assert.equal(parseBestHeight('#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=3840x2160\nv.m3u8'), 2160)

// ---- 档位与徽标 ----
// qualityLabel 的入参是**短边高度**（parseBestHeight 已取 min(w,h)）
assert.equal(qualityLabel(2160), '4K') // 4K 的短边是 2160
assert.equal(qualityLabel(1440), '1080P') // 2K/QHD 归 1080P 档（无独立 2K 徽标，不虚标 4K）
assert.equal(qualityLabel(1080), '1080P')
assert.equal(qualityLabel(720), '720P')
assert.equal(qualityLabel(480), '480P')
assert.equal(qualityLabel(300), '标清')
assert.equal(qualityLabel(0), '')
assert.equal(qualityLabel(undefined), '')

assert.deepEqual(describeQualityBadge(undefined), { kind: 'loading' })
assert.deepEqual(describeQualityBadge({ status: 'ok', height: 1080 }), { kind: 'value', label: '1080P' })
assert.deepEqual(describeQualityBadge({ status: 'unknown' }), { kind: 'unknown' })
assert.deepEqual(describeQualityBadge({ status: 'fail', reason: '超时' }), { kind: 'failed', reason: '超时' })

// ---- host 闸门 ----
{
  const gate = createHostGate(2)
  assert.equal(gate.tryAcquire('a.com'), true)
  assert.equal(gate.tryAcquire('a.com'), true)
  assert.equal(gate.tryAcquire('a.com'), false) // 满了
  assert.equal(gate.tryAcquire('b.com'), true) // 另一个 host 不受影响
  gate.release('a.com')
  assert.equal(gate.tryAcquire('a.com'), true)
  gate.release('a.com')
  gate.release('a.com')
  assert.equal(gate.active('a.com'), 0)
  gate.release('b.com')
}

// ---- 缓存（LRU + TTL 分档）----
{
  const cache = createQualityCache()
  assert.equal(cache.get('k1'), undefined)
  cache.set('k1', { status: 'ok', height: 1080 })
  assert.deepEqual(cache.get('k1'), { status: 'ok', height: 1080 })
  // 未知上限后最旧被逐出（写入顺序近似 LRU）
  for (let i = 0; i < 420; i += 1) cache.set(`fill${i}`, { status: 'ok', height: 720 })
  assert.equal(cache.get('k1'), undefined)
  cache.clear()
}

console.log('quality parse: all assertions passed')
