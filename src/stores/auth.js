import { defineStore } from 'pinia'
import { loadJson, saveJson, removeKey } from '../lib/storage'

const AUTH_KEY = 'auth'
const SESSION_KEY = 'auth-session'
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
      authenticated: session === true
    }
  },

  actions: {
    login(username, password) {
      const ok =
        username === this.username && encodePass(password) === this.password
      if (ok) {
        this.authenticated = true
        saveJson(SESSION_KEY, true)
      }
      return ok
    },
    logout() {
      this.authenticated = false
      removeKey(SESSION_KEY)
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
