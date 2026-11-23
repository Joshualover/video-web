// .env 解析的单元测试（真正影响配置的边界都覆盖一下）
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { parseEnv, loadEnvFile } from '../server/env.js'

// 基本形态：注释、空行、前后空格
assert.deepEqual(
  parseEnv(['# 注释', '', '  ', 'A=1', 'B = two ', '#C=3'].join('\n')),
  { A: '1', B: 'two' }
)

// 值里可以出现 = 与 #
assert.deepEqual(parseEnv('TOKEN=a=b#c'), { TOKEN: 'a=b#c' })
// 引号去掉外层，里面保留
assert.deepEqual(parseEnv('A="x y"\nB=\'p q\''), { A: 'x y', B: 'p q' })
// 空值要保留（用来显式关掉某个开关）
assert.deepEqual(parseEnv('EMPTY='), { EMPTY: '' })
// 非法 key 直接丢，不要写进 process.env
assert.deepEqual(parseEnv('2BAD=1\nGOOD=ok'), { GOOD: 'ok' })
assert.deepEqual(parseEnv('NOEQUALS'), {})
assert.deepEqual(parseEnv(''), {})
assert.deepEqual(parseEnv(null), {})

// 载入：不存在的文件静默跳过
const missing = loadEnvFile('/tmp/definitely-not-here-xyz.env', {})
assert.deepEqual(missing.loaded, [])
assert.deepEqual(missing.skipped, [])

// 载入：真实环境变量优先，不被文件覆盖
const target = { KEEP: 'from-shell' }
// 用 fileURLToPath 而不是 .pathname：仓库路径里有中文，pathname 是百分号编码的
const sample = fileURLToPath(new URL('./fixtures/env-sample.env', import.meta.url))
const result = loadEnvFile(sample, target)
assert.deepEqual(result.loaded.sort(), ['ADDED', 'EMPTY'])
assert.deepEqual(result.skipped, ['KEEP'])
assert.equal(target.KEEP, 'from-shell')
assert.equal(target.ADDED, 'from-file')
assert.equal(target.EMPTY, '')

// ─── 出网代理的凭据边界（回归：曾把带密码的地址下发给前端） ────────────────
// net.js 在模块顶层读一次环境变量，所以这里用子进程跑，才能换环境反复验证。
import { execFileSync } from 'node:child_process'
// net.js 在模块顶层会往 stdout 打「[net] 出网代理已启用…」，所以只取最后一个 JSON 行
const probe = (env, expr) => {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', expr], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  const line = stdout
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item.startsWith('{'))
    .pop()
  if (!line) throw new Error(`探测脚本没有输出 JSON：${stdout.slice(0, 200)}`)
  return line
}

const CRED_EXPR = `
  const { proxyStatus, proxyForTools } = await import(${JSON.stringify(
    fileURLToPath(new URL('../server/net.js', import.meta.url))
  )});
  console.log(JSON.stringify({ status: proxyStatus(), tools: proxyForTools() }));
`

// 带认证：展示用必须脱敏，子进程用必须带凭据
const withAuth = JSON.parse(
  probe({ VOD_HTTP_PROXY: 'http://user:p%40ss@127.0.0.1:7890' }, CRED_EXPR)
)
assert.equal(withAuth.status.url, 'http://127.0.0.1:7890', '下发给前端的代理地址不能带账号密码')
assert.ok(!JSON.stringify(withAuth.status).includes('p%40ss'), '接口响应不得包含代理密码')
assert.ok(!('urlForTools' in withAuth.status), '带凭据的字段不应混进展示结构')
assert.equal(withAuth.tools.url, 'http://user:p%40ss@127.0.0.1:7890', 'yt-dlp 需要带凭据的地址')

// 无认证：两者一致
const noAuth = JSON.parse(probe({ VOD_HTTP_PROXY: 'http://127.0.0.1:7890' }, CRED_EXPR))
assert.equal(noAuth.status.url, 'http://127.0.0.1:7890')
assert.equal(noAuth.tools.url, 'http://127.0.0.1:7890')

// 未配置：都为空，且不应误报可用
const none = JSON.parse(probe({ VOD_HTTP_PROXY: '' }, CRED_EXPR))
assert.equal(none.status.enabled, false)
assert.equal(none.tools.enabled, false)

// 不支持的协议要被忽略，而不是静默当成直连却以为配好了
const socks = JSON.parse(probe({ VOD_HTTP_PROXY: 'socks5://127.0.0.1:1080' }, CRED_EXPR))
assert.equal(socks.status.enabled, false, '只支持 http/https 代理，socks5 应被忽略')

console.log('env tests passed')
