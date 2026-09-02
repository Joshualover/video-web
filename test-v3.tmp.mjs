import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.goto('http://localhost:8899/login')
await page.evaluate(() => { localStorage.setItem('flow-player:auth-session', 'true'); localStorage.setItem('flow-player:channelView', '"grid"'); localStorage.setItem('flow-player:cardSize', '"md"') })
await page.goto('http://localhost:8899/')
await page.waitForTimeout(3500)
await page.click('nav a[href="/channels"]')
await page.waitForTimeout(2500)
const sz = async (size, label) => {
  await page.evaluate((s) => { localStorage.setItem('flow-player:cardSize', JSON.stringify(s)); location.reload() }, size)
  await page.waitForTimeout(2000)
  await page.click('nav a[href="/channels"]')
  await page.waitForTimeout(2000)
  const m = await page.evaluate(() => { const c = document.querySelector('.channel-card'); const t = document.querySelector('.channel-thumb'); const cr = c.getBoundingClientRect(); const tr = t.getBoundingClientRect(); return { card: `${Math.round(cr.width)}x${Math.round(cr.height)}`, thumb: `${Math.round(tr.width)}x${Math.round(tr.height)}` } })
  console.log(`[${label}]`, JSON.stringify(m))
}
await sz('sm', '小')
await sz('lg', '大')
// 列表视图 + 滚动 + 回顶
await page.evaluate(() => { localStorage.setItem('flow-player:channelView', '"list"'); location.reload() })
await page.waitForTimeout(2000)
await page.click('nav a[href="/channels"]')
await page.waitForTimeout(2000)
const listState = await page.evaluate(() => {
  const host = document.querySelector('.channel-scroll-host')
  const rows = document.querySelectorAll('.channel-row').length
  host.scrollTop = 5000
  return { rows, scrollTop: Math.round(host.scrollTop), btn: !!document.querySelector('.to-top-btn') }
})
console.log('[list 滚动后]', JSON.stringify(listState))
await page.click('.to-top-btn')
await page.waitForTimeout(1200)
console.log('[list 点击回顶]', JSON.stringify(await page.evaluate(() => Math.round(document.querySelector('.channel-scroll-host').scrollTop))))
await browser.close()
