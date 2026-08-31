import { defineStore } from 'pinia'
import { parseM3u, isValidStreamUrl, urlBasename } from '../lib/m3u'
import { fetchRemoteText } from '../lib/fetch'
import { SAMPLE_PLAYLIST } from '../lib/samples'

function looksLikeHtml(content) {
  const head = String(content || '').trim().slice(0, 500).toLowerCase()
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.includes('<head') ||
    head.includes('<body')
  )
}

export const usePlaylistStore = defineStore('playlist', {
  state: () => ({
    playlist: null,
    activeGroup: '全部',
    search: '',
    activeChannelId: null,
    loading: false,
    loadError: null,
    loadStage: '',
    serverFiles: [],
    serverFilesLoading: false
  }),

  getters: {
    channels: (state) => state.playlist?.channels || [],
    groups: (state) => state.playlist?.groups || [],
    activeChannel(state) {
      return state.playlist?.channels.find((channel) => channel.id === state.activeChannelId) || null
    },
    filteredChannels(state) {
      if (!state.playlist) return []
      const query = state.search.trim().toLowerCase()
      let list = state.playlist.channels
      if (state.activeGroup !== '全部') {
        list = list.filter((channel) => channel.group === state.activeGroup)
      }
      if (query) {
        list = list.filter(
          (channel) =>
            channel.name.toLowerCase().includes(query) ||
            channel.url.toLowerCase().includes(query)
        )
      }
      return list
    },
    activeIndex(state) {
      return state.playlist?.channels.findIndex(
        (channel) => channel.id === state.activeChannelId
      ) ?? -1
    }
  },

  actions: {
    setActiveGroup(group) {
      this.activeGroup = group
    },
    setSearch(query) {
      this.search = query
    },
    setActiveChannel(id) {
      this.activeChannelId = id
      const channel = this.playlist?.channels.find((item) => item.id === id)
      if (channel && channel.status !== 'invalid') channel.status = 'playing'
    },
    markChannelStatus(id, status) {
      const channel = this.playlist?.channels.find((item) => item.id === id)
      if (channel && channel.status !== 'invalid') channel.status = status
    },
    resetChannelStatuses() {
      this.playlist?.channels.forEach((channel) => {
        if (channel.status !== 'invalid') channel.status = 'idle'
      })
    },

    async loadByUrl(name, url, { navigate = null } = {}) {
      if (!isValidStreamUrl(url)) {
        this.loadError = '请输入有效的 http/https 链接'
        return false
      }
      this.loading = true
      this.loadError = null
      this.loadStage = '正在请求播放列表...'
      try {
        const { text, mode } = await fetchRemoteText(url)
        this.loadStage = '正在解析频道列表...'
        const parsed = parseM3u(text)
        if (!parsed.channels.length) {
          this.loadError = looksLikeHtml(text)
            ? '该链接返回的是网页而不是播放列表，请确认填写的是 .m3u / .m3u8 文件地址'
            : '无法识别的播放列表格式'
          return false
        }
        this.applyPlaylist({
          name: name || urlBasename(url),
          sourceUrl: url,
          source: mode === 'proxy' ? '代理加载' : '直连加载',
          channels: parsed.channels,
          groups: parsed.groups,
          rawContent: parsed.rawContent
        })
        if (navigate) navigate()
        return true
      } catch (error) {
        this.loadError = error.message || '加载失败，请稍后重试'
        return false
      } finally {
        this.loading = false
        this.loadStage = ''
      }
    },

    loadByContent(name, content) {
      const parsed = parseM3u(content)
      if (!parsed.channels.length) {
        this.loadError = '无法识别的播放列表格式'
        return false
      }
      this.applyPlaylist({
        name: name || '本地播放列表',
        sourceUrl: '',
        source: '本地文件',
        channels: parsed.channels,
        groups: parsed.groups,
        rawContent: parsed.rawContent
      })
      return true
    },

    async loadServerFile(name) {
      this.loading = true
      this.loadError = null
      this.loadStage = '正在读取服务器列表...'
      try {
        const response = await fetch(`/api/playlists/content?name=${encodeURIComponent(name)}`)
        if (!response.ok) throw new Error('读取服务器文件失败')
        const text = await response.text()
        this.loadStage = '正在解析频道列表...'
        const parsed = parseM3u(text)
        if (!parsed.channels.length) {
          this.loadError = '无法识别的播放列表格式'
          return false
        }
        this.applyPlaylist({
          name: name.replace(/\.(m3u|m3u8|txt)$/i, '') || name,
          sourceUrl: '',
          source: '服务器目录',
          channels: parsed.channels,
          groups: parsed.groups,
          rawContent: parsed.rawContent
        })
        return true
      } catch (error) {
        this.loadError = error.message || '加载失败，请稍后重试'
        return false
      } finally {
        this.loading = false
        this.loadStage = ''
      }
    },

    async fetchServerFiles() {
      this.serverFilesLoading = true
      try {
        const response = await fetch('/api/playlists')
        if (!response.ok) throw new Error('接口不可用')
        const data = await response.json()
        this.serverFiles = Array.isArray(data.files) ? data.files : []
      } catch {
        this.serverFiles = []
      } finally {
        this.serverFilesLoading = false
      }
    },

    async uploadServerFile(file) {
      if (!file) return false
      const name = file.name.replace(/\s+/g, '_')
      try {
        const response = await fetch(`/api/playlists?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: await file.text()
        })
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          throw new Error(data.error || '上传失败')
        }
        await this.fetchServerFiles()
        return true
      } catch (error) {
        this.loadError = error.message || '上传失败'
        return false
      }
    },

    loadSample() {
      const parsed = parseM3u(SAMPLE_PLAYLIST.content)
      this.applyPlaylist({
        name: SAMPLE_PLAYLIST.name,
        sourceUrl: '',
        source: '内置示例',
        channels: parsed.channels,
        groups: parsed.groups,
        rawContent: parsed.rawContent
      })
    },

    playSingle(channel, sourceName, sourceUrl) {
      this.applyPlaylist({
        name: sourceName || '单频道播放',
        sourceUrl: sourceUrl || channel.url,
        source: '单频道',
        channels: [channel],
        groups: [channel.group || '未分类'],
        rawContent: ''
      })
    },

    applyPlaylist({ name, sourceUrl, source, channels, groups, rawContent }) {
      this.playlist = {
        name,
        sourceUrl,
        source,
        channels,
        groups,
        rawContent,
        channelCount: channels.length,
        loadedAt: Date.now()
      }
      this.activeGroup = '全部'
      this.search = ''
      this.activeChannelId = channels[0]?.id || null
      this.loadError = null
    },

    reset() {
      this.playlist = null
      this.activeGroup = '全部'
      this.search = ''
      this.activeChannelId = null
      this.loadError = null
      this.loading = false
      this.loadStage = ''
    }
  }
})
