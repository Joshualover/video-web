import express from 'express'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  proxyFetch,
  httpError,
  tokenAllowed
} from './proxy-core.js'

const app = express()
const PORT = Number(process.env.PORT) || 8787
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '../dist')

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
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

app.listen(PORT, () => {
  console.log(`[flow-player] API 代理已启动: http://localhost:${PORT}`)
})
