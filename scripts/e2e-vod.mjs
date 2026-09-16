import { chromium } from 'playwright-core'

const BASE = process.env.BASE || 'http://localhost:8790'
const WD = process.env.WD || '庆余年'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(() => {
  localStorage.setItem('flow-player:auth-session', 'true')
  localStorage.setItem('flow-player:vodHomeTab', '"browse"')
})
const page = await context.newPage()
const errors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text())
})
page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message))
const vodReqs = []
page.on('response', (resp) => {
  if (resp.url().includes('/api/vod/')) vodReqs.push(resp.status() + ' ' + resp.url().slice(0, 90))
})
page.on('requestfailed', (req) => {
  if (req.url().includes('/api/vod/')) errors.push('REQFAIL ' + req.url().slice(0, 90) + ' ' + req.failure()?.errorText)
})

async function step(name, fn) {
  try {
    await fn()
    console.log('OK   ' + name)
  } catch (err) {
    console.log('FAIL ' + name + ' => ' + err.message)
    process.exitCode = 1
  }
}

await step('打开影视首页', async () => {
  await page.goto(BASE + '/vod', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.vod-browse .vod-card', { timeout: 30000 })
  const count = await page.locator('.vod-browse .vod-card').count()
  console.log('     卡片数: ' + count)
  await page.screenshot({ path: 'e2e-vod-home.png', fullPage: false })
})

await step('切换分类', async () => {
  const chips = page.locator('.vod-cat-row .vod-chip')
  const n = await chips.count()
  console.log('     分类数: ' + n)
  if (n > 2) {
    await chips.nth(2).click()
    await page.waitForTimeout(2500)
    console.log('     切换后卡片数: ' + (await page.locator('.vod-browse .vod-card').count()))
  }
})

await step('聚合搜索', async () => {
  await page.fill('.vod-search input', WD)
  await page.click('.vod-search button[type=submit]')
  await page.waitForSelector('.vod-search-results .vod-card', { timeout: 40000 })
  await page.waitForTimeout(1500)
  console.log('     搜索结果: ' + (await page.locator('.vod-search-results .vod-card').count()))
  await page.screenshot({ path: 'e2e-vod-search.png' })
})

await step('进入详情', async () => {
  const cards = page.locator('.vod-search-results .vod-card')
  const n = await cards.count()
  let picked = 0
  for (let i = 0; i < n; i += 1) {
    const badge = (await cards.nth(i).locator('.vod-site-badge').textContent().catch(() => '')) || ''
    // 多源收录的卡片最稳（详情页能选路换源），其次是这几个老牌源
    if (/量子|光速|新浪|虎牙/.test(badge) || /\d+\s*个源/.test(badge)) {
      picked = i
      break
    }
  }
  console.log('     选择第 ' + (picked + 1) + ' 个结果，源: ' + ((await cards.nth(picked).locator('.vod-site-badge').textContent().catch(() => '')) || '无'))
  await cards.nth(picked).click()
  await page.waitForSelector('.vod-episode', { timeout: 30000 })
  console.log('     剧集数: ' + (await page.locator('.vod-episode').count()))
  await page.screenshot({ path: 'e2e-vod-detail.png' })
})

await step('进入播放页并播放', async () => {
  const hlsOk = []
  page.on('response', (resp) => {
    if (resp.url().includes('/api/vod/hls')) hlsOk.push(resp.status())
  })
  await page.locator('.vod-episode').first().click()
  await page.waitForSelector('video', { state: 'attached', timeout: 30000 })
  // 源站/CDN 时好时坏：给自动换源留时间（15s 卡死看门狗），最多等 30s
  for (let i = 0; i < 10; i += 1) {
    await page.waitForTimeout(3000)
    const t = await page.evaluate(() => document.querySelector('video')?.currentTime || 0)
    if (t > 1) break
  }
  const info = await page.evaluate(() => {
    const v = document.querySelector('video')
    return {
      src: v?.currentSrc || '',
      readyState: v?.readyState,
      duration: v?.duration,
      error: v?.error?.message || '',
      paused: v?.paused,
      played: v?.played?.length ? v.played.end(0) : 0
    }
  })
  console.log('     video: ' + JSON.stringify(info))
  console.log('     hls 响应状态: ' + JSON.stringify(hlsOk.slice(0, 12)))
  console.log('     vod 接口: ' + JSON.stringify(vodReqs))
  await page.screenshot({ path: 'e2e-vod-player.png' })
})

await step('切换剧集', async () => {
  const eps = await page.locator('.vod-episode').count()
  if (eps < 2) {
    console.log('     该片仅 ' + eps + ' 集，跳过')
    return
  }
  const before = await page.evaluate(() => document.querySelector('video')?.currentSrc || '')
  await page.locator('.vod-episode').nth(1).click()
  await page.waitForTimeout(8000)
  const after = await page.evaluate(() => document.querySelector('video')?.currentSrc || '')
  console.log('     currentSrc 变化: ' + (before !== after) + '（' + before.slice(0, 40) + ' → ' + after.slice(0, 40) + '）')
})

console.log('\n控制台错误数: ' + errors.length)
for (const e of errors.slice(0, 12)) console.log('  - ' + e.slice(0, 200))

await browser.close()
