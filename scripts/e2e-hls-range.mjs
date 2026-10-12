// 播放代理「Range 兜底」的端到端回归
//
// 背景：有些 CDN 只认「有界 Range」—— 不带 Range、或 bytes=N- 这种开放区间一律 403
// （实测 YouTube 的 googlevideo 就是这样），而浏览器 <video>/<audio> 的首发恰好是 bytes=0-。
// 播放代理在拿到 4xx 时会把区间收成 1MiB 的有界区间重试。
//
// scripts/test-hls.mjs 只覆盖了纯函数；这里用一台「只认有界 Range」的假 CDN，把
// 假 CDN -> 服务端代理 -> 客户端 这整条 HTTP 链路跑通，确保兜底真的接上了、且不会打转。
//
// 假 CDN 绑在 127.0.0.1，所以服务端要带 ALLOW_PRIVATE_NETWORK=true 起来（出网校验默认拒内网）。
// 这是脚本自己拉起的实例，不影响已部署的服务。
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CDN_PORT = Number(process.env.CDN_PORT) || 8796
const APP_PORT = Number(process.env.PORT) || 8795
const BASE = `http://127.0.0.1:${APP_PORT}`
const TOTAL = 5 * 1024 * 1024 + 12345 // 故意取个非整数兆，方便看 Content-Range
const CHUNK_LIMIT = 1024 * 1024

const seen = [] // 假 CDN 收到的 Range，用来确认兜底真的换成了有界区间

function makeCdn() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: `/media` })
      res.end()
      return
    }
    if (url.pathname === '/always-403') {
      seen.push({ path: url.pathname, range: req.headers.range || '' })
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('nope')
      return
    }
    const range = String(req.headers.range || '')
    seen.push({ path: url.pathname, range })
    const matched = range.match(/^bytes=(\d+)-(\d*)$/)
    const open = !matched || matched[2] === ''
    if (open) {
      // 只认有界 Range —— 这正是要逼出兜底分支的行为
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('unbounded range not allowed')
      return
    }
    const start = Number(matched[1])
    const end = Math.min(Number(matched[2]), TOTAL - 1)
    const size = end - start + 1
    if (size > CHUNK_LIMIT) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('range too large')
      return
    }
    res.writeHead(206, {
      'Content-Type': 'audio/mp4',
      'Content-Length': String(size),
      'Content-Range': `bytes ${start}-${end}/${TOTAL}`,
      'Accept-Ranges': 'bytes'
    })
    res.end(Buffer.alloc(size, 7))
  })
}

async function waitFor(url, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url)
      if (resp.ok) return true
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

const cdn = makeCdn()
await new Promise((resolve) => cdn.listen(CDN_PORT, '127.0.0.1', resolve))

const app = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    HOST: '127.0.0.1',
    ALLOW_PRIVATE_NETWORK: 'true',
    MUSIC_WARMUP: '0',
    VOD_AUTO_REFRESH_HOURS: '0'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let appLog = ''
app.stdout.on('data', () => {})
app.stderr.on('data', (chunk) => {
  appLog += chunk
})

let failed = 0
async function step(name, fn) {
  try {
    await fn()
    console.log('OK   ' + name)
  } catch (err) {
    failed += 1
    process.exitCode = 1
    console.log('FAIL ' + name + ' => ' + err.message)
  }
}

const proxy = (target) => `${BASE}/api/music/proxy?url=${encodeURIComponent(target)}`

