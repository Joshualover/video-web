import { proxyFetch, tokenAllowed } from '../server/proxy-core.js'

export const config = {
  runtime: 'nodejs20.x'
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res)
    return res.status(204).end()
  }
  setCors(res)

  if (req.method !== 'GET') {
    return res.status(405).json({ error: '仅支持 GET 请求' })
  }
  if (!tokenAllowed(req.query?.token, req.headers.authorization || '')) {
    return res.status(401).json({ error: '缺少有效的访问令牌' })
  }

  const rawUrl = req.query?.url
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return res.status(400).json({ error: '缺少 url 参数' })
  }

  try {
    const result = await proxyFetch(rawUrl)
    res.setHeader('Content-Type', result.contentType)
    return res.status(200).send(result.text)
  } catch (err) {
    const status = err.status || 500
    return res.status(status).json({ error: err.message || '代理请求失败' })
  }
}
