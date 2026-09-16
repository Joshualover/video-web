import { chromium } from 'playwright-core'

const BASE = process.env.BASE || 'http://localhost:8787'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(() => {
  localStorage.setItem('flow-player:auth-session', 'true')
  localStorage.setItem('flow-player:vodHomeTab', '"browse"')
  const now = Date.now()
  localStorage.setItem(
    'flow-player:vodRecents',
    JSON.stringify([
      { site: 's1', id: '1', name: '测试影片X', year: '2024', line: 0, index: 0, episodeName: '第01集', position: 120, duration: 600, at: now },
      { site: 's2', id: '2', name: '测试影片 X', year: '2024', line: 0, index: 1, episodeName: '第02集', position: 60, duration: 600, at: now - 1000 }
    ])
  )
  localStorage.setItem(
    'flow-player:vodFavorites',
    JSON.stringify([
      { site: 's1', id: '1', name: '甲片', year: '2023', type: '电影', group: '动作', at: now },
      { site: 's2', id: '2', name: '乙片', year: '2022', type: '剧集', group: '剧集', at: now - 1000 },
      { site: 's1', id: '3', name: '丙片', year: '2024', type: '电影', group: '动作', at: now - 2000 }
    ])
  )
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

await step('收藏分组筛选', async () => {
  await page.goto(BASE + '/vod/favorites', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.vod-card', { timeout: 15000 })
  const chips = await page.locator('.vod-filter-row .vod-chip').allTextContents()
  console.log('     分组chips: ' + chips.map((c) => c.replace(/\s+/g, ' ').trim()).join(' | '))
  await page.locator('.vod-filter-row .vod-chip', { hasText: '动作' }).click()
  await page.waitForTimeout(300)
  console.log('     动作组卡片: ' + (await page.locator('.vod-card').count()))
  await page.selectOption('.vod-sort select', 'name')
  await page.waitForTimeout(300)
  const names = await page.locator('.vod-card-name').allTextContents()
  console.log('     名称排序: ' + names.join(', '))
})

await step('收藏移动分组', async () => {
  await page.locator('.vod-filter-row .vod-chip', { hasText: '全部' }).click()
  await page.waitForTimeout(200)
  const select = page.locator('.vod-group-select').first()
  await select.selectOption('剧集')
  await page.waitForTimeout(300)
  const chips = await page.locator('.vod-filter-row .vod-chip').allTextContents()
  console.log('     移动后分组: ' + chips.map((c) => c.replace(/\s+/g, ' ').trim()).join(' | '))
})

await step('历史按片聚合', async () => {
  await page.goto(BASE + '/vod/history', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.vod-history-row', { timeout: 15000 })
  const aggRows = await page.locator('.vod-history-row').count()
  const badge = await page.locator('.vod-variant-badge').first().textContent().catch(() => '')
  console.log('     聚合行数: ' + aggRows + ' | 徽标: ' + (badge || '').trim())
  await page.locator('.vod-seg-btn', { hasText: '全部记录' }).click()
  await page.waitForTimeout(300)
  console.log('     全部记录行数: ' + (await page.locator('.vod-history-row').count()))
})

let detailUrl = ''
await step('选路并写入缓存', async () => {
  await page.goto(BASE + '/vod', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.vod-browse .vod-card', { timeout: 30000 })
  await page.locator('.vod-search input').fill('庆余年')
  await page.click('.vod-search button[type=submit]')
  await page.waitForSelector('.vod-search-results .vod-card', { timeout: 40000 })
  await page.waitForTimeout(1500)
  const cards = page.locator('.vod-search-results .vod-card')
  const total = await cards.count()
  let picked = 0
  for (let i = 0; i < total; i += 1) {
    const badge = (await cards.nth(i).locator('.vod-site-badge').textContent().catch(() => '')) || ''
    // 多源收录的卡片最稳（详情页能选路换源），其次是这几个老牌源
    if (/量子|光速|新浪|虎牙/.test(badge) || /\d+\s*个源/.test(badge)) {
      picked = i
      break
    }
  }
  await cards.nth(picked).click()
  await page.waitForSelector('.vod-episode', { timeout: 60000 })
  detailUrl = page.url()
  const t0 = Date.now()
  await page.locator('.vod-detail-info .btn', { hasText: '多源选路' }).click()
  await page.waitForSelector('.vod-best-row', { timeout: 120000 })
  console.log('     测速耗时: ' + (Date.now() - t0) + 'ms，候选 ' + (await page.locator('.vod-best-row').count()))
  const cached = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('flow-player:vodBestCache') || '{}')).length)
  console.log('     缓存条目: ' + cached)
})

await step('刷新页面走本地缓存', async () => {
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.vod-episode', { timeout: 30000 })
  const t0 = Date.now()
  await page.locator('.vod-detail-info .btn', { hasText: '多源选路' }).click()
  await page.waitForSelector('.vod-best-row', { timeout: 8000 })
  const cost = Date.now() - t0
  const note = await page.locator('.vod-best .count-note').first().textContent()
  console.log('     缓存命中耗时: ' + cost + 'ms | ' + note.trim())
})

console.log('\n页面错误数: ' + errors.length)
for (const e of errors.slice(0, 10)) console.log('  - ' + e.slice(0, 180))

await browser.close()