try {
  if (!(await waitFor(`${BASE}/api/health`))) throw new Error('服务端启动超时')

  await step('开放区间 bytes=0- 被收成有界区间后成功', async () => {
    seen.length = 0
    const resp = await fetch(proxy(`http://127.0.0.1:${CDN_PORT}/media`), { headers: { Range: 'bytes=0-' } })
    assert.equal(resp.status, 206, `HTTP ${resp.status}`)
    assert.equal(resp.headers.get('content-range'), `bytes 0-${CHUNK_LIMIT - 1}/${TOTAL}`)
    const body = Buffer.from(await resp.arrayBuffer())
    assert.equal(body.length, CHUNK_LIMIT)
    // 假 CDN 应该先看到一次「开放区间」被拒，再看到一次有界区间成功
    assert.ok(seen.length >= 2, `假 CDN 只收到 ${seen.length} 次请求`)
    assert.equal(seen[0].range, 'bytes=0-')
    assert.match(seen[1].range, /^bytes=0-\d+$/, '第二次没有换成有界区间：' + seen[1].range)
  })

  // 不带 Range 时客户端要的是「整个资源」：拿一段前缀冒充完整内容会得到坏数据
  // （HLS 的 .ts 分片就是这种请求，截断的 TS 会让解码器直接报 DEMUXER_ERROR）。
  // 所以这种情况**故意不兜底**，宁可明确报 502。
  await step('不带 Range 时不做替换：明确失败，而不是给截断内容', async () => {
    seen.length = 0
    const resp = await fetch(proxy(`http://127.0.0.1:${CDN_PORT}/media`))
    assert.equal(resp.status, 502, `HTTP ${resp.status}`)
    // 4xx 之后还可能因为「换路由」再打一次，那没关系；关键是不能把区间改写掉
    assert.ok(seen.length >= 1, '假 CDN 一次都没收到请求')
    assert.ok(seen.every((item) => item.range === ''), '不带 Range 时不该被塞上 Range：' + JSON.stringify(seen))
  })

  await step('闭区间过大时同样不替换，只走换路由', async () => {
    seen.length = 0
    const resp = await fetch(proxy(`http://127.0.0.1:${CDN_PORT}/media`), {
      headers: { Range: `bytes=0-${CHUNK_LIMIT * 2 - 1}` }
    })
    assert.equal(resp.status, 502, `HTTP ${resp.status}`)
    const original = `bytes=0-${CHUNK_LIMIT * 2 - 1}`
    assert.ok(seen.length >= 1, '假 CDN 一次都没收到请求')
    assert.ok(seen.every((item) => item.range === original), '闭区间必须原样透传：' + JSON.stringify(seen))
  })

  await step('3xx 重定向后依然走兜底', async () => {
    seen.length = 0
    const resp = await fetch(proxy(`http://127.0.0.1:${CDN_PORT}/redirect`), { headers: { Range: 'bytes=0-' } })
    assert.equal(resp.status, 206, `HTTP ${resp.status}`)
    assert.equal((await resp.arrayBuffer()).byteLength, CHUNK_LIMIT)
  })

  await step('合法的小闭区间原样透传，不做多余的重试', async () => {
    seen.length = 0
    const resp = await fetch(proxy(`http://127.0.0.1:${CDN_PORT}/media`), { headers: { Range: 'bytes=0-2047' } })
    assert.equal(resp.status, 206)
    assert.equal((await resp.arrayBuffer()).byteLength, 2048)
    assert.equal(seen.length, 1, '不该有多余的重试')
    assert.equal(seen[0].range, 'bytes=0-2047')
  })

  await step('从中间开始取（bytes=N-）也能拿到正确偏移', async () => {
    seen.length = 0
    const resp = await fetch(proxy(`http://127.0.0.1:${CDN_PORT}/media`), { headers: { Range: `bytes=${CHUNK_LIMIT}-` } })
    assert.equal(resp.status, 206)
    assert.equal(resp.headers.get('content-range'), `bytes ${CHUNK_LIMIT}-${CHUNK_LIMIT * 2 - 1}/${TOTAL}`)
    assert.equal((await resp.arrayBuffer()).byteLength, CHUNK_LIMIT)
  })

  await step('上游死活拒绝时快速失败，不打转', async () => {
    const started = Date.now()
    const resp = await fetch(proxy(`http://127.0.0.1:${CDN_PORT}/always-403`), { headers: { Range: 'bytes=0-' } })
    const cost = Date.now() - started
    assert.equal(resp.status, 502, `HTTP ${resp.status}`)
    assert.ok(cost < 15000, `耗时 ${cost}ms，兜底重试没有收敛`)
  })
} finally {
  app.kill('SIGTERM')
  cdn.close()
  await new Promise((resolve) => setTimeout(resolve, 200))
  if (app.exitCode === null) app.kill('SIGKILL')
}

console.log(`\nRange 兜底 e2e 结束：失败 ${failed} 项`)
void appLog
