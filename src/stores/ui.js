import { defineStore } from 'pinia'

let toastSeq = 0

export const useUiStore = defineStore('ui', {
  state: () => ({
    toasts: []
  }),
  actions: {
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
