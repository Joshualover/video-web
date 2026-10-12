// 播放代理里 range 处理的单元测试
//
// 背景：YouTube 的 googlevideo 只认有界 Range —— bytes=0- 会被 403，bytes=0-2047 才给 206。
// 浏览器 <audio>/<video> 的首发恰好是 bytes=0-，所以「开放区间」必须收成有界区间。
import assert from 'node:assert/strict'
import { boundedRange } from '../server/vod/hls.js'

const CHUNK = 1024 * 1024

// 小闭区间原样保留：上游本来就认，别去动它
assert.equal(boundedRange('bytes=0-2047'), null)
assert.equal(boundedRange('bytes=100-200'), null)
// 刚好等于上限也不动
assert.equal(boundedRange(`bytes=0-${CHUNK - 1}`), null)
// 闭区间但比上限大：同样要收小（实测 2MiB 的闭区间会被 googlevideo 403）
assert.equal(boundedRange('bytes=0-2097151'), `bytes=0-${CHUNK - 1}`)
assert.equal(boundedRange(`bytes=500-${500 + CHUNK}`), `bytes=500-${500 + CHUNK - 1}`)
// 起点必须保留
assert.equal(boundedRange('bytes=1048576-9999999'), `bytes=1048576-${1048576 + CHUNK - 1}`)
// 多区间 / 非法写法也不动，交给上游自己判
assert.equal(boundedRange('bytes=0-100,200-300'), null)
assert.equal(boundedRange('bytes=abc-'), null)
assert.equal(boundedRange('items=0-'), null)

// 开放区间收成有界
assert.equal(boundedRange('bytes=0-'), `bytes=0-${CHUNK - 1}`)
assert.equal(boundedRange('bytes=100-'), `bytes=100-${CHUNK - 1 + 100}`)
assert.equal(boundedRange('bytes=0- '), `bytes=0-${CHUNK - 1}`)
assert.equal(boundedRange('Bytes=0-'), `bytes=0-${CHUNK - 1}`)

// 完全没有 Range（有的客户端先探测一下）也要给一段有界的
assert.equal(boundedRange(''), `bytes=0-${CHUNK - 1}`)
assert.equal(boundedRange(undefined), `bytes=0-${CHUNK - 1}`)

console.log('hls range tests passed')
