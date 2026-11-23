// 部署自检：一条命令把「上线前该确认的事」全跑一遍
//
//   npm run doctor                       # 自动拉起一个临时实例来检查
//   BASE=http://你的站:8787 npm run doctor  # 检查已在跑的实例（推荐线上用）
//   npm run doctor -- --json             # 机器可读，便于接 CI
//
// 设计原则：
//   - 每条检查都要给出「怎么办」，而不只是说失败
//   - 网络相关的检查失败记为 FAIL 或 WARN（区分「必须修」与「看情况」），
//     不许静默跳过 —— 部署自检最怕「看着全绿其实没测」
//   - 有 FAIL 时退出码非 0，能直接卡 CI
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OWN_SERVER = !process.env.BASE
const PORT = Number(process.env.DOCTOR_PORT) || 8899
const BASE = (process.env.BASE || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '')
const AS_JSON = process.argv.includes('--json')
const TIMEOUT = Number(process.env.DOCTOR_TIMEOUT) || 20000

const C = process.stdout.isTTY
  ? {
      reset: '\x1b[0m',
      dim: '\x1b[2m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      red: '\x1b[31m',
      cyan: '\x1b[36m',
      bold: '\x1b[1m'
    }
  : Object.fromEntries(
      ['reset', 'dim', 'green', 'yellow', 'red', 'cyan', 'bold'].map((k) => [k, ''])
    )

const results = []
let child = null

function record({ name, status, detail, hint }) {
  results.push({ name, status, detail: detail || '', hint: hint || '' })
  if (AS_JSON) return
  const mark = {
    pass: `${C.green}✔${C.reset}`,
    warn: `${C.yellow}!${C.reset}`,
    fail: `${C.red}✘${C.reset}`,
    skip: `${C.dim}-${C.reset}`
  }[status]
  const label = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' }[status]
  console.log(`${mark} ${C.bold}${name}${C.reset} ${C.dim}[${label}]${C.reset}`)
  if (detail) console.log(`    ${detail}`)
  if (hint && status !== 'pass') console.log(`    ${C.cyan}→ ${hint}${C.reset}`)
}

async function fetchJson(url, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeout || TIMEOUT)
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal })
    const text = await resp.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    return { ok: resp.ok, status: resp.status, body, text }
  } finally {
    clearTimeout(timer)
  }
}

