// 播放代理里 Range 处理的单元测试
//
// 背景：YouTube 的 googlevideo 只认有界 Range —— bytes=0- 会被 403，bytes=0-2047 才给 206。
// 浏览器 <audio>/<video> 的首发恰好是 bytes=0-，所以「开放区间」要收成有界区间。
//
// 但**只能动开放区间**：不带 Range 时客户端要的是整个资源，闭区间时客户端点名了字节范围，
// 这两种情况给少了都是坏数据（截断的 HLS .ts 分片会让解码器直接失败），必须返回 null。
import assert from 'node:assert/strict'
import { boundedRange } from '../server/vod/hls.js'

const CHUNK = 1024 * 1024

// 开放区间 -> 收成有界，起点保留
assert.equal(boundedRange('bytes=0-'), `bytes=0-${CHUNK - 1}`)
assert.equal(boundedRange('bytes=100-'), `bytes=100-${CHUNK - 1 + 100}`)
assert.equal(boundedRange('bytes=1048576-'), `bytes=1048576-${1048576 + CHUNK - 1}`)
assert.equal(boundedRange('bytes=0- '), `bytes=0-${CHUNK - 1}`)
assert.equal(boundedRange('Bytes=0-'), `bytes=0-${CHUNK - 1}`)

// 不带 Range：客户端要的是整个资源，不能拿前缀糊弄它
assert.equal(boundedRange(''), null)
assert.equal(boundedRange(undefined), null)
assert.equal(boundedRange(null), null)

// 闭区间一律不动，哪怕它比上限还大 —— 少给会被当成「这一段就这么多」
assert.equal(boundedRange('bytes=0-2047'), null)
assert.equal(boundedRange('bytes=100-200'), null)
assert.equal(boundedRange('bytes=0-1048575'), null) // 刚好等于上限
assert.equal(boundedRange('bytes=0-2097151'), null) // 2MiB，仍不动
assert.equal(boundedRange(`bytes=500-${500 + CHUNK}`), null)

// 多区间 / 非法写法也交给上游自己判
assert.equal(boundedRange('bytes=0-100,200-300'), null)
assert.equal(boundedRange('bytes=abc-'), null)
assert.equal(boundedRange('bytes=-500'), null) // 后缀区间：要的是最后 500 字节
assert.equal(boundedRange('items=0-'), null)

console.log('hls range tests passed')
