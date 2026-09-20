// 影视站源（vidhub.tv）端到端测试：分类 → 列表 → 详情 → 播放
//   node scripts/e2e-vidhub.mjs
//   BASE=http://localhost:5173 node scripts/e2e-vidhub.mjs
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

async function pickSource(value) {
  const select = page.locator('.vod-toolbar select')
  await select.waitFor({ state: 'visible', timeout: 40000 })
  for (let i = 0; i < 60; i += 1) {
    const values = await select.locator('option').evaluateAll((els) => els.map((el) => el.value))
    if (values.includes(value)) break
    await page.waitForTimeout(500)
  }
  await select.selectOption(value)
  await page.waitForTimeout(3000)
}

await step('选到 Vidhub 影视源并加载分类', async () => {
  await page.goto(BASE + '/vod', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.vod-browse .vod-card', { timeout: 40000 })
  await pickSource('vidhub')
  // 切源时分类列表会先清空再加载，所以要等到新分类（“电影”这个词只有这个源有）出现
  await page.waitForSelector('.vod-browse .vod-chip', { timeout: 45000 })
  await page.locator('.vod-browse .vod-chip', { hasText: '电影' }).first().waitFor({ timeout: 45000 })
  await page.waitForSelector('.vod-browse .vod-card', { timeout: 45000 })
  const chips = (await page.locator('.vod-browse .vod-chip').allTextContents()).map((t) => t.trim())
  console.log('     分类: ' + chips.join(' / '))
  console.log('     片单: ' + (await page.locator('.vod-browse .vod-card').count()) + ' 条')
  const first = await page.locator('.vod-browse .vod-card').first()
  console.log('     首条: ' + (await first.textContent()).replace(/\s+/g, ' ').trim().slice(0, 44))
})

await step('分类浏览 + 翻页', async () => {
  await page.locator('.vod-browse .vod-chip', { hasText: '电影' }).first().click()
  await page.waitForTimeout(4000)
  const before = (await page.locator('.vod-browse .vod-card-name').first().textContent()).trim()
  console.log('     电影第1页首条: ' + before)
  await page.locator('.vod-pager button', { hasText: '下一页' }).click()
  await page.waitForTimeout(4500)
  const after = (await page.locator('.vod-browse .vod-card-name').first().textContent()).trim()
  console.log('     第2页首条: ' + after + (before !== after ? ' ✔ 翻页生效' : ' ✘ 未变化'))
  if (before === after) throw new Error('翻页后内容未变')
})

await step('搜索（站点 ajax 联想接口）', async () => {
  await page.locator('.vod-search input').fill('第三调解室')
  await page.click('.vod-search button[type=submit]')
  await page.waitForSelector('.vod-search-results .vod-card', { timeout: 45000 })
  await page.waitForTimeout(1200)
  const names = (await page.locator('.vod-search-results .vod-card-name').allTextContents()).slice(0, 3).map((t) => t.trim())
  console.log('     结果: ' + (await page.locator('.vod-search-results .vod-card').count()) + ' 条 → ' + names.join(' / '))
})

await step('详情页（多线路剧集）', async () => {
  // 用固定的一部多线路片测（搜索同名版本很多，且单线路的居多），
  // 搜索能力已在上一步验证过
  await page.goto(BASE + '/vod/detail/vidhub/112480', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.vod-episode', { timeout: 45000 })
  const lines = await page.locator('.vod-lines .vod-chip').allTextContents()
  console.log('     标题: ' + (await page.locator('.vod-detail-info h1, .vod-detail-info h2').first().textContent()).trim())
  console.log('     线路: ' + (lines.length ? lines.map((t) => t.trim()).join(' / ') : '单线路'))
  console.log('     剧集数: ' + (await page.locator('.vod-episode').count()))
  if ((await page.locator('.vod-episode').count()) < 2) throw new Error('剧集数异常')
})

await step('播放第一集（线路不好就换线路）', async () => {
  await page.locator('.vod-episode').first().click()
  await page.waitForSelector('video', { state: 'attached', timeout: 45000 })
  const lineChips = page.locator('.vod-lines .vod-chip')
  const lines = await lineChips.count()
  let info = {}
  let played = false
  // 采集源的 CDN 时好时坏：起不来就换下一条线路（最多试 3 条）
  for (let attempt = 0; attempt < Math.max(Math.min(lines, 3), 1) && !played; attempt += 1) {
    for (let i = 0; i < 10; i += 1) {
      await page.waitForTimeout(3000)
      info = await page.evaluate(() => {
        const v = document.querySelector('video')
        return { t: Math.round((v?.currentTime || 0) * 10) / 10, rs: v?.readyState ?? -1, err: v?.error?.message || '' }
      })
      if (info.t > 1.5) {
        played = true
        break
      }
    }
    if (!played && lines > 1) {
      const next = (attempt + 1) % lines
      console.log(`     线路${attempt} 没起来，换到线路${next}`)
      await lineChips.nth(next).click()
      await page.waitForTimeout(3000)
    }
  }
  console.log('     播放进度: ' + JSON.stringify(info))
  if (!played) throw new Error('试了多条线路视频都没开始播放')
  console.log('     画面尺寸: ' + (await page.evaluate(() => {
    const v = document.querySelector('video')
    const r = v.getBoundingClientRect()
    return Math.round(r.width) + 'x' + Math.round(r.height)
  })))
})

console.log('\n海报代理请求: ' + images.length + ' 次 ' + JSON.stringify(images.reduce((m, c) => ((m[c] = (m[c] || 0) + 1), m), {})))
console.log('页面错误: ' + errors.length + (errors.length ? ' -> ' + errors[0].slice(0, 150) : ''))
await page.screenshot({ path: 'e2e-vidhub.png' })
await browser.close()
