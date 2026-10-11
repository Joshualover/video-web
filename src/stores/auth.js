import { defineStore } from 'pinia'
import { loadJson, saveJson, removeKey } from '../lib/storage'
import { apiAuthHeaders } from '../lib/fetch'

const AUTH_KEY = 'auth'
const SESSION_KEY = 'auth-session'
export { AUTH_KEY, SESSION_KEY }
const DEFAULT_USER = 'admin'
const DEFAULT_PASS = 'admin123'

// 简单的可逆混淆（本地前端鉴权，防君子不防小人）
function encodePass(pass) {
  try {
    return btoa(unescape(encodeURIComponent(pass)))
  } catch {
    return pass
  }
}

function decodePass(encoded) {
  try {
    return decodeURIComponent(escape(atob(encoded)))
  } catch {
    return encoded
  }
}

export const useAuthStore = defineStore('auth', {
  state: () => {
    const auth = loadJson(AUTH_KEY, null)
    const session = loadJson(SESSION_KEY, false)
    return {
      username: auth?.username || DEFAULT_USER,
      password: auth?.password || encodePass(DEFAULT_PASS),
      authenticated: session === true,
      // 服务端会话是否启用（部署时设了 WEB_LOGIN）；启用后以服务端为准
      serverAuth: false
    }
  },

  actions: {
    // 服务端会话探测：启用 WEB_LOGIN 时以服务端结果覆盖本地判断，未启用则保持原样
    async refreshSession() {
      try {
        const resp = await fetch('/api/session', { headers: apiAuthHeaders() })
        if (!resp.ok) return
        const data = await resp.json().catch(() => null)
        if (!data) return
        this.serverAuth = Boolean(data.enabled)
        if (data.enabled) this.authenticated = Boolean(data.authenticated)
      } catch {
        // 服务端不可用：保持现有（本地）判断
      }
    },
    // 服务端登录：返回 { ok } / { ok:false, fallback:true }（服务端没开会话登录时走本地校验）
    async loginViaServer(username, password) {
      try {
        const resp = await fetch('/api/login', {
          method: 'POST',
          headers: apiAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ username, password })
        })
        const data = await resp.json().catch(() => ({}))
        if (!resp.ok) return { ok: false, error: data?.error || '账号或密码错误' }
        if (!data?.enabled) return { ok: false, fallback: true }
        this.serverAuth = true
        this.authenticated = true
        return { ok: true }
      } catch {
        return { ok: false, error: '网络异常，请稍后重试' }
      }
    },
    login(username, password) {
      const ok =
        username === this.username && encodePass(password) === this.password
      if (ok) {
        this.authenticated = true
        saveJson(SESSION_KEY, true)
      }
      return ok
    },
    async logout() {
      this.authenticated = false
      removeKey(SESSION_KEY)
      if (this.serverAuth) {
        try {
          await fetch('/api/logout', { method: 'POST', headers: apiAuthHeaders() })
        } catch {
          // 服务端不可用时本地登出即可
        }
      }
    },
    changePassword(oldPass, newPass) {
      if (encodePass(oldPass) !== this.password) return false
      if (typeof newPass !== 'string' || newPass.length < 4) return false
      this.password = encodePass(newPass)
      saveJson(AUTH_KEY, { username: this.username, password: this.password })
      return true
    }
  }
})
