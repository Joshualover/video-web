import { defineStore } from 'pinia'
import { loadJson, saveJson } from '../lib/storage'

const THEME_KEY = 'theme'
const CHANNEL_VIEW_KEY = 'channelView'
const CARD_SIZE_KEY = 'cardSize'
const CHANNEL_SORT_KEY = 'channelSort'
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
    theme: loadJson(THEME_KEY, '') || detectSystemTheme(),
    channelView: loadJson(CHANNEL_VIEW_KEY, 'list') === 'grid' ? 'grid' : 'list',
    channelCardSize: (() => {
      const size = loadJson(CARD_SIZE_KEY, 'md')
      return ['sm', 'md', 'lg'].includes(size) ? size : 'md'
    })(),
    channelSort: (() => {
      const sort = loadJson(CHANNEL_SORT_KEY, 'default')
      return ['default', 'name-asc', 'name-desc'].includes(sort) ? sort : 'default'
    })()
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
    setChannelView(view) {
      this.channelView = view === 'grid' ? 'grid' : 'list'
      saveJson(CHANNEL_VIEW_KEY, this.channelView)
    },
    setChannelCardSize(size) {
      this.channelCardSize = ['sm', 'md', 'lg'].includes(size) ? size : 'md'
      saveJson(CARD_SIZE_KEY, this.channelCardSize)
    },
    setChannelSort(sort) {
      this.channelSort = ['default', 'name-asc', 'name-desc'].includes(sort) ? sort : 'default'
      saveJson(CHANNEL_SORT_KEY, this.channelSort)
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
