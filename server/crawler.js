// 站点 m3u8 爬虫（服务端）：搜索关键词 → 抓取播放地址 → 生成 m3u 文件
// 依赖真实浏览器内核（反爬 TLS 指纹）。浏览器路径：BROWSER_PATH 环境变量 > 自动探测。
// 用法:
//   API: 由 server/index.js 导入 searchSite()
//   CLI: node server/crawler.js 佐佐木纱希 30
import { chromium } from 'playwright-core'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_BASE = process.env.CRAWL_BASE || 'https://678060.xyz'

const BROWSER_CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
].filter(Boolean)

export function findBrowser() {
  for (const p of BROWSER_CANDIDATES) {
    if (p && existsSync(p)) return p
  }
  return null
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'unnamed'
}

// 收集搜索结果（支持翻页）
async function collectVodLinks(page, base, keyword, limit) {
  const links = []
  const seen = new Set()
  const searchUrl = `${base}/vodsearch/-------------.html?wd=${encodeURIComponent(keyword)}&submit=`
  for (let p = 1; p <= 8 && links.length < limit; p += 1) {
    const url = p === 1 ? searchUrl : `${searchUrl}&page=${p}`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(700)
    for (let i = 0; i < 5; i += 1) {
      await page.mouse.wheel(0, 1800)
      await page.waitForTimeout(200)
    }
    const found = await page.evaluate(() => {
      const out = []
      const local = new Set()
      for (const li of document.querySelectorAll('.stui-vodlist li, .stui-vodlist__box')) {
        const a = li.querySelector('a[href*="/v5/"]')
        if (!a) continue
        const href = a.getAttribute('href')
        if (local.has(href)) continue
        local.add(href)
        const detail = li.querySelector('.stui-vodlist__detail a')
        const title = detail?.textContent?.trim() || a.textContent?.trim() || ''
        if (!title || title.length < 2 || /^\d{1,2}:\d{2}$/.test(title)) continue
        out.push({ title: title.slice(0, 150), href })
      }
      return out
    })
    let newCount = 0
    for (const l of found) {
      if (!seen.has(l.href)) {
        seen.add(l.href)
        links.push(l)
        newCount += 1
      }
    }
    console.log(`[crawler] page ${p}: found ${found.length} new ${newCount} total ${links.length} url=${url.slice(0, 90)}`)
    if (newCount === 0) break // 翻页无新内容则停止
  }
  return links.slice(0, limit)
}

// 详情页模拟解锁接口拿 m3u8
async function fetchOne(page, base, href) {
  await page.goto(base + href, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
  return page.evaluate(async () => {
    const h1 = (document.querySelector('h1')?.textContent || document.title)
      .replace(/\s*-\s*黄色仓库.*$/, '')
      .trim()
    const s = [...document.querySelectorAll('script')].map((x) => x.textContent).join('')
    const m = s.match(/var AID='(\d+)', ASID='(\d+)', ANID='(\d+)', AK='([0-9a-f]+)'/)
    if (!m) return { title: h1, err: 'noAK' }
    const [, id, sid, nid, tk] = m
    const body = `id=${id}&sid=${sid}&nid=${nid}&tk=${tk}&g=1&x=55&y=66&dt=1&sw=1280&sh=900&tz=-480&t=${Date.now()}`
    for (let i = 0; i < 3; i += 1) {
      try {
        const resp = await fetch('/static/count.php', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest'
          },
          body
        })
        const j = JSON.parse(await resp.text())
        if (j.ok && j.u) {
          const decoded = atob(j.u)
          return /^https?:\/\//.test(decoded) ? { title: h1, url: decoded } : { title: h1, err: 'badUrl' }
        }
      } catch {
        /* retry */
      }
      await new Promise((res) => setTimeout(res, 600))
    }
    return { title: h1, err: 'fail' }
  })
}

// 生成 m3u 内容（组 = 关键词，条目命名 = 序号+标题）
function buildM3u(keyword, items) {
  const lines = ['#EXTM3U', `#PLAYLIST:${keyword}（${items.length}）`, '', `#EXTGRP:${keyword}`]
  items.forEach((item, idx) => {
    lines.push(`#EXTINF:-1 group-title="${keyword}",${idx + 1} ${item.title || '未命名'}`)
    lines.push(item.url)
  })
  return lines.join('\n') + '\n'
}

// 主入口
export async function searchSite(keyword, { base = DEFAULT_BASE, limit = 50, outDir = 'data', onProgress = null } = {}) {
  const cleanKeyword = String(keyword || '').trim()
  if (!cleanKeyword || cleanKeyword.length > 50) {
    throw new Error('关键词无效')
  }
  const cleanBase = String(base || '').replace(/\/+$/, '')
  if (!/^https?:\/\//.test(cleanBase)) {
    throw new Error('站点地址无效')
  }
  const browserPath = findBrowser()
  if (!browserPath) {
    throw new Error('未找到可用浏览器内核（Edge/Chrome/Chromium），请安装并设置 BROWSER_PATH')
  }
  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox']
  })
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    })
    const vods = await collectVodLinks(page, cleanBase, cleanKeyword, limit)
    const items = []
    for (let i = 0; i < vods.length; i += 1) {
      const r = await fetchOne(page, cleanBase, vods[i].href)
      onProgress?.(i + 1, vods.length, r.title)
      if (r.url) items.push({ title: r.title, url: r.url })
      await page.waitForTimeout(120)
    }
    const filename = `${sanitizeName(cleanKeyword)}.m3u`
    const filePath = path.resolve(outDir, filename)
    writeFileSync(filePath, buildM3u(cleanKeyword, items), 'utf8')
    return { file: filename, keyword: cleanKeyword, count: items.length, total: vods.length }
  } finally {
    await browser.close().catch(() => {})
  }
}

// CLI: node server/crawler.js <关键词> [数量]
const isCli = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (isCli) {
  const keyword = process.argv[2]
  const limit = Number(process.argv[3]) || 50
  if (!keyword) {
    console.error('用法: node server/crawler.js <关键词> [数量]')
    process.exit(1)
  }
  searchSite(keyword, { limit, onProgress: (i, total, title) => console.log(`[${i}/${total}] ${(title || '').slice(0, 40)}`) })
    .then((r) => console.log(`完成: ${r.count} 条 → data/${r.file}`))
    .catch((e) => {
      console.error('失败:', e.message)
      process.exit(1)
    })
}
