const DEFAULT_TIMEOUT = 10_000

export async function fetchWithTimeout(url, timeout = DEFAULT_TIMEOUT, headers = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: '*/*', ...headers }
    })
    if (!response.ok) {
      let detail = ''
      try {
        const body = await response.json()
        detail = body?.error || ''
      } catch {
        // 非 JSON 错误体，忽略
      }
      const error = new Error(detail || `请求失败（HTTP ${response.status}）`)
      error.status = response.status
      throw error
    }
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

function proxyHeaders() {
  // 可选：构建时注入 VITE_PROXY_TOKEN 以访问设置了 PROXY_TOKEN 的代理服务
  const token = import.meta.env?.VITE_PROXY_TOKEN
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function fetchRemoteText(url) {
  try {
    const text = await fetchWithTimeout(url, DEFAULT_TIMEOUT)
    return { text, mode: 'direct' }
  } catch (directError) {
    try {
      const text = await fetchWithTimeout(
        `/api/proxy?url=${encodeURIComponent(url)}`,
        12_000,
        proxyHeaders()
      )
      return { text, mode: 'proxy' }
    } catch (proxyError) {
      const error = new Error(friendlyRemoteError(directError, proxyError))
      error.kind = 'remote'
      throw error
    }
  }
}

function friendlyRemoteError(directError, proxyError) {
  if (proxyError?.name === 'AbortError' || directError?.name === 'AbortError') {
    return '加载超时，请检查链接是否可访问'
  }
  if (proxyError?.status === 401) {
    return '代理服务需要访问令牌（VITE_PROXY_TOKEN），请联系管理员配置'
  }
  if (proxyError?.status === 403) {
    return '该源存在跨域限制或已被代理拒绝，建议使用支持 CORS 的源'
  }
  if (proxyError?.message && proxyError.message !== '请求失败（HTTP 502）') {
    return proxyError.message
  }
  if (directError?.status) {
    return `目标站点返回 ${directError.status} 状态，请检查链接是否有效`
  }
  return '无法加载播放列表，链接不可访问或存在跨域限制'
}
