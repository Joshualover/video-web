import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'
const BASE = 'https://678060.xyz'
const KEYWORD = '佐佐波凌'
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, userAgent: 'Mozilla/5.0 Chrome/126' })
await page.goto(BASE + '/vodsearch/-------------.html?wd=' + encodeURIComponent(KEYWORD) + '&submit=', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {})
await page.waitForTimeout(2000)
const vids = await page.evaluate(() => {
  const out = []; const seen = new Set()
  for (const li of document.querySelectorAll('.stui-vodlist li, .stui-vodlist__box')) {
    const a = li.querySelector('a[href*="/v5/"]')
    if (!a) continue
    const href = a.getAttribute('href')
    if (seen.has(href)) continue
    seen.add(href)
    const detail = li.querySelector('.stui-vodlist__detail a')
    const title = detail?.textContent?.trim() || a.textContent?.trim() || ''
    if (title && title.length > 2 && !/^\d{1,2}:\d{2}$/.test(title)) out.push({ title: title.slice(0, 150), href })
  }
  return out
})
console.log('搜索结果:', vids.length)
async function getOne(href) {
  await page.goto(BASE + href, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
  return page.evaluate(async () => {
    const h1 = (document.querySelector('h1')?.textContent || document.title).replace(/\s*-\s*黄色仓库.*$/, '').trim()
    const s = [...document.querySelectorAll('script')].map(x => x.textContent).join('')
    const m = s.match(/var AID='(\d+)', ASID='(\d+)', ANID='(\d+)', AK='([0-9a-f]+)'/)
    if (!m) return { title: h1, err: 'noAK' }
    const [, id, sid, nid, tk] = m
    const body = `id=${id}&sid=${sid}&nid=${nid}&tk=${tk}&g=1&x=55&y=66&dt=1&sw=1280&sh=900&tz=-480&t=${Date.now()}`
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch('/static/count.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body })
        const j = JSON.parse(await r.text())
        if (j.ok && j.u) return { title: h1, url: atob(j.u) }
      } catch {}
      await new Promise((res) => setTimeout(res, 600))
    }
    return { title: h1, err: 'fail' }
  })
}
const results = []
for (let i = 0; i < vids.length; i++) {
  const r = await getOne(vids[i].href)
  console.log(`[${i + 1}/${vids.length}] ${r.url ? 'OK' : 'ERR(' + r.err + ')'} ${r.title?.slice(0, 45)}`)
  if (r.url) results.push({ title: r.title, url: r.url })
}
const out = { keyword: KEYWORD, results }
writeFileSync('/tmp/soso-result.json', JSON.stringify(out), 'utf8')
console.log('成功:', results.length, '| 已存临时结果')
await browser.close()
