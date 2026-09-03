// 从 678060.xyz「国产系列」分类抓取前 N 个视频的 m3u8 链接
// 用法: node scripts/fetch-site-m3u.mjs [数量] [输出文件]
import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'

const LIMIT = Number(process.argv[2] || 50)
const OUT = process.argv[3] || 'data/guochuan50.m3u'
const BASE = 'https://678060.xyz'

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox']
})
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
})

// 1. 收集分类页视频详情链接（支持翻页）
async function collectVodLinks() {
  const links = []
  const seen = new Set()
  for (let p = 1; p <= 4 && links.length < LIMIT; p++) {
    const url = p === 1 ? '/vodtype/2.html' : `/vodtype/2-${p}.html`
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(800)
    // 尝试滚动触发懒加载
    for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 2000); await page.waitForTimeout(250) }
    const found = await page.evaluate(() => {
      const out = []
      const seenLocal = new Set()
      for (const card of document.querySelectorAll('.stui-vodlist__box, .stui-vodlist li')) {
        const a = card.querySelector('a[href*="/v5/"]')
        const titleEl = card.querySelector('.stui-vodlist__detail a, .title a, a')
        if (!a) continue
        const href = a.getAttribute('href')
        if (seenLocal.has(href)) continue
        seenLocal.add(href)
        // 标题优先取卡片 detail，其次详情链接文本
        let t = (titleEl && titleEl !== a ? titleEl.textContent : a.textContent)?.trim() || ''
        // 过滤纯时长行
        if (/^\d{1,2}:\d{2}$/.test(t)) {
          const sibling = card.querySelectorAll('a')[1]
          t = sibling?.textContent?.trim() || t
        }
        if (!t || t.length < 2) continue
        out.push({ t: t.slice(0, 80), href })
      }
      return out
    })
    for (const l of found) {
      if (!seen.has(l.href)) { seen.add(l.href); links.push(l) }
    }
    console.log(`分类页 ${p}: 累计 ${links.length} 条`)
  }
  return links.slice(0, LIMIT)
}

// 2. 详情页提取 h1 标题 + 模拟解锁拿 m3u8
async function getOne(href) {
  await page.goto(BASE + href, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
  const r = await page.evaluate(async () => {
    const h1 = (document.querySelector('h1')?.textContent || document.title)
      .replace(/\s*-\s*黄色仓库.*$/, '')
      .trim()
    const s = [...document.querySelectorAll('script')].map(x => x.textContent).join('')
    const m = s.match(/var AID='(\d+)', ASID='(\d+)', ANID='(\d+)', AK='([0-9a-f]+)'/)
    if (!m) return { title: h1, err: 'noAK' }
    const [, id, sid, nid, tk] = m
    const body = `id=${id}&sid=${sid}&nid=${nid}&tk=${tk}&g=1&x=55&y=66&dt=1&sw=1280&sh=900&tz=-480&t=${Date.now()}`
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch('/static/count.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
          body
        })
        const j = JSON.parse(await resp.text())
        if (j.ok && j.u) return { title: h1, url: atob(j.u) }
      } catch { /* retry */ }
      await new Promise((res) => setTimeout(res, 800))
    }
    return { title: h1, err: 'fail' }
  })
  return r
}

// 主流程
const vods = await collectVodLinks()
console.log(`\n共 ${vods.length} 个视频，开始抓取 m3u8...`)
const results = []
for (let i = 0; i < vods.length; i++) {
  const r = await getOne(vods[i].href)
  const status = r.url ? 'OK' : `ERR(${r.err})`
  console.log(`[${i + 1}/${vods.length}] ${status} ${r.title?.slice(0, 30)}`)
  if (r.url) results.push({ title: r.title || vods[i].t, url: r.url })
}

// 输出 m3u
if (results.length) {
  const lines = ['#EXTM3U', `#PLAYLIST:国产系列前${results.length}`, '', '#EXTGRP:国产系列']
  for (const r of results) {
    lines.push(`#EXTINF:-1 group-title="国产系列",${r.title || '未命名'}`)
    lines.push(r.url)
  }
  writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
  console.log(`\n完成：${results.length} 条写入 ${OUT}`)
} else {
  console.log('\n未抓到任何 m3u8')
}
await browser.close()
