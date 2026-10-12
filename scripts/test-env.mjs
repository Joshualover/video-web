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

console.log('env tests passed')
