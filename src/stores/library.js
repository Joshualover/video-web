import { defineStore } from 'pinia'
import { loadJson, saveJson, removeKey, clearPrefixedKeys, storageUsage } from '../lib/storage'
import { useUiStore } from './ui'

const KEYS = {
  recents: 'recents',
  favorites: 'favorites',
  saved: 'savedPlaylists'
}

export const useLibraryStore = defineStore('library', {
  state: () => ({
    recents: loadJson(KEYS.recents, []),
    favorites: loadJson(KEYS.favorites, []),
    saved: loadJson(KEYS.saved, [])
  }),

  getters: {
    recentCount: (state) => state.recents.length,
    favoriteCount: (state) => state.favorites.length,
    savedCount: (state) => state.saved.length
  },

  actions: {
    persistAll() {
      const snapshot = {
        recents: [...this.recents],
        favorites: [...this.favorites],
        saved: [...this.saved]
      }
      const trySave = () =>
        saveJson(KEYS.recents, this.recents) &&
        saveJson(KEYS.favorites, this.favorites) &&
        saveJson(KEYS.saved, this.saved)
      if (trySave()) return true

      // 空间不足：跨类别逐条裁剪最旧记录，直到写入成功（最多 200 条）
      let trimmed = 0
      while (!trySave() && trimmed < 200) {
        if (this.recents.length > 1) this.recents.pop()
        else if (this.favorites.length > 1) this.favorites.pop()
        else if (this.saved.length > 1) this.saved.pop()
        else break
        trimmed += 1
      }
      if (trySave()) {
        useUiStore().toast('本地存储空间不足，已自动清理旧记录', 'warning')
        return true
      }

      // 仍然失败：回滚内存，避免与存储不一致
      this.recents = snapshot.recents
      this.favorites = snapshot.favorites
      this.saved = snapshot.saved
      useUiStore().toast('本地存储失败：空间不足，请清理后重试', 'error')
      return false
    },

    addRecent(channel, sourceName, sourceUrl) {
      const entry = {
        id: `${channel.id}-${Date.now()}`,
        name: channel.name,
        logo: channel.logo,
        group: channel.group,
        url: channel.url,
        sourceName,
        sourceUrl,
        playedAt: Date.now()
      }
      this.recents = [
        entry,
        ...this.recents.filter(
          (item) => !(item.url === channel.url && item.sourceUrl === sourceUrl)
        )
      ].slice(0, 20)
      this.persistAll()
    },

    isFavorite(channel, sourceUrl) {
      return this.favorites.some(
        (item) => item.url === channel.url && item.sourceUrl === sourceUrl
      )
    },

    toggleFavorite(channel, sourceName, sourceUrl) {
      const ui = useUiStore()
      const existingIndex = this.favorites.findIndex(
        (item) => item.url === channel.url && item.sourceUrl === sourceUrl
      )
      if (existingIndex >= 0) {
        this.favorites.splice(existingIndex, 1)
        ui.toast('已取消收藏')
      } else {
        if (this.favorites.length >= 100) {
          ui.toast('收藏已满，请清理后再添加', 'warning')
          return
        }
        this.favorites.unshift({
          id: `${channel.id}-${Date.now()}`,
          name: channel.name,
          logo: channel.logo,
          group: channel.group,
          url: channel.url,
          sourceName,
          sourceUrl,
          favoritedAt: Date.now()
        })
        ui.toast('已加入收藏')
      }
      this.persistAll()
    },

    addSaved(name, url, channelCount) {
      const ui = useUiStore()
      if (this.saved.length >= 10) {
        ui.toast('已保存列表已达上限（10 个）', 'warning')
        return false
      }
      const existing = this.saved.find((item) => item.url === url)
      if (existing) {
        existing.name = name
        existing.channelCount = channelCount
        existing.updatedAt = Date.now()
        ui.toast('播放列表信息已更新')
      } else {
        this.saved.unshift({
          id: `saved-${Date.now()}`,
          name,
          url,
          channelCount,
          updatedAt: Date.now()
        })
        ui.toast('播放列表已保存')
      }
      this.persistAll()
      return true
    },

    updateSaved(id, patch) {
      const item = this.saved.find((entry) => entry.id === id)
      if (item) {
        Object.assign(item, patch, { updatedAt: Date.now() })
        this.persistAll()
      }
    },

    removeSaved(id) {
      this.saved = this.saved.filter((item) => item.id !== id)
      this.persistAll()
      useUiStore().toast('已删除保存的播放列表')
    },

    clearRecents() {
      this.recents = []
      saveJson(KEYS.recents, [])
      useUiStore().toast('最近播放已清空')
    },

    clearFavorites() {
      this.favorites = []
      saveJson(KEYS.favorites, [])
      useUiStore().toast('收藏已清空')
    },

    clearSaved() {
      this.saved = []
      saveJson(KEYS.saved, [])
      useUiStore().toast('已保存列表已清空')
    },

    clearAllData() {
      this.recents = []
      this.favorites = []
      this.saved = []
      clearPrefixedKeys()
      useUiStore().toast('本地数据已全部清空')
    },

    // 导出所有本地数据为 JSON 备份（用于跨设备迁移）
    exportBackup() {
      return {
        version: 1,
        exportedAt: Date.now(),
        recents: this.recents,
        favorites: this.favorites,
        saved: this.saved
      }
    },

    // 从 JSON 备份恢复数据（校验并清洗非法条目）
    importBackup(data) {
      const ui = useUiStore()
      if (!data || data.version !== 1) {
        ui.toast('备份文件格式无效', 'error')
        return false
      }
      const clean = (arr) =>
        Array.isArray(arr)
          ? arr.filter((item) => item && typeof item.url === 'string' && item.url)
          : []
      this.recents = clean(data.recents).slice(0, 20)
      this.favorites = clean(data.favorites).slice(0, 100)
      this.saved = clean(data.saved).slice(0, 10)
      if (!this.recents.length && !this.favorites.length && !this.saved.length) {
        ui.toast('备份文件中没有可恢复的数据', 'warning')
        return false
      }
      this.persistAll()
      ui.toast(
        `已恢复：收藏 ${this.favorites.length} · 列表 ${this.saved.length} · 最近 ${this.recents.length}`,
        'success'
      )
      return true
    },

    usageBytes() {
      return storageUsage()
    }
  }
})
