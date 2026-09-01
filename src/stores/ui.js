import { defineStore } from 'pinia'
import { loadJson, saveJson } from '../lib/storage'

const THEME_KEY = 'theme'
let toastSeq = 0

function applyTheme(theme) {
  if (typeof document === 'undefined') return
  document.body.classList.toggle('theme-light', theme === 'light')
}

function detectSystemTheme() {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export const useUiStore = defineStore('ui', {
  state: () => ({
    toasts: [],
    theme: loadJson(THEME_KEY, '') || detectSystemTheme()
  }),
  actions: {
    initTheme() {
      applyTheme(this.theme)
    },
    setTheme(theme) {
      this.theme = theme === 'light' ? 'light' : 'dark'
      saveJson(THEME_KEY, this.theme)
      applyTheme(this.theme)
    },
    toggleTheme() {
      this.setTheme(this.theme === 'dark' ? 'light' : 'dark')
    },
    toast(message, type = 'info') {
      toastSeq += 1
      const id = toastSeq
      this.toasts.push({ id, message, type })
      setTimeout(() => this.dismiss(id), 3800)
    },
    dismiss(id) {
      this.toasts = this.toasts.filter((toast) => toast.id !== id)
    }
  }
})
