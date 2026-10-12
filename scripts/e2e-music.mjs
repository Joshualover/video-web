// 音乐源端到端测试（API 层，不需要浏览器）
//
// 默认自己拉起一个独立实例（端口 8797、关掉音源预热），跑完自动关掉；
// 也可以指向已经跑着的实例：BASE=http://localhost:8787 node scripts/e2e-music.mjs
//
// 依赖公网的检查项标了 optional：JioSaavn / iTunes 连不上时记 SKIP，
// 不计入失败 —— 但接口本身的形状、参数校验、出网校验必须始终通过。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.PORT) || 8797
const OWN_SERVER = !process.env.BASE
const BASE = (process.env.BASE || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '')

let child = null

async function waitForHealth(timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${BASE}/api/health`)
      if (resp.ok) return true
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

async function startServer() {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      MUSIC_WARMUP: '0',
      VOD_AUTO_REFRESH_HOURS: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', (chunk) => process.stderr.write('[server] ' + chunk))
  if (!(await waitForHealth())) throw new Error('服务端启动超时')
}

async function stopServer() {
  if (!child) return
  child.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 200))
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function json(pathname, init) {
  const resp = await fetch(BASE + pathname, init)
  const data = await resp.json().catch(() => ({}))
  return { status: resp.status, data }
}

let failed = 0
let skipped = 0

async function step(name, fn, { optional = false } = {}) {
  try {
    await fn()
    console.log('OK   ' + name)
  } catch (err) {
    if (optional) {
      skipped += 1
      console.log('SKIP ' + name + ' => ' + err.message)
      return
    }
    failed += 1
    console.log('FAIL ' + name + ' => ' + err.message)
    process.exitCode = 1
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

const SAAVN = 'jiosaavn:www.jiosaavn.com'
const APPLE = 'itunes:itunes.apple.com'

try {
  if (OWN_SERVER) await startServer()

  await step('健康检查', async () => {
    const { status, data } = await json('/api/health')
    expect(status === 200 && data.ok, '健康检查未通过')
  })

  await step('音源列表包含内置音源', async () => {
    const { status, data } = await json('/api/music/sources')
    expect(status === 200, `HTTP ${status}`)
    const ids = (data.sources || []).map((item) => item.id)
    for (const id of [SAAVN, APPLE]) expect(ids.includes(id), `缺少内置音源 ${id}`)
    expect((data.sources || []).every((item) => typeof item.enabled === 'boolean'), '缺少 enabled 字段')
    expect((data.sources || []).some((item) => item.kind === 'piped'), '缺少 piped 音源')
  })

  await step('停用/启用音源', async () => {
    const off = await json(`/api/music/sources/${encodeURIComponent(APPLE)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    })
    expect(off.status === 200 && off.data.enabled === false, '停用失败')
    const listed = await json('/api/music/sources')
    const item = listed.data.sources.find((s) => s.id === APPLE)
    expect(item?.enabled === false, '停用状态没生效')
    const on = await json(`/api/music/sources/${encodeURIComponent(APPLE)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true })
    })
    expect(on.data.enabled === true, '恢复启用失败')
  })

  await step('参数校验：缺关键词 / 缺 id / 未知音源', async () => {
    expect((await json('/api/music/search')).status === 400, '缺 wd 应返回 400')
    expect((await json('/api/music/stream?source=' + encodeURIComponent(SAAVN))).status === 400, '缺 id 应返回 400')
    expect((await json('/api/music/stream?source=nope&id=1')).status === 404, '未知音源应返回 404')
    expect((await json('/api/music/match')).status === 400, '缺 title 应返回 400')
    const missing = await json('/api/music/sources/nope/check', { method: 'POST' })
    expect(missing.status === 404, '未知音源检测应返回 404')
  })

  await step('出网校验：内网地址与内置源删除都要被拦住', async () => {
    const ssrf = await json('/api/music/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'piped', api: 'http://127.0.0.1:8080' })
    })
    expect(ssrf.status === 400 && /内网/.test(ssrf.data.error || ''), `内网地址未被拒绝：${JSON.stringify(ssrf.data)}`)
    const badKind = await json('/api/music/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'jiosaavn', api: 'https://example.com' })
    })
    expect(badKind.status === 400, '不允许新增的 kind 应被拒绝')
    const del = await json(`/api/music/sources/${encodeURIComponent(APPLE)}`, { method: 'DELETE' })
    expect(del.status === 400, '内置音源不应允许删除')
  })

  await step('新增 / 删除自定义音源', async () => {
    // 用 example.com 当假实例：出网校验只要求「公网可解析」，不要求它真的能当 Piped 用
    const created = await json('/api/music/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'piped', api: 'https://example.com', name: 'e2e 实例' })
    })
    expect(created.status === 200, `新增失败：${created.data.error || created.status}`)
    expect(created.data.source?.from === '自定义', '新增的音源应标记为自定义')
    const id = created.data.source.id
    const listed = await json('/api/music/sources')
    expect(listed.data.sources.some((s) => s.id === id), '新增的音源没有出现在列表里')
    const removed = await json(`/api/music/sources/${encodeURIComponent(id)}`, { method: 'DELETE' })
    expect(removed.status === 200, '删除失败')
    const after = await json('/api/music/sources')
    expect(!after.data.sources.some((s) => s.id === id), '删除后仍在列表里')
  })

  await step('JioSaavn 搜索', async () => {
    const { status, data } = await json(`/api/music/search?wd=${encodeURIComponent('shape of you')}&source=${encodeURIComponent(SAAVN)}&limit=5`)
    expect(status === 200, `HTTP ${status} ${data.error || ''}`)
    expect((data.results || []).length > 0, '没有返回结果')
    const first = data.results[0]
    expect(!Object.hasOwn(first, 'encryptedMediaUrl'), '内部字段泄漏到接口')
    expect(typeof first.key === 'string' && first.key.startsWith(SAAVN + ':'), 'key 格式不对')
  }, { optional: true })

  let playable = null

  await step('JioSaavn 解析播放地址', async () => {
    const search = await json(`/api/music/search?wd=${encodeURIComponent('shape of you')}&source=${encodeURIComponent(SAAVN)}&limit=3`)
    const track = (search.data.results || [])[0]
    expect(track, '搜索无结果')
    const { status, data } = await json(`/api/music/stream?source=${encodeURIComponent(SAAVN)}&id=${encodeURIComponent(track.id)}`)
    expect(status === 200, `HTTP ${status} ${data.error || ''}`)
    expect((data.streams || []).length > 0, '没有可用音质')
    expect(/^\/api\/music\/proxy\?url=/.test(data.streams[0].playUrl), 'playUrl 不是本站代理地址')
    playable = data.streams[0]
  }, { optional: true })

  await step('音频代理支持 Range 透传', async () => {
    if (!playable) throw new Error('上一步没有拿到可播地址')
    const resp = await fetch(BASE + playable.playUrl, { headers: { Range: 'bytes=0-2047' } })
    expect(resp.status === 206, `应返回 206，实际 ${resp.status}`)
    expect(/audio|video|octet-stream/.test(resp.headers.get('content-type') || ''), 'Content-Type 不是媒体类型')
    const buf = Buffer.from(await resp.arrayBuffer())
    expect(buf.length === 2048, `分片长度应为 2048，实际 ${buf.length}`)
  }, { optional: true })

  await step('iTunes 试听源搜索与播放', async () => {
    const search = await json(`/api/music/search?wd=${encodeURIComponent('五月天')}&source=${encodeURIComponent(APPLE)}&limit=3`)
    const track = (search.data.results || [])[0]
    expect(track, '搜索无结果')
    expect(track.preview === true, '试听源应标记 preview')
    const { status, data } = await json(`/api/music/stream?source=${encodeURIComponent(APPLE)}&id=${encodeURIComponent(track.id)}`)
    expect(status === 200, `HTTP ${status} ${data.error || ''}`)
    expect((data.streams || []).length > 0, '没有返回试听流')
  }, { optional: true })

  await step('封面代理', async () => {
    const search = await json(`/api/music/search?wd=${encodeURIComponent('五月天')}&source=${encodeURIComponent(APPLE)}&limit=1`)
    const pic = (search.data.results || [])[0]?.pic
    expect(pic, '搜索无结果')
    const resp = await fetch(`${BASE}/api/music/image?url=${encodeURIComponent(pic)}`)
    expect(resp.ok, `HTTP ${resp.status}`)
    expect(/^image\//.test(resp.headers.get('content-type') || ''), 'Content-Type 不是图片')
    await resp.arrayBuffer()
  }, { optional: true })

  await step('聚合搜索返回逐源错误而不是整体失败', async () => {
    const { status, data } = await json(`/api/music/search?wd=${encodeURIComponent('hello')}&limit=10`)
    expect(status === 200, `HTTP ${status} ${data.error || ''}`)
    expect(Array.isArray(data.results), '缺少 results')
    expect(Array.isArray(data.errors), '缺少 errors')
    expect(Array.isArray(data.searched) && data.searched.length > 0, '缺少 searched')
  })

  await step('自动匹配（换源播放）能返回 tried 明细', async () => {
    const { status, data } = await json(`/api/music/match?title=${encodeURIComponent('Shape of You')}&artists=Ed%20Sheeran`)
    expect(status === 200, `HTTP ${status} ${data.error || ''}`)
    expect(typeof data.matched === 'boolean', '缺少 matched')
    expect(Array.isArray(data.tried), '缺少 tried')
  }, { optional: true })
} finally {
  if (OWN_SERVER) await stopServer()
}

console.log(`\n音乐源 e2e 结束：失败 ${failed} 项，跳过 ${skipped} 项`)
