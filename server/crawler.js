// 站点 m3u8 爬虫（服务端）：搜索关键词 → 抓取播放地址 → 生成 m3u 文件
// 依赖真实浏览器内核（反爬 TLS 指纹）。浏览器路径：BROWSER_PATH 环境变量 > 自动探测。
// 用法:
//   API: 由 server/index.js 导入 searchSite()
//   CLI: node server/crawler.js 佐佐木纱希 30
import { chromium } from 'playwright-core'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseM3u } from '../src/lib/m3u.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 壳域名池（站点会轮换域名；抓详情时自动尝试池内可用域名）
export const DOMAINS = ['678060.xyz', '678063.xyz', '678064.xyz']
export const ALLOWED_CRAWL_BASES = DOMAINS.map((d) => `https://${d}`)
export const DEFAULT_BASE = process.env.CRAWL_BASE || 'https://678064.xyz'

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

// 详情页模拟解锁接口拿 m3u8（在多个候选域名间尝试，跳过被重定向/无效的壳）
async function fetchOne(page, bases, href) {
  for (const base of bases) {
    await page.goto(base + href, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
    const r = await page
      .evaluate(async () => {
        const h1 = (document.querySelector('h1')?.textContent || document.title)
          .replace(/\s*-\s*黄色仓库.*$/, '')
          .trim()
        const s = [...document.querySelectorAll('script')].map((x) => x.textContent).join('')
        const m = s.match(/var AID='(\d+)', ASID='(\d+)', ANID='(\d+)', AK='([0-9a-f]+)'/)
        if (!m) return { noAk: true }
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
              return /^https?:\/\//.test(decoded) ? { title: h1 || '未命名', url: decoded } : { noAk: true }
            }
          } catch {
            /* retry */
          }
          await new Promise((res) => setTimeout(res, 500))
        }
        return { noAk: true }
      })
      .catch(() => ({ noAk: true }))
    if (!r.noAk) return r
  }
  return { title: href, err: 'fail' }
}

function expandBases(base) {
  const list = [String(base || '').replace(/\/+$/, '')]
  for (const d of DOMAINS) {
    const u = `https://${d}`
    if (!list.includes(u)) list.push(u)
  }
  return list
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

// 仅搜索：返回候选列表（不抓 m3u8），快速
async function openBrowser() {
  const browserPath = findBrowser()
  if (!browserPath) {
    throw new Error('未找到可用浏览器内核（Edge/Chrome/Chromium），请安装并设置 BROWSER_PATH')
  }
  return chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox']
  })
}

async function newPage(browser) {
  return browser.newPage({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  })
}

export async function collectOnly(keyword, { base = DEFAULT_BASE, limit = 500 } = {}) {
  const cleanKeyword = String(keyword || '').trim()
  if (!cleanKeyword || cleanKeyword.length > 50) throw new Error('关键词无效')
  const cleanBase = String(base || '').replace(/\/+$/, '')
  const browser = await openBrowser()
  try {
    const page = await newPage(browser)
    const vods = await collectVodLinks(page, cleanBase, cleanKeyword, limit)
    return vods.map((v) => ({ title: v.title, href: v.href }))
  } finally {
    await browser.close().catch(() => {})
  }
}

// 抓取一批详情页的 m3u8（进度回调 done/total）
async function crawlItems(page, bases, items, onProgress) {
  const results = []
  for (let i = 0; i < items.length; i += 1) {
    const r = await fetchOne(page, bases, items[i].href)
    onProgress?.(i + 1, items.length, r.title)
    if (r.url) results.push({ title: r.title || items[i].title, url: r.url })
    await page.waitForTimeout(120)
  }
  return results
}