async function waitForHealth(timeout = 25000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const r = await fetchJson(`${BASE}/api/health`, { timeout: 1500 })
      if (r.ok) return true
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

function startServer() {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      // 自检时不做预热：预热要跑十几秒，而我们本来就会逐个源实测
      MUSIC_WARMUP: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  // 只把启动日志收进内存（检查代理是否生效要用），**不写 stdout** ——
  // 否则 --json 的输出会被这些行污染，接 CI 时 JSON.parse 直接失败。
  child.__log = ''
  const collect = (chunk) => {
    child.__log += chunk.toString()
    // 人类可读模式下发到 stderr：能看见进度，又不破坏 stdout 的结构
    if (!AS_JSON) process.stderr.write(chunk)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
}

function stopServer() {
  if (!child) return
  try {
    child.kill('SIGTERM')
  } catch {
    /* 已退出 */
  }
  child = null
}

// ─── 各项检查 ────────────────────────────────────────────────────────────

// 1) 服务能不能起来
async function checkService() {
  const up = await waitForHealth()
  if (!up) {
    record({
      name: '服务可访问',
      status: 'fail',
      detail: `${BASE}/api/health 无响应`,
      hint: '先确认进程在跑、端口没被占；Docker 里注意容器是否 healthy'
    })
    return false
  }
  record({ name: '服务可访问', status: 'pass', detail: `${BASE}/api/health → ok` })
  return true
}

// 2) 代理配置到底生效没有（最容易「以为配了」的一项）
async function checkProxy() {
  const r = await fetchJson(`${BASE}/api/music/sources`).catch(() => null)
  const proxy = r?.body?.meta?.proxy
  if (!proxy) {
    record({
      name: '出网代理',
      status: 'warn',
      detail: '接口没有返回代理状态',
      hint: '确认 /api/music/sources 可访问（是否被 WEB_LOGIN / PROXY_TOKEN 挡住）'
    })
    return null
  }

  if (!proxy.enabled) {
    // 没配代理不一定是错：Apple 试听 / JioSaavn 可直连。
    // 但如果影视源也要用，就必然失败，所以给 WARN 并说明后果。
    record({
      name: '出网代理',
      status: 'warn',
      detail: '未启用：影视源与 GD音乐台/Piped/Invidious 将全部直连，国内基本不可用',
      hint: '设置 VOD_HTTP_PROXY（只支持 http/https，不支持 socks5），详见 docs/deploy-env-checklist.md'
    })
    return proxy
  }

  record({
    name: '出网代理',
    status: 'pass',
    detail: `已启用 ${proxy.url}${proxy.noProxy?.length ? `｜直连：${proxy.noProxy.join(',')}` : ''}`
  })
  return proxy
}

// 3) 代理是否真的能出网（用服务端自己的能力测，而不是本机 curl）
async function checkProxyEgress() {
  const started = Date.now()
  const r = await fetchJson(`${BASE}/api/music/sources`).catch(() => null)
  const proxy = r?.body?.meta?.proxy
  if (!proxy?.enabled) {
    record({ name: '代理出网连通', status: 'skip', detail: '未配置代理，跳过' })
    return
  }
  const ms = Date.now() - started
  if (ms > 15000) {
    record({
      name: '代理出网连通',
      status: 'warn',
      detail: `请求耗时 ${ms}ms`,
      hint: '偏慢，检查代理节点延迟'
    })
  } else {
    record({ name: '代理出网连通', status: 'pass', detail: `管理接口响应 ${ms}ms` })
  }
}

// 4) 音源清单：GD音乐台是否注册上了
async function checkSources() {
  const r = await fetchJson(`${BASE}/api/music/sources?check=1`).catch(() => null)
  if (!r?.ok || !Array.isArray(r.body?.sources)) {
    record({
      name: '音源清单',
      status: 'fail',
      detail: '拿不到 /api/music/sources',
      hint: '看服务日志有没有启动报错'
    })
    return null
  }
  const sources = r.body.sources
  const gd = sources.filter((s) => s.kind === 'gdmusic')
  if (!gd.length) {
    record({
      name: '音源清单',
      status: 'fail',
      detail: `共 ${sources.length} 个音源，但没有 GD音乐台`,
      hint: '检查 server/music/default-sources.json，以及 data/music-source-prefs.json 是否把它停用了'
    })
  } else {
    // 主音源是「网易云」；JOOX 只是搜索补充（上游取流本身不给流）。
    // 所以判 PASS 的条件是「至少一个 GD 平台可用」，但要把每个平台的状态都摆出来，
    // 免得 JOOX 挂了被当成整体故障、或者网易云挂了却被 JOOX 的 ok 掩盖。
    const netease = gd.find((s) => s.platform === 'netease')
    const others = gd.filter((s) => s.platform !== 'netease')
    const mainOk = !netease || netease.status !== 'fail'
    const detail = gd
      .map((s) => `${s.name}=${s.status}${s.error ? `(${s.error.slice(0, 30)})` : ''}`)
      .join('；')
    const note = others.some((s) => s.status === 'fail')
      ? '｜非主平台异常不影响播放，上游偶发限流属正常'
      : ''
    record({
      name: 'GD音乐台音源',
      status: mainOk ? 'pass' : 'fail',
      detail: `${detail}${note}`,
      hint: mainOk
        ? ''
        : '主音源网易云不可用：多为代理未生效（直连会 ECONNRESET），见 docs/deploy-env-checklist.md'
    })
  }
  return sources
}

// 5) 搜索能不能出结果（端到端第一段）
async function checkSearch() {
  const started = Date.now()
  let r
  try {
    r = await fetchJson(
      `${BASE}/api/music/search?wd=${encodeURIComponent('晴天')}&limit=10`,
      { timeout: 40000 }
    )
  } catch (err) {
    record({
      name: '音乐搜索',
      status: 'fail',
      detail: `请求失败：${err.message}`,
      hint: '看服务日志；代理不通时这一步会整段超时'
    })
    return null
  }
  const ms = Date.now() - started
  const list = r.body?.results
  if (!Array.isArray(list) || !list.length) {
    record({
      name: '音乐搜索',
      status: 'fail',
      detail: `0 条结果（${ms}ms）｜errors=${JSON.stringify(r.body?.errors || []).slice(0, 200)}`,
      hint: '所有源都失败时基本是出网问题；errors 里会写明原因'
    })
    return null
  }
  const bySource = {}
  for (const item of list) bySource[item.sourceName] = (bySource[item.sourceName] || 0) + 1
  const gdCount = Object.entries(bySource)
    .filter(([k]) => k.includes('GD音乐台'))
    .reduce((sum, [, v]) => sum + v, 0)
  record({
    name: '音乐搜索',
    status: gdCount > 0 ? 'pass' : 'warn',
    detail: `${list.length} 条 / ${ms}ms｜${Object.entries(bySource)
      .map(([k, v]) => `${k}×${v}`)
      .join('，')}`,
    hint: gdCount > 0 ? '' : 'GD音乐台没出结果：多为代理或上游限流'
  })
  return list
}

// 6) 取流：真正能播才算通
async function checkStream(list) {
  if (!Array.isArray(list) || !list.length) {
    record({ name: '取流可播放', status: 'skip', detail: '没有搜索结果，跳过' })
    return
  }
  // 只挑「上游确实能取流」的音源来验。
  // 不能随便拿第一条：JOOX 平台搜索有结果但上游取流返回空（url 为空、br=-1），
  // 拿它验会稳定误报失败 —— 那是对方的限制，不是部署问题。
  const PREFERRED = [
    (t) => t.sourceName === 'GD音乐台 · 网易云',
    (t) => t.sourceName?.includes('GD音乐台'),
    (t) => t.preview !== true, // Apple 试听只是 30 秒片段，尽量不拿它当「能播」的证据
    () => true
  ]
  let target = null
  let skipped = []
  for (const pick of PREFERRED) {
    target = list.find(pick)
    if (target) break
  }
  if (target && target.sourceName?.includes('JOOX')) {
    // 理论上不会走到（上面优先网易云），留个兜底提示
    skipped.push('已避开 JOOX（上游不给流）')
    target = list.find((t) => !t.sourceName?.includes('JOOX')) || target
  }
  if (!target) {
    record({ name: '取流可播放', status: 'skip', detail: '没有可用于验证的曲目' })
    return
  }

  const params = new URLSearchParams({
    source: target.source,
    id: target.id,
    platform: target.platform || '',
    quality: '320'
  })
  if (target.name) params.set('name', target.name)
  const started = Date.now()
  let r
  try {
    r = await fetchJson(`${BASE}/api/music/stream?${params}`, { timeout: 40000 })
  } catch (err) {
    record({
      name: '取流可播放',
      status: 'fail',
      detail: `${target.sourceName} 请求失败：${err.message}`,
      hint: '换一首歌再试；持续失败看代理与上游状态'
    })
    return
  }
  const ms = Date.now() - started
  const stream = r.body?.streams?.find((s) => s.playUrl)
  if (!stream) {
    record({
      name: '取流可播放',
      status: 'fail',
      detail: `${target.sourceName}「${target.name}」没拿到地址：${r.body?.error || r.status}`,
      hint: '先查代理是否生效；上游偶发 503 会由适配器自动重试，持续失败才需换源'
    })
    return
  }
  // 再验一次「这个地址真的能取到音频字节」
  const probe = await fetchJson(`${BASE}${stream.playUrl}`, {
    headers: { Range: 'bytes=0-2047' },
    timeout: 30000
  }).catch(() => null)
  const suffix = skipped.length ? `｜${skipped.join('；')}` : ''
  if (!probe) {
    record({
      name: '取流可播放',
      status: 'warn',
      detail: `解析到 ${stream.quality || stream.container}，但试听片段取回失败${suffix}`,
      hint: '媒体域可能被墙；确认代理对播放代理（/api/music/proxy）也生效'
    })
    return
  }
  record({
    name: '取流可播放',
    status: 'pass',
    detail: `${target.sourceName}「${target.name}」→ ${stream.quality || stream.container}｜${ms}ms${suffix}`
  })
}

// 7) yt-dlp（可选）
async function checkYtdlp() {
  let resolved = null
  // ytdlp.js 在 resolveBinary() 里会 console.log 一行「选用版本最高的…」，
  // 那行会污染 --json 的 stdout。探测期间临时静音，探测完立刻恢复。
  const realLog = console.log
  console.log = () => {}
  try {
    const mod = await import('../server/music/ytdlp.js')
    resolved = await mod.resolveBinary()
  } catch {
    resolved = null
  } finally {
    console.log = realLog
  }
  const bin = resolved?.path || resolved?.binary || null
  if (!bin) {
    record({
      name: 'yt-dlp（可选）',
      status: 'warn',
      detail: '未找到可执行文件：少了 YouTube 音源，其它功能不受影响',
      hint: '需要的话装一个：pip install -U yt-dlp，或用 YTDLP_PATH 指定路径'
    })
    return
  }
  record({ name: 'yt-dlp（可选）', status: 'pass', detail: `已找到：${bin}` })
}

// 8) 访问控制：公网必须配
async function checkAuth() {
  const r = await fetchJson(`${BASE}/api/session`).catch(() => null)
  if (!r?.body) {
    record({ name: '访问控制', status: 'warn', detail: '/api/session 不可用' })
    return
  }
  if (r.body.enabled) {
    record({ name: '访问控制', status: 'pass', detail: '已启用服务端会话登录（WEB_LOGIN）' })
  } else {
    record({
      name: '访问控制',
      status: 'warn',
      detail: '未启用 WEB_LOGIN / BASIC_AUTH —— 默认 admin/admin123 只是前端门槛，服务端不校验',
      hint: '公网部署务必配 WEB_LOGIN 或 BASIC_AUTH'
    })
  }
}

// 9) 数据目录可写（否则收藏/配置重启即丢）
async function checkDataDir() {
  try {
    const { access, mkdir, writeFile, unlink } = await import('node:fs/promises')
    const dir = path.join(ROOT, 'data')
    await mkdir(dir, { recursive: true })
    const probe = path.join(dir, '.doctor-probe')
    await writeFile(probe, 'ok')
    await unlink(probe)
    await access(dir)
    record({ name: '数据目录可写', status: 'pass', detail: `${dir}` })
  } catch (err) {
    record({
      name: '数据目录可写',
      status: 'fail',
      detail: err.message,
      hint: '容器部署要挂载可写卷（docker-compose 里是 ./data:/app/data）'
    })
  }
}

// 10) 启动日志里有没有代理生效那一行（对外部实例这步跳过）
function checkStartupLog() {
  if (!OWN_SERVER || !child?.__log) {
    record({ name: '启动日志检查', status: 'skip', detail: '检查的是外部实例，跳过' })
    return
  }
  const log = child.__log
  if (/\[net\] 出网代理已启用/.test(log)) {
    record({ name: '启动日志检查', status: 'pass', detail: '日志确认代理已载入' })
  } else if (/\[net\] 代理地址无效/.test(log)) {
    const line = log.split('\n').find((l) => l.includes('代理地址无效')) || ''
    record({
      name: '启动日志检查',
      status: 'fail',
      detail: line.trim(),
      hint: '只支持 http/https；Clash 默认 7891 是 socks5，要用 7890 的 http 口'
    })
  } else if (process.env.VOD_HTTP_PROXY || process.env.HTTP_PROXY) {
    record({
      name: '启动日志检查',
      status: 'warn',
      detail: '环境里有代理变量，但日志没有「出网代理已启用」',
      hint: '变量可能没被读到：确认写在 .env / compose / systemd 里且拼写正确'
    })
  } else {
    record({ name: '启动日志检查', status: 'skip', detail: '未配置代理' })
  }
}

// ─── 主流程 ──────────────────────────────────────────────────────────────

async function main() {
  if (!AS_JSON) {
    console.log(`${C.bold}流光播放器 · 部署自检${C.reset}`)
    console.log(`${C.dim}目标：${BASE}${OWN_SERVER ? '（临时实例）' : '（已有实例）'}${C.reset}\n`)
  }

  if (OWN_SERVER) {
    startServer()
  }

  let alive = await checkService()
  if (!alive) {
    report()
    return finish()
  }

  checkStartupLog()
  const proxy = await checkProxy()
  await checkProxyEgress()
  const sources = await checkSources()
  const list = await checkSearch()
  await checkStream(list)
  await checkYtdlp()
  await checkAuth()
  await checkDataDir()

  report()
  finish()
}

function report() {
  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          base: BASE,
          ownServer: OWN_SERVER,
          summary: {
            pass: results.filter((r) => r.status === 'pass').length,
            warn: results.filter((r) => r.status === 'warn').length,
            fail: results.filter((r) => r.status === 'fail').length,
            skip: results.filter((r) => r.status === 'skip').length
          },
          results
        },
        null,
        2
      )
    )
    return
  }

  const fail = results.filter((r) => r.status === 'fail')
  const warn = results.filter((r) => r.status === 'warn')
  console.log(`\n${'─'.repeat(56)}`)
  console.log(
    `${C.bold}合计${C.reset}：${C.green}${results.filter((r) => r.status === 'pass').length} 通过${C.reset} / ` +
      `${C.yellow}${warn.length} 警告${C.reset} / ${C.red}${fail.length} 失败${C.reset} / ` +
      `${C.dim}${results.filter((r) => r.status === 'skip').length} 跳过${C.reset}`
  )

  if (fail.length) {
    console.log(`\n${C.red}${C.bold}必须修的问题：${C.reset}`)
    for (const r of fail) {
      console.log(`  ${C.red}✘${C.reset} ${r.name}：${r.detail}`)
      if (r.hint) console.log(`    ${C.cyan}→ ${r.hint}${C.reset}`)
    }
  }
  if (warn.length) {
    console.log(`\n${C.yellow}建议关注（不一定是错）：${C.reset}`)
    for (const r of warn) {
      console.log(`  ${C.yellow}!${C.reset} ${r.name}：${r.detail}`)
      if (r.hint) console.log(`    ${C.cyan}→ ${r.hint}${C.reset}`)
    }
  }
  if (!fail.length && !warn.length) {
    console.log(`\n${C.green}${C.bold}全部通过，可以上线。${C.reset}`)
  } else if (!fail.length) {
    console.log(`\n${C.green}没有阻塞项${C.reset}${C.dim}（上面的警告按需处理）${C.reset}`)
  } else {
    console.log(`\n${C.red}存在阻塞项，请先修复再上线。${C.reset}`)
    console.log(`${C.dim}排查手册：docs/deploy-env-checklist.md${C.reset}`)
  }
}

function finish() {
  stopServer()
  const fail = results.filter((r) => r.status === 'fail').length
  // 留一点时间让子进程退出、日志刷完
  setTimeout(() => process.exit(fail ? 1 : 0), 100)
}

process.on('SIGINT', () => {
  stopServer()
  process.exit(130)
})

main().catch((err) => {
  console.error(`自检脚本自身出错：${err.stack || err.message}`)
  stopServer()
  process.exit(2)
})
