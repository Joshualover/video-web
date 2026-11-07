// 壳域名池的单元测试：端口保留（站点轮换常落在 :8899 这类非常规端口）、
// 非法目标拒绝（SSRF）、持久化文件隔离。全部离线，不访问外网。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'crawl-domains-'))
const domainFile = path.join(dir, 'domains.json')

// 预置一个带端口的历史发现域名，再加载模块（模块在 import 时读文件建池）
writeFileSync(
  domainFile,
  JSON.stringify({ domains: ['32d247.com:8899', 'evil.<script>'], updatedAt: Date.now() }),
  'utf8'
)
process.env.CRAWL_DOMAIN_FILE = domainFile

const m = await import('../server/crawler.js')

// 1) 池里带端口的域名要原样进 bases，不能被拼回 https://host（丢端口）
const bases = m.getCrawlBases()
assert.ok(bases.includes('https://32d247.com:8899'), `bases 应含带端口条目：${bases}`)
assert.ok(!bases.includes('https://32d247.com'), '不应出现丢端口后的 https://32d247.com')

// 2) 非法条目（含尖括号）不进池
assert.ok(!bases.some((b) => b.includes('<')), `非法域名应被过滤：${bases}`)

// 3) isAllowedBase 按完整 origin 匹配
assert.equal(m.isAllowedBase('https://32d247.com:8899'), true)
assert.equal(m.isAllowedBase('https://32d247.com'), false)

// 4) 内置池首位是当前可用域名（默认 base 不再指向已失效的旧壳域名）
assert.ok(bases[0].includes('hsck.cc'), `默认候选应优先新域名：${bases[0]}`)
assert.ok(m.DEFAULT_BASE.includes('hsck.cc'))

// 5) 发现新域名：SSRF 目标拒绝、合法带端口目标接受并落盘
assert.equal(await m.addDiscoveredDomain('http://127.0.0.1:8080/x'), null)
assert.equal(await m.addDiscoveredDomain('https://10.0.0.5/'), null)
assert.equal(await m.addDiscoveredDomain('https://not-a-domain'), null)

// 合法目标走 DNS，离线时可能失败——失败按「可疑域名忽略」返回 null，两种结果都合法
const maybe = await m.addDiscoveredDomain('https://www.example.com:8899/')
if (maybe === 'www.example.com:8899') {
  assert.ok(m.getCrawlBases().includes('https://www.example.com:8899'))
  const saved = JSON.parse(readFileSync(domainFile, 'utf8'))
  assert.ok(saved.domains.includes('www.example.com:8899'), '发现的端口应持久化')
}

console.log('crawl-domains tests passed')