// 把条目并入目标 m3u（组 = group，命名 = 序号+标题，URL 去重）
export function mergeIntoM3u(filePath, group, items) {
  const raw = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  const channels = raw.trim()
    ? parseM3u(raw).channels.map((c) => ({ ...c }))
    : []
  const vUrls = new Set(channels.map((c) => c.url))
  const exist = channels.filter((c) => c.group === group)
  let next = exist.length ? Math.max(...exist.map((c) => parseInt(c.name, 10) || 0), 0) + 1 : 1
  let added = 0
  let dup = 0
  for (const it of items) {
    if (!it.url || vUrls.has(it.url)) {
      dup += 1
      continue
    }
    channels.push({
      id: '',
      name: `${next} ${it.title || '未命名'}`,
      url: it.url,
      logo: '',
      group,
      tvgId: '',
      duration: -1,
      attrs: {},
      valid: true,
      status: 'idle'
    })
    vUrls.add(it.url)
    next += 1
    added += 1
  }
  const lines = ['#EXTM3U', `#PLAYLIST:合并列表（${channels.length} 频道）`, '']
  let cur = null
  for (const c of channels) {
    if (c.group !== cur) {
      cur = c.group
      if (cur !== '未分类') lines.push(`#EXTGRP:${cur}`)
    }
    const dur = Number.isFinite(c.duration) ? c.duration : -1
    lines.push(`#EXTINF:${dur} group-title="${cur}",${c.name}`)
    lines.push(c.url)
  }
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf8')
  return { added, dup, total: channels.length, groupCount: new Set(channels.map((c) => c.group)).size }
}

// 抓取选中项 → 生成新文件或并入目标文件
export async function crawlAndSave({
  base = DEFAULT_BASE,
  items = [],
  mode = 'new', // 'new' 生成独立文件 | 'merge' 并入目标文件
  group = '',
  target = '',
  outDir = 'data',
  onProgress = null
} = {}) {
  const cleanBase = String(base || '').replace(/\/+$/, '')
  if (!items.length) throw new Error('未选择任何结果')
  const autoGroup = String(items[0]?.title?.match(/(IPZZ|PFES|SONE|SNOS|MKMP|SGKI|[A-Z]+-\d+)/)?.[0] || '')
  const cleanGroup = String(group || '').trim() || autoGroup || '抓取'
  const bases = expandBases(cleanBase)
  const browser = await openBrowser()
  try {
    const page = await newPage(browser)
    const results = await crawlItems(page, bases, items, onProgress)
    if (!results.length) throw new Error('全部抓取失败')
    if (mode === 'merge') {
      const filePath = path.resolve(outDir, path.basename(target))
      const report = mergeIntoM3u(filePath, cleanGroup, results)
      return { mode, file: path.basename(target), group: cleanGroup, ...report, crawled: results.length }
    }
    const filename = `${sanitizeName(cleanGroup)}.m3u`
    writeFileSync(path.resolve(outDir, filename), buildM3u(cleanGroup, results), 'utf8')
    return { mode, file: filename, group: cleanGroup, count: results.length, crawled: results.length }
  } finally {
    await browser.close().catch(() => {})
  }
}

// CLI: node server/crawler.js <关键词> [数量]  （整词抓取并生成独立文件）
const isCli = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (isCli) {
  const keyword = process.argv[2]
  const limit = Number(process.argv[3]) || 50
  const base = process.env.CRAWL_BASE || DEFAULT_BASE
  if (!keyword) {
    console.error('用法: node server/crawler.js <关键词> [数量]')
    process.exit(1)
  }
  ;(async () => {
    try {
      console.log('搜索中...')
      const list = await collectOnly(keyword, { base, limit })
      console.log(`共 ${list.length} 条，开始抓取...`)
      const r = await crawlAndSave({
        base,
        items: list,
        mode: 'new',
        outDir: 'data',
        onProgress: (done, total, title) => console.log(`[${done}/${total}] ${(title || '').slice(0, 40)}`)
      })
      console.log(`完成: ${r.crawled} 条 → data/${r.file}`)
    } catch (e) {
      console.error('失败:', e.message)
      process.exit(1)
    }
  })()
}
