// 短剧源（黄瓜短剧）端到端测试：分类 → 列表 → 详情 → 播放
//   node scripts/e2e-hgd.mjs            （默认 http://localhost:8787）
//   BASE=http://localhost:5173 node scripts/e2e-hgd.mjs
import { chromium } from 'playwright-core'

const BASE = process.env.BASE || 'http://localhost:8787'
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.addInitScript(() => {
  localStorage.setItem('flow-player:auth-session', 'true')
  localStorage.setItem('flow-player:vodHomeTab', '"browse"')
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const images = []
page.on('response', (r) => {
  if (r.url().includes('/api/vod/image')) images.push(r.status())
})

async function step(name, fn) {
  try {
    await fn()
    console.log('OK   ' + name)
  } catch (err) {
    console.log('FAIL ' + name + ' => ' + String(err.message).split('\n')[0])
    process.exitCode = 1
  }
}

async function pickHgdSource() {
  const select = page.locator('.vod-toolbar select')
  await select.waitFor({ state: 'visible', timeout: 40000 })
  // option 在 select 折叠时不算「可见」，所以轮询它的 value 而不是 waitForSelector
  for (let i = 0; i < 60; i += 1) {
    const values = await select.locator('option').evaluateAll((els) => els.map((el) => el.value))
    if (values.includes('hgdju')) break
    await page.waitForTimeout(500)
  }
  await select.selectOption('hgdju')
  await page.waitForTimeout(3000)
}

await step('选到短剧源并加载分类', async () => {
  await page.goto(BASE + '/vod', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.vod-browse .vod-card', { timeout: 40000 })
  await pickHgdSource()
  await page.waitForSelector('.vod-browse .vod-card', { timeout: 40000 })
  const chips = (await page.locator('.vod-browse .vod-chip').allTextContents()).map((t) => t.trim())
  console.log('     分类: ' + chips.join(' / '))
  console.log('     片单: ' + (await page.locator('.vod-browse .vod-card').count()) + ' 条')
  const first = await page.locator('.vod-browse .vod-card').first().textContent()
  console.log('     首条: ' + first.replace(/\s+/g, ' ').trim().slice(0, 46))
})

await step('切换短剧频道', async () => {
  const chip = page.locator('.vod-browse .vod-chip', { hasText: 'AI 短剧' }).first()
  await chip.click()
  await page.waitForTimeout(3000)
  console.log('     切到 AI 短剧后: ' + (await page.locator('.vod-browse .vod-card').count()) + ' 条')
})

await step('详情页（剧集列表）', async () => {
  await page.locator('.vod-browse .vod-card').first().click()
  await page.waitForSelector('.vod-episode', { timeout: 40000 })
  console.log('     标题: ' + (await page.locator('.vod-detail-info h1, .vod-detail-info h2').first().textContent()).trim())
  console.log('     剧集数: ' + (await page.locator('.vod-episode').count()))
})

await step('播放第一集', async () => {
  await page.locator('.vod-episode').first().click()
  await page.waitForSelector('video', { state: 'attached', timeout: 40000 })
  let info = {}
  for (let i = 0; i < 12; i += 1) {
    await page.waitForTimeout(3000)
    info = await page.evaluate(() => {
      const v = document.querySelector('video')
      return { t: Math.round((v?.currentTime || 0) * 10) / 10, rs: v?.readyState ?? -1, err: v?.error?.message || '' }
    })
    if (info.t > 1.5) break
  }
  console.log('     播放进度: ' + JSON.stringify(info))
  if (!(info.t > 0)) throw new Error('视频没有开始播放')
  console.log('     画面尺寸: ' + (await page.evaluate(() => {
    const v = document.querySelector('video')
    const r = v.getBoundingClientRect()
    return Math.round(r.width) + 'x' + Math.round(r.height)
  })))
})

console.log('\n海报代理请求: ' + images.length + ' 次 ' + JSON.stringify(images.reduce((m, c) => ((m[c] = (m[c] || 0) + 1), m), {})))
console.log('页面错误: ' + errors.length + (errors.length ? ' -> ' + errors[0].slice(0, 150) : ''))
await page.screenshot({ path: 'e2e-hgd.png' })
await browser.close()
