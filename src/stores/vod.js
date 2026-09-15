import { defineStore } from 'pinia'
import { loadJson, saveJson } from '../lib/storage'
import { vodApi, titleKey } from '../lib/vod'

const SITE_KEY = 'vodActiveSite'
const RECENTS_KEY = 'vodRecents'
const FAVORITES_KEY = 'vodFavorites'
const BEST_KEY = 'vodBestCache'

const DEFAULT_GROUP = '默认分组'
const BEST_TTL = 6 * 60 * 60 * 1000

export const useVodStore = defineStore('vod', {
  state: () => ({
    sources: [],
    sourcesLoading: false,
    sourcesError: '',
    sourcesMeta: { autoRefreshHours: 0, lastRefreshAt: 0, refreshing: false, lastError: '' },
    healthChecked: false,
    activeSiteId: loadJson(SITE_KEY, '') || '',
    recents: loadJson(RECENTS_KEY, []),
    favorites: loadJson(FAVORITES_KEY, []),
    bestCache: loadJson(BEST_KEY, {}),
    configs: [],
    configsLoading: false,
    configsError: ''
  }),

  getters: {
    activeSource(state) {
      return state.sources.find((s) => s.id === state.activeSiteId) || null
    },
    healthySources(state) {
      return state.sources.filter((s) => s.status === 'ok')
    },
    enabledSources(state) {
      return state.sources.filter((s) => s.enabled !== false)
    },
    disabledSourceCount(state) {
      return state.sources.filter((s) => s.enabled === false).length
    },
    sourceGroups(state) {
      const map = new Map()
      for (const s of state.sources) {
        const key = s.group || '默认配置'
        if (!map.has(key)) map.set(key, [])
        map.get(key).push(s)
      }
      return [...map.entries()].map(([group, sources]) => ({ group, sources }))
    },
    isFavorite(state) {
      return (site, id) => state.favorites.some((f) => f.site === site && f.id === id)
    },
    favoriteGroups(state) {
      const map = new Map()
      for (const f of state.favorites) {
        const group = f.group || DEFAULT_GROUP
        map.set(group, (map.get(group) || 0) + 1)
      }
      return [...map.entries()].map(([name, count]) => ({ name, count }))
    },
    // 历史按片名+年份聚合，保留最近观看的一条作为续播入口
    historyAggregated(state) {
      const map = new Map()
      for (const record of state.recents) {
        const key = titleKey(record.name, record.year)
        const current = map.get(key)
        if (!current) {
          map.set(key, {
            ...record,
            groupKey: key,
            variants: 1,
            variantKeys: [{ site: record.site, id: record.id }]
          })
        } else {
          current.variants += 1
          current.variantKeys.push({ site: record.site, id: record.id })
          if ((record.at || 0) > (current.at || 0)) {
            const variants = current.variants
            const variantKeys = current.variantKeys
            const groupKey = current.groupKey
            Object.assign(current, record)
            current.variants = variants
            current.variantKeys = variantKeys
            current.groupKey = groupKey
          }
        }
      }
      return [...map.values()].sort((a, b) => (b.at || 0) - (a.at || 0))
    }
  },

  actions: {
    async fetchSources({ check = false } = {}) {
      this.sourcesLoading = true
      this.sourcesError = ''
      try {
        const { sources, meta } = await vodApi.sources({ check })
        this.sources = Array.isArray(sources) ? sources : []
        if (meta) this.sourcesMeta = meta
        if (check) this.healthChecked = true
        if (!this.activeSiteId || !this.sources.some((s) => s.id === this.activeSiteId && s.enabled !== false)) {
          const usable = this.sources.filter((s) => s.enabled !== false)
          const preferred =
            usable.find((s) => s.status === 'ok') ||
            usable.find((s) => s.status !== 'fail') ||
            usable[0] ||
            this.sources[0]
          this.setActiveSite(preferred?.id || '')
        }
        return this.sources
      } catch (err) {
        this.sourcesError = err.message || '加载影视源失败'
        throw err
      } finally {
        this.sourcesLoading = false
      }
    },

    setActiveSite(id) {
      this.activeSiteId = id || ''
      saveJson(SITE_KEY, this.activeSiteId)
    },

    // ---- 播放历史 ----
    addRecent(entry) {
      if (!entry?.site || !entry?.id) return
      const existing = this.recents.find((r) => r.site === entry.site && r.id === entry.id)
      const record = {
        position: 0,
        duration: 0,
        ...existing,
        ...entry,
        at: Date.now()
      }
      const next = this.recents.filter((r) => !(r.site === record.site && r.id === record.id))
      next.unshift(record)
      this.recents = next.slice(0, 100)
      saveJson(RECENTS_KEY, this.recents)
    },

    updateProgress(site, id, position, duration) {
      const item = this.recents.find((r) => r.site === site && r.id === id)
      if (!item) return
      item.position = Math.max(0, Math.floor(position || 0))
      if (duration && Number.isFinite(duration)) item.duration = Math.floor(duration)
      item.at = Date.now()
      saveJson(RECENTS_KEY, this.recents)
    },

    removeRecent(site, id) {
      this.recents = this.recents.filter((r) => !(r.site === site && r.id === id))
      saveJson(RECENTS_KEY, this.recents)
    },

    // 按片删除（聚合视图用）：删掉同片的所有来源记录
    removeRecentByTitle(name, year) {
      const key = titleKey(name, year)
      this.recents = this.recents.filter((r) => titleKey(r.name, r.year) !== key)
      saveJson(RECENTS_KEY, this.recents)
    },

    clearRecents() {
      this.recents = []
      saveJson(RECENTS_KEY, this.recents)
    },

    // ---- 收藏 ----
    toggleFavorite(video) {
      if (!video?.site || !video?.id) return false
      const index = this.favorites.findIndex((f) => f.site === video.site && f.id === video.id)
      if (index >= 0) {
        this.favorites.splice(index, 1)
      } else {
        this.favorites.unshift({
          site: video.site,
          id: video.id,
          name: video.name || '',
          pic: video.pic || '',
          year: video.year || '',
          type: video.type || '',
          remarks: video.remarks || '',
          group: video.group || DEFAULT_GROUP,
          at: Date.now()
        })
      }
      saveJson(FAVORITES_KEY, this.favorites)
      return index < 0
    },

    setFavoriteGroup(site, id, group) {
      const item = this.favorites.find((f) => f.site === site && f.id === id)
      if (!item) return
      item.group = String(group || '').trim() || DEFAULT_GROUP
      saveJson(FAVORITES_KEY, this.favorites)
    },

    removeFavoriteGroup(group) {
      const name = String(group || '').trim()
      for (const item of this.favorites) {
        if ((item.group || DEFAULT_GROUP) === name) item.group = DEFAULT_GROUP
      }
      saveJson(FAVORITES_KEY, this.favorites)
    },

    removeFavorite(site, id) {
      this.favorites = this.favorites.filter((f) => !(f.site === site && f.id === id))
      saveJson(FAVORITES_KEY, this.favorites)
    },

    clearFavorites(group = '') {
      if (group) {
        this.favorites = this.favorites.filter((f) => (f.group || DEFAULT_GROUP) !== group)
      } else {
        this.favorites = []
      }
      saveJson(FAVORITES_KEY, this.favorites)
    },

    // ---- 选路缓存（localStorage） ----
    getBest(name, year, maxAge = BEST_TTL) {
      const item = this.bestCache[titleKey(name, year)]
      if (!item) return null
      if (Date.now() - item.at > maxAge) return null
      return item
    },

    setBest(name, year, data) {
      this.bestCache[titleKey(name, year)] = { at: Date.now(), data }
      const entries = Object.entries(this.bestCache).sort((a, b) => b[1].at - a[1].at)
      if (entries.length > 50) {
        this.bestCache = Object.fromEntries(entries.slice(0, 50))
      }
      saveJson(BEST_KEY, this.bestCache)
    },

    clearBest() {
      this.bestCache = {}
      saveJson(BEST_KEY, {})
    },

    // ---- 配置管理 ----
    async fetchConfigs() {
      this.configsLoading = true
      this.configsError = ''
      try {
        const { configs } = await vodApi.configs()
        this.configs = Array.isArray(configs) ? configs : []
        return this.configs
      } catch (err) {
        this.configsError = err.message || '加载配置失败'
        throw err
      } finally {
        this.configsLoading = false
      }
    },

    async addConfig(payload) {
      await vodApi.addConfig(payload)
      await this.fetchConfigs()
    },

    async updateConfig(id, patch) {
      await vodApi.updateConfig(id, patch)
      await this.fetchConfigs()
    },

    async removeConfig(id) {
      await vodApi.removeConfig(id)
      await this.fetchConfigs()
    },

    async refreshConfigs(id) {
      this.configsLoading = true
      this.configsError = ''
      try {
        const { configs } = await vodApi.refreshConfigs(id)
        this.configs = Array.isArray(configs) ? configs : []
        await this.fetchSources()
        return this.configs
      } catch (err) {
        this.configsError = err.message || '刷新配置失败'
        throw err
      } finally {
        this.configsLoading = false
      }
    },

    // ---- 源级启停 / 单源检测 ----
    async setSourceEnabled(id, enabled) {
      await vodApi.setSourceEnabled(id, enabled)
      const item = this.sources.find((s) => s.id === id)
      if (item) item.enabled = enabled
      // 当前正在用的源被停用时，切到一个可用的源，避免继续用它浏览
      if (!enabled && this.activeSiteId === id) {
        const next =
          this.sources.find((s) => s.enabled !== false && s.status === 'ok') ||
          this.sources.find((s) => s.enabled !== false)
        if (next) this.setActiveSite(next.id)
      }
      return enabled
    },

    async checkSource(id) {
      const result = await vodApi.checkSource(id)
      const item = this.sources.find((s) => s.id === id)
      if (item) {
        item.status = result.status === 'ok' ? 'ok' : 'fail'
        if (result.status === 'ok') {
          item.latency = result.latency
          item.classes = result.classes
          item.error = ''
        } else {
          item.error = result.error || '不可用'
        }
      }
      return result
    }
  }
})
