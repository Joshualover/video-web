import express from 'express'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  proxyFetch,
  tokenAllowed
} from './proxy-core.js'

const app = express()
const PORT = Number(process.env.PORT) || 8787
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '../dist')
const DATA_DIR = path.resolve(__dirname, '../data')
const ALLOWED_DATA_EXT = ['.m3u', '.m3u8', '.txt']
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

// 校验 data 目录文件名，防路径穿越（仅允许纯文件名 + 允许的扩展名）
function safeDataName(name) {
  if (typeof name !== 'string' || !name) return null
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null
  const ext = path.extname(name).toLowerCase()
  if (!ALLOWED_DATA_EXT.includes(ext)) return null
  return name
}

async function listDataFiles() {
  let entries
  try {
    entries = await readdir(DATA_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!ALLOWED_DATA_EXT.includes(path.extname(entry.name).toLowerCase())) continue
    try {
      const info = await stat(path.join(DATA_DIR, entry.name))
      files.push({ name: entry.name, size: info.size, modifiedAt: info.mtimeMs })
    } catch {
      // 忽略不可读文件
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name))
  return files
}

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

function assertProxyToken(req, res, next) {
  if (!tokenAllowed(req.query.token, req.headers.authorization || '')) {
    return res.status(401).json({ error: '缺少有效的访问令牌' })
  }
  next()
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'flow-player-proxy', time: Date.now() })
})

app.get('/api/proxy', assertProxyToken, async (req, res) => {
  const rawUrl = req.query.url
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return res.status(400).json({ error: '缺少 url 参数' })
  }
  try {
    const result = await proxyFetch(rawUrl)
    res.set('Content-Type', result.contentType)
    res.send(result.text)
  } catch (err) {
    const status = err.status || 500
    const message = err.message || '代理请求失败'
    res.status(status).json({ error: message })
  }
})

// ---- data 目录播放列表管理 ----

app.get('/api/playlists', async (_req, res) => {
  const files = await listDataFiles()
  res.json({ files })
})

app.get('/api/playlists/content', async (req, res) => {
  const name = safeDataName(req.query.name)
  if (!name) return res.status(400).json({ error: '文件名非法' })
  try {
    const content = await readFile(path.join(DATA_DIR, name), 'utf8')
    res.set('Content-Type', 'text/plain; charset=utf-8')
    res.send(content)
  } catch {
    res.status(404).json({ error: '文件不存在' })
  }
})

app.post(
  '/api/playlists',
  assertProxyToken,
  express.text({ limit: '10mb', type: '*/*' }),
  async (req, res) => {
    const name = safeDataName(req.query.name)
    if (!name) return res.status(400).json({ error: '文件名非法，仅支持 .m3u/.m3u8/.txt' })
    const content = req.body
    if (typeof content !== 'string' || content.trim() === '') {
      return res.status(400).json({ error: '上传内容为空' })
    }
    if (Buffer.byteLength(content) > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: '文件超过 10MB 限制' })
    }
    try {
      await writeFile(path.join(DATA_DIR, name), content, 'utf8')
      res.json({ ok: true, name })
    } catch {
      res.status(500).json({ error: '写入文件失败' })
    }
  }
)

if (existsSync(distDir)) {
  app.use(
    express.static(distDir, {
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          // Vite 构建产物带内容 hash，可长期缓存
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        } else {
          // index.html 等入口文件不缓存，保证拿到最新版本
          res.setHeader('Cache-Control', 'no-cache')
        }
      }
    })
  )
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      return res.sendFile(path.join(distDir, 'index.html'))
    }
    next()
  })
}

// data 目录被 .gitignore 忽略（不随代码部署），启动时自动创建
await mkdir(DATA_DIR, { recursive: true })

app.listen(PORT, () => {
  console.log(`[flow-player] API 代理已启动: http://localhost:${PORT}`)
})
