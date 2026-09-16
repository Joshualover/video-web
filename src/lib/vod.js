// 影视聚合接口客户端（对应 server 端 /api/vod/*）
async function apiGet(path, params = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    query.set(key, String(value))
  }
  const url = query.toString() ? `${path}?${query}` : path
  const resp = await fetch(url)
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(data.error || `请求失败（${resp.status}）`)
  return data
}

async function apiSend(path, body, method = 'POST') {
  const resp = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(data.error || `请求失败（${resp.status}）`)
  return data
}

export const vodApi = {
  sources: (opts = {}) => {
    const params = {}
    if (opts.check) params.check = 1
    if (opts.refresh) params.refresh = 1
    if (opts.deadline) params.deadline = opts.deadline
    return apiGet('/api/vod/sources', params)
  },
  categories: (site) => apiGet('/api/vod/categories', { site }),
  list: (site, type, page) => apiGet('/api/vod/list', { site, type, page }),
  search: (wd, opts = {}) => apiGet('/api/vod/search', { wd, ...opts }),
  detail: (site, id) => apiGet('/api/vod/detail', { site, id }),
  play: (url) => apiGet('/api/vod/play', { url }),
  best: (wd, opts = {}) => apiGet('/api/vod/best', { wd, ...opts }),
  configs: () => apiGet('/api/vod/configs'),
  addConfig: (body) => apiSend('/api/vod/configs', body),
  updateConfig: (id, body) => apiSend(`/api/vod/configs/${id}`, body, 'PUT'),
  removeConfig: (id) => apiSend(`/api/vod/configs/${id}`, null, 'DELETE'),
  refreshConfigs: (id) => apiSend('/api/vod/configs/refresh', id ? { id } : {}),
  // 源级启停 / 单源检测
  setSourceEnabled: (id, enabled) => apiSend(`/api/vod/sources/${id}`, { enabled }, 'PUT'),
  checkSource: (id) => apiSend(`/api/vod/sources/${id}/check`, {}),
  // 豆瓣榜单（发现页）
  doubanOptions: () => apiGet('/api/vod/douban/options'),
  doubanHot: (params) => apiGet('/api/vod/douban/hot', params)
}

// 海报统一走服务端图片代理：源站防盗链 / http 图片在 https 页面会被浏览器拦掉。
// 部署时若设置了 PROXY_TOKEN，可通过构建变量 VITE_PROXY_TOKEN 带上令牌。
export function vodImage(url) {
  const raw = String(url || '').trim()
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw)) return raw
  const token = import.meta.env?.VITE_PROXY_TOKEN
  const query = `url=${encodeURIComponent(raw)}${token ? `&token=${encodeURIComponent(token)}` : ''}`
  return `/api/vod/image?${query}`
}

// 把分类拆成「顶级 + 子级」两层，兼容扁平分类
export function groupCategories(classes) {
  const list = Array.isArray(classes) ? classes : []
  const ids = new Set(list.map((c) => c.id))
  const roots = list.filter((c) => !c.pid || c.pid === '0' || !ids.has(c.pid))
  const childrenOf = new Map()
  for (const c of list) {
    if (!c.pid || c.pid === '0' || !ids.has(c.pid)) continue
    if (!childrenOf.has(c.pid)) childrenOf.set(c.pid, [])
    childrenOf.get(c.pid).push(c)
  }
  return { roots, childrenOf }
}

// 片名归一化：用于历史聚合、选路缓存 key
export function normalizeTitle(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\-_:：·・,，.。!！?？()（）[\]【】"“”'’]/g, '')
}

// 片名 + 年份的稳定 key（历史聚合 / 选路缓存）
export function titleKey(name, year) {
  return `${normalizeTitle(name)}|${year || ''}`
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
