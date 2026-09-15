import { chromium } from 'playwright-core'

const BASE = process.env.BASE || 'http://localhost:8787'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(() => {
  localStorage.setItem('flow-player:auth-session', 'true')
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message))

async function step(name, fn) {
  try {
    await fn()
    console.log('OK   ' + name)
  } catch (err) {
    console.log('FAIL ' + name + ' => ' + err.message)
    process.exitCode = 1
  }
}

let detailUrl = ''

await step('影视导航可见', async () => {
  await page.goto(BASE + '/vod', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.vod-card', { timeout: 30000 })
  const links = await page.locator('.vod-nav-link').allTextContents()
  console.log('     导航: ' + links.map((t) => t.trim()).join(' | '))
})

await step('详情页收藏', async () => {
  // 影视源里总有条目没有可播剧集（B 站类/听书类源），所以挨个卡片试，直到找到有剧集的
  const cards = page.locator('.vod-card')
  const total = Math.min(await cards.count(), 6)
  let opened = false
  for (let i = 0; i < total; i += 1) {
    if (i > 0) await page.goBack({ waitUntil: 'domcontentloaded' })
    await cards.nth(i).click()
    opened = await page
      .waitForSelector('.vod-episode', { timeout: 12000 })
      .then(() => true)
      .catch(() => false)
    if (opened) break
    console.log('     第 ' + (i + 1) + ' 个卡片无剧集，换下一个')
  }
  if (!opened) throw new Error('前 ' + total + ' 个卡片都没有可播剧集')
  detailUrl = page.url()
  const favBtn = page.locator('.vod-detail-info .btn', { hasText: '收藏' })
  await favBtn.first().click()
  await page.waitForTimeout(500)
  const text = await favBtn.first().textContent()
  console.log('     收藏按钮变为: ' + text.trim())
})

await step('收藏页展示', async () => {
  await page.goto(BASE + '/vod/favorites', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.vod-card', { timeout: 15000 })
  console.log('     收藏数: ' + (await page.locator('.vod-card').count()))
})

await step('播放并记录历史', async () => {
  await page.locator('.vod-card-play').first().click()
  await page.waitForSelector('video', { state: 'attached', timeout: 30000 })
  await page.waitForTimeout(12000)
  const info = await page.evaluate(() => {
    const v = document.querySelector('video')
    return { played: v?.played?.length ? v.played.end(0) : 0, readyState: v?.readyState }
  })
  console.log('     播放: ' + JSON.stringify(info))
})

await step('历史页续播', async () => {
  await page.goto(BASE + '/vod/history', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.vod-history-row', { timeout: 15000 })
  const text = await page.locator('.vod-history-row').first().textContent()
  console.log('     记录: ' + text.replace(/\s+/g, ' ').trim().slice(0, 80))
})

await step('源管理页', async () => {
  await page.goto(BASE + '/vod/sources', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.vod-config-group', { timeout: 20000 })
  const groups = await page.locator('.vod-config-group-head').allTextContents()
  const cards = await page.locator('.vod-config-card').count()
  console.log('     分组: ' + groups.map((g) => g.replace(/\s+/g, ' ').trim()).join(' | '))
  console.log('     配置数: ' + cards)
})

await step('多源选路', async () => {
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.vod-episode', { timeout: 30000 })
  await page.locator('.vod-detail-info .btn', { hasText: '多源选路' }).click()
  await page.waitForSelector('.vod-best-row', { timeout: 90000 })
  const n = await page.locator('.vod-best-row').count()
  const first = await page.locator('.vod-best-row').first().textContent()
  console.log('     候选线路: ' + n + ' → ' + first.replace(/\s+/g, ' ').trim().slice(0, 70))
  await page.screenshot({ path: 'e2e-vod-best.png' })
})

console.log('\n页面错误数: ' + errors.length)
for (const e of errors.slice(0, 10)) console.log('  - ' + e.slice(0, 180))

await browser.close()
