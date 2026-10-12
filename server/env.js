// 极简 .env 读取（不引入 dotenv）
//
// 为什么需要：VOD_HTTP_PROXY / WEB_LOGIN / PROXY_TOKEN 这类配置每次启动都手打一遍很烦，
// 而仓库的 .gitignore 本来就把 .env 排除在外、只放行 .env.example，显然是留给这个用途的。
//
// 约定（刻意做得很简单，避免「为什么没生效」的困惑）：
//   - 只认 KEY=value，一行一条；空行与 # 开头的行忽略
//   - 值可以用单/双引号包起来，会去掉外层引号
//   - 不做变量展开、不支持多行值
//   - **已存在的真实环境变量优先**：命令行 / PM2 / Docker 上显式传的不会被 .env 覆盖
//   - 文件不存在就静默跳过（不设置 .env 时行为与以前完全一致）
//
// 必须在其它模块之前 import：proxy-core.js 在模块顶层就读 PROXY_TOKEN /
// ALLOW_PRIVATE_NETWORK / ALLOW_INSECURE_TLS，晚了就来不及。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENV_FILE = process.env.ENV_FILE || path.resolve(__dirname, '../.env')

export function parseEnv(text) {
  const out = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = trimmed.slice(eq + 1).trim()
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    if (quoted && value.length >= 2) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

export function loadEnvFile(file = ENV_FILE, target = process.env) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { file, loaded: [], skipped: [] }
  }
  const loaded = []
  const skipped = []
  for (const [key, value] of Object.entries(parseEnv(text))) {
    // 真实环境变量优先
    if (target[key] !== undefined && target[key] !== '') {
      skipped.push(key)
      continue
    }
    target[key] = value
    loaded.push(key)
  }
  if (loaded.length) console.log(`[env] 已从 ${path.basename(file)} 载入：${loaded.join(', ')}`)
  return { file, loaded, skipped }
}

loadEnvFile()
