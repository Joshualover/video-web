// 音乐板块的浏览器端到端测试（真实点一次播放，确认 <audio> 真的拿到音频）
//
// 默认自己拉起一个实例（端口 8798、关掉音源预热）并托管 dist 构建产物；
// 也可以指向已运行的实例：BASE=http://localhost:8787 node scripts/e2e-music-ui.mjs
//
// 播放这一步依赖公网音源，连不上时记 SKIP；页面结构、搜索、音源管理必须通过。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { findBrowser } from '../server/crawler.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.PORT) || 8798
const OWN_SERVER = !process.env.BASE
const BASE = (process.env.BASE || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '')
const QUERY = process.env.WD || 'shape of you'

let child = null

async function waitForHealth(timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return true
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

const browserPath = process.env.EDGE_PATH || process.env.CHROME_PATH || findBrowser() || ''
let browser = null

try {
  if (OWN_SERVER) await startServer()

  browser = await chromium.launch({
    executablePath: browserPath || undefined,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio']
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const LOGIN_USER = process.env.LOGIN_USER || ''
  const LOGIN_PASS = process.env.LOGIN_PASS || ''
  const session = await context.request.get(`${BASE}/api/session`).then((r) => r.json()).catch(() => ({}))
  if (session?.enabled) {
    if (!LOGIN_USER) throw new Error('服务端启用了会话登录（WEB_LOGIN）：请用 LOGIN_USER / LOGIN_PASS 提供凭据')
    const resp = await context.request.post(`${BASE}/api/login`, {
      data: { username: LOGIN_USER, password: LOGIN_PASS }
    })
    if (!resp.ok()) throw new Error(`服务端登录失败：HTTP ${resp.status()}`)
  }
  await context.addInitScript(() => {
    localStorage.setItem('flow-player:auth-session', 'true')
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })

  await step('打开音乐页', async () => {
    await page.goto(BASE + '/music', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.music-page', { timeout: 20000 })
    await page.waitForSelector('.music-search input', { timeout: 10000 })
    await page.screenshot({ path: 'e2e-music-home.png' })
  })

  await step('音源管理列出内置音源', async () => {
    await page.goto(BASE + '/music/sources', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.music-source-row', { timeout: 20000 })
    const count = await page.locator('.music-source-row').count()
    expect(count >= 4, `音源数量偏少：${count}`)
    await page.screenshot({ path: 'e2e-music-sources.png' })
  })

  await step('搜索返回结果', async () => {
    await page.goto(BASE + '/music', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.music-search input', { timeout: 20000 })
    await page.fill('.music-search input', QUERY)
    const started = Date.now()
    await page.press('.music-search input', 'Enter')
    // 首屏必须由「快源那一趟」铺出来。如果哪天退回成单趟（等 yt-dlp 跑完才返回），
    // 这里会超时 —— 这正是要守住的行为
    await page.waitForSelector('.music-row', { timeout: 8000 })
    console.log('     首屏 ' + (Date.now() - started) + 'ms')
    const rows = await page.locator('.music-row').count()
    expect(rows > 0, '没有结果行')
    console.log('     结果数: ' + rows)
    await page.screenshot({ path: 'e2e-music-search.png' })
  }, { optional: true })

  await step('点击播放后 <audio> 真的开始加载', async () => {
    // yt-dlp 给的直链落在 googlevideo 上，本机（DNS 被污染）播不了，
    // 所以挑一条「不是 yt-dlp」的结果来验证浏览器侧真的能出声
    const rows = page.locator('.music-row')
    const total = await rows.count()
    let target = 0
    for (let i = 0; i < total; i += 1) {
      if (!/yt-dlp/.test(await rows.nth(i).innerText())) {
        target = i
        break
      }
    }
    const row = rows.nth(target)
    const playBtn = row.locator('.music-play-btn')
    if (await playBtn.count()) await playBtn.first().click()
    else await row.click()
    await page.waitForSelector('.music-player', { timeout: 15000 })
    const state = await page.waitForFunction(
      () => {
        const audio = document.querySelector('audio')
        if (!audio || !audio.src) return false
        return audio.readyState >= 2 && !Number.isNaN(audio.duration)
          ? { readyState: audio.readyState, duration: audio.duration, src: audio.src.slice(0, 80) }
          : false
      },
      { timeout: 40000 }
    )
    const value = await state.jsonValue()
    console.log('     audio: readyState=' + value.readyState + ' duration=' + value.duration)
    expect(/\/api\/music\/proxy/.test(value.src), '音频没有走本站代理：' + value.src)
    await page.screenshot({ path: 'e2e-music-play.png' })
  }, { optional: true })

  await step('移动端视口不出现横向滚动', async () => {
    const mobile = await context.newPage()
    await mobile.setViewportSize({ width: 390, height: 844 })
    await mobile.goto(BASE + '/music/sources', { waitUntil: 'domcontentloaded' })
    await mobile.waitForSelector('.music-source-row', { timeout: 20000 })
    const overflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(overflow <= 2, `横向溢出 ${overflow}px`)
    await mobile.screenshot({ path: 'e2e-music-mobile.png', fullPage: false })
    await mobile.close()
  })

  await step('页面无 JS 报错', async () => {
    const real = errors.filter((item) => !/favicon|ERR_ABORTED|Failed to load resource/i.test(item))
    expect(real.length === 0, real.slice(0, 3).join(' | '))
  })
} finally {
  if (browser) await browser.close().catch(() => {})
  if (OWN_SERVER) await stopServer()
}

console.log(`\n音乐 UI e2e 结束：失败 ${failed} 项，跳过 ${skipped} 项`)
