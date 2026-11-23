import { markRaw } from 'vue'
import { defineStore } from 'pinia'
import { loadJson, saveJson } from '../lib/storage'
import { artistText, musicApi, pickStream } from '../lib/music'
import { activeLyricIndex, parseLrc } from '../lib/lyric'

const FAVORITES_KEY = 'musicFavorites'
const HISTORY_KEY = 'musicHistory'
const VOLUME_KEY = 'musicVolume'
const SOURCE_KEY = 'musicSource'
const QUALITY_KEY = 'musicQuality'
const PLAY_MODE_KEY = 'musicPlayMode'
const HISTORY_LIMIT = 100

// 播放模式：列表循环 / 单曲循环 / 随机
export const PLAY_MODES = [
  { value: 'order', label: '列表循环', icon: 'repeat' },
  { value: 'single', label: '单曲循环', icon: 'repeat-1' },
  { value: 'shuffle', label: '随机播放', icon: 'shuffle' }
]

const PLAY_MODE_VALUES = PLAY_MODES.map((item) => item.value)

function normalizeMode(value) {
  const raw = String(value || '').trim()
  return PLAY_MODE_VALUES.includes(raw) ? raw : 'order'
}

export function musicKey(track) {
  if (!track) return ''
  return track.key || `${track.source}:${track.id}`
}

// 收藏 / 历史只留恢复播放需要的字段：播放地址是带 token 的临时代理地址，不落盘
function baseRecord(track) {
  return {
    key: musicKey(track),
    id: track.id || '',
    source: track.source || '',
    sourceName: track.sourceName || '',
    kind: track.kind || '',
    // platform 是聚合音源（GD音乐台）的子通路，丢了它就取不到流 / 歌词
    platform: track.platform || '',
    name: track.name || '',
    artists: Array.isArray(track.artists) ? track.artists : [],
    album: track.album || '',
    duration: Number(track.duration) || 0,
    pic: track.pic || '',
    // picId 只用于事后换封面地址，属于轻量元信息，可安全落盘
    picId: track.picId || '',
    externalUri: track.externalUri || '',
    preview: Boolean(track.preview)
  }
}

function trackRecord(track) {
  return { ...baseRecord(track), playUrl: track.playUrl || '' }
}

function clampVolume(value) {
  const v = Number(value)
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8
}

export const useMusicStore = defineStore('music', {
  state: () => ({
    sources: [],
    sourcesMeta: { checkedAt: 0, proxy: { enabled: false, url: '', noProxy: [] } },
    sourcesLoading: false,
    sourcesError: '',

    query: '',
    results: [],
    errors: [],
    searching: false,
    // 慢音源（yt-dlp，一次 5-15 秒）单独一趟在后台跑，回来后并入结果
    searchingSlow: false,
    searchError: '',
    searchSeq: 0,

    queue: [],
    currentIndex: -1,
    playing: false,
    currentTime: 0,
    duration: 0,
    volume: clampVolume(loadJson(VOLUME_KEY, 0.8)),
    // 播放模式与音质：两者都是跨会话记忆的用户偏好
    playMode: normalizeMode(loadJson(PLAY_MODE_KEY, 'order')),
    quality: String(loadJson(QUALITY_KEY, '') || ''),
    qualities: [],
    streamLoading: false,
    streamError: '',

    // 歌词：lrc 原文按 track key 缓存，避免来回切歌重复请求
    lyric: '',
    lyricLines: [],
    lyricLoading: false,
    lyricError: '',
    lyricKey: '',

    // 单曲循环重播同一首时 key 不变、watch 不触发，靠这个计数器让播放器重新走一次绑定
    restartTick: 0,

    favorites: loadJson(FAVORITES_KEY, []),
    history: loadJson(HISTORY_KEY, []),
    previewSourceId: loadJson(SOURCE_KEY, '') || '',
    audioEl: null
  }),

  getters: {
    enabledSources(state) {
      return state.sources.filter((s) => s.enabled !== false)
    },
    disabledSourceCount(state) {
      return state.sources.filter((s) => s.enabled === false).length
    },
    // 服务端告诉前端哪些 kind 属于「慢音源」，这里不写死 yt-dlp
    slowSources(state) {
      const kinds = new Set(state.sourcesMeta?.slowKinds || [])
      if (!kinds.size) return []
      return state.sources.filter((s) => s.enabled !== false && kinds.has(s.kind))
    },
    currentTrack(state) {
      return state.currentIndex >= 0 ? state.queue[state.currentIndex] || null : null
    },
    currentPlayUrl(state) {
      const track = state.queue[state.currentIndex]
      return track?.playUrl || ''
    },
    playModeLabel(state) {
      const hit = PLAY_MODES.find((item) => item.value === state.playMode)
      return hit ? hit.label : '列表循环'
    },
    // 歌词行按当前进度定位；播放器据此高亮与滚动
    activeLyricIndex(state) {
      return activeLyricIndex(state.lyricLines, state.currentTime)
    },
    hasLyric(state) {
      return state.lyricLines.length > 0
    },
    isFavorite(state) {
      return (track) =>
        Boolean(track) &&
        state.favorites.some((f) => f.source === track.source && f.id === track.id)
    },
    inQueue(state) {
      return (track) => state.queue.some((item) => musicKey(item) === musicKey(track))
    }
  },

  actions: {
    // ---- 音源 ----
    async fetchSources() {
      this.sourcesLoading = true
      this.sourcesError = ''
      try {
        const { sources, meta } = await musicApi.sources()
        this.sources = Array.isArray(sources) ? sources : []
        if (meta) this.sourcesMeta = meta
        // 筛选中的源被停用 / 删除后回到「全部」
        const current = this.sources.find((s) => s.id === this.previewSourceId)
        if (this.previewSourceId && (!current || current.enabled === false)) this.setPreviewSource('')
        return this.sources
      } catch (err) {
        this.sourcesError = err.message || '加载音源失败'
        throw err
      } finally {
        this.sourcesLoading = false
      }
    },

    setPreviewSource(id) {
      this.previewSourceId = id || ''
      saveJson(SOURCE_KEY, this.previewSourceId)
    },

    // ---- 播放模式 / 音质 ----
    setPlayMode(mode) {
      this.playMode = normalizeMode(mode)
      saveJson(PLAY_MODE_KEY, this.playMode)
      return this.playMode
    },

    // 在列表循环 → 单曲循环 → 随机之间轮转（界面上点一下换一档）
    cyclePlayMode() {
      const index = PLAY_MODE_VALUES.indexOf(this.playMode)
      const next = PLAY_MODE_VALUES[(index + 1) % PLAY_MODE_VALUES.length]
      return this.setPlayMode(next)
    },

    // 换音质要重新取流：旧地址已经按老码率签好，不能复用
    async setQuality(value) {
      const next = String(value || '').trim()
      if (next === this.quality) return next
      this.quality = next
      saveJson(QUALITY_KEY, this.quality)
      const track = this.currentTrack
      if (track?.playUrl) {
        track.playUrl = ''
        await this.loadCurrent(true).catch(() => {})
      }
      return next
    },

    // ---- 歌词 ----
    async loadLyric(force = false) {
      const track = this.currentTrack
      if (!track) {
        this.lyric = ''
        this.lyricLines = []
        this.lyricKey = ''
        return []
      }
      const key = musicKey(track)
      if (!force && this.lyricKey === key && (this.lyricLines.length || this.lyricError)) {
        return this.lyricLines
      }
      // 没有歌词能力的音源不必请求，直接空着
      const source = this.sources.find((item) => item.id === track.source)
      if (source && source.kind !== 'gdmusic') {
        this.lyric = ''
        this.lyricLines = []
        this.lyricKey = key
        this.lyricError = ''
        return []
      }
      this.lyricLoading = true
      this.lyricError = ''
      this.lyricKey = key
      try {
        const data = await musicApi.lyric(track.source, track.id, {
          platform: track.platform || ''
        })
        // 请求期间又切歌了，丢弃这次结果
        if (this.lyricKey !== key) return this.lyricLines
        this.lyric = String(data?.lyric || '')
        this.lyricLines = parseLrc(this.lyric)
        return this.lyricLines
      } catch (err) {
        if (this.lyricKey !== key) return this.lyricLines
        this.lyric = ''
        this.lyricLines = []
        this.lyricError = err.message || '歌词加载失败'
        return []
      } finally {
        if (this.lyricKey === key) this.lyricLoading = false
      }
    },

    async setSourceEnabled(id, enabled) {
      const data = await musicApi.setSourceEnabled(id, enabled)
      const next = typeof data?.enabled === 'boolean' ? data.enabled : enabled
      const item = this.sources.find((s) => s.id === id)
      if (item) item.enabled = next
      if (!next && this.previewSourceId === id) this.setPreviewSource('')
      return next
    },

    async checkSource(id) {
      const result = await musicApi.checkSource(id)
      const item = this.sources.find((s) => s.id === id)
      if (item) {
        item.status = result.status === 'ok' ? 'ok' : 'fail'
        item.latency = result.status === 'ok' ? Number(result.latency) || 0 : 0
        item.error = result.status === 'ok' ? '' : result.error || '不可用'
      }
      return result
    },

    async addSource(payload) {
      const data = await musicApi.addSource(payload)
      if (data?.source) this.sources.push(data.source)
      else await this.fetchSources()
      return data?.source || null
    },

    async removeSource(id) {
      await musicApi.removeSource(id)
      this.sources = this.sources.filter((s) => s.id !== id)
      if (this.previewSourceId === id) this.setPreviewSource('')
    },

    // ---- 搜索 ----
    // 两趟搜索：慢音源（yt-dlp 一次 5-15 秒）会把聚合搜索拖到十几秒，
    // 所以第一趟只要快源、先把结果铺出来，第二趟单独问慢源、回来了再并入。
    // searchSeq 是请求序号：用户连搜几次时，过期的响应直接丢弃。
    async search(wd) {
      const keyword = String(wd ?? this.query).trim()
      this.query = keyword
      this.searchSeq += 1
      const seq = this.searchSeq
      if (!keyword) {
        this.results = []
        this.errors = []
        this.searchError = ''
        this.searching = false
        this.searchingSlow = false
        return []
      }
      this.searching = true
      this.searchingSlow = false
      this.searchError = ''
      this.errors = []
      let list = []
      try {
        const data = await musicApi.search(keyword, {
          source: this.previewSourceId || undefined,
          limit: 40,
          slow: 'exclude'
        })
        if (seq !== this.searchSeq) return []
        list = Array.isArray(data.results) ? data.results : []
        this.results = list
        this.errors = Array.isArray(data.errors) ? data.errors : []
      } catch (err) {
        if (seq !== this.searchSeq) return []
        this.results = []
        this.errors = []
        this.searchError = err.message || '搜索失败'
        throw err
      } finally {
        if (seq === this.searchSeq) this.searching = false
      }
      if (this.slowSources.length) void this.searchSlow(keyword, seq)
      return list
    },

    async searchSlow(keyword, seq) {
      this.searchingSlow = true
      try {
        const data = await musicApi.search(keyword, {
          source: this.previewSourceId || undefined,
          limit: 40,
          slow: 'only'
        })
        if (seq !== this.searchSeq) return
        const extra = Array.isArray(data.results) ? data.results : []
        const seen = new Set(this.results.map((item) => item.key))
        this.results = [...this.results, ...extra.filter((item) => !seen.has(item.key))]
        // 快源已经报过的错误不重复列
        const known = new Set(this.errors.map((item) => item.source))
        for (const item of data.errors || []) {
          if (!known.has(item.source)) this.errors.push(item)
        }
      } catch (err) {
        if (seq !== this.searchSeq) return
        this.errors.push({
          source: 'slow',
          sourceName: 'YouTube 音源',
          error: err.message || '搜索失败'
        })
      } finally {
        if (seq === this.searchSeq) this.searchingSlow = false
      }
    },

    // ---- 播放队列 ----
    attachAudio(el) {
      this.audioEl = el ? markRaw(el) : null
    },

    setVolume(value) {
      this.volume = clampVolume(value)
      saveJson(VOLUME_KEY, this.volume)
      if (this.audioEl) this.audioEl.volume = this.volume
    },

    togglePlay() {
      const el = this.audioEl
      if (!el) return
      if (el.paused) el.play().catch(() => {})
      else el.pause()
    },

    playTrack(track, list) {
      if (!track) return
      if (this.currentTrack && musicKey(this.currentTrack) === musicKey(track)) return
      const pool = Array.isArray(list) && list.length ? list : this.results
      const index = pool.findIndex((item) => musicKey(item) === musicKey(track))
      if (index >= 0) {
        this.queue = pool.map(trackRecord)
        this.currentIndex = index
      } else {
        this.queue = [trackRecord(track)]
        this.currentIndex = 0
      }
      this.currentTime = 0
      this.duration = Number(track.duration) || 0
      this.streamError = ''
    },

    playAt(index) {
      const i = Number(index)
      if (!Number.isInteger(i) || i < 0 || i >= this.queue.length) return
      if (i === this.currentIndex) return
      this.currentIndex = i
      this.currentTime = 0
      this.duration = Number(this.queue[i]?.duration) || 0
      this.streamError = ''
    },

    // 随机播放的下一个下标：队列只有一首时原地循环，避免死循环
    randomIndex() {
      const total = this.queue.length
      if (total <= 1) return 0
      // 排除当前曲，避免「随机到同一首」看起来像没反应
      let next = Math.floor(Math.random() * (total - 1))
      if (next >= this.currentIndex) next += 1
      return next
    },

    // ended=true 表示由「播完」触发：单曲循环要重播当前曲，而不是切下一首
    next({ ended = false } = {}) {
      if (!this.queue.length) return
      if (ended && this.playMode === 'single') {
        const el = this.audioEl
        if (el) {
          el.currentTime = 0
          el.play().catch(() => {})
        }
        this.currentTime = 0
        // 同一个 key 不触发 watch，靠 restartTick 让播放器重新绑定 src
        this.restartTick += 1
        return
      }
      this.currentIndex =
        this.playMode === 'shuffle'
          ? this.randomIndex()
          : (this.currentIndex + 1) % this.queue.length
      this.currentTime = 0
      this.duration = Number(this.currentTrack?.duration) || 0
      this.streamError = ''
    },

    prev() {
      const el = this.audioEl
      if (el && el.currentTime > 3) {
        el.currentTime = 0
        return
      }
      if (!this.queue.length) return
      this.currentIndex =
        this.playMode === 'shuffle'
          ? this.randomIndex()
          : this.currentIndex <= 0
            ? this.queue.length - 1
            : this.currentIndex - 1
      this.currentTime = 0
      this.duration = Number(this.currentTrack?.duration) || 0
      this.streamError = ''
    },

    addToQueue(track) {
      if (!track || this.inQueue(track)) return false
      this.queue.push(trackRecord(track))
      if (this.currentIndex < 0) this.currentIndex = 0
      return true
    },

    removeFromQueue(index) {
      const i = Number(index)
      if (!Number.isInteger(i) || i < 0 || i >= this.queue.length) return
      this.queue.splice(i, 1)
      if (!this.queue.length) {
        this.currentIndex = -1
        this.currentTime = 0
        this.duration = 0
        this.playing = false
        return
      }
      // 删的是当前曲：索引不变即指向后一首；删的是最后一首则退到新的末位
      if (i < this.currentIndex) this.currentIndex -= 1
      else if (i === this.currentIndex && this.currentIndex >= this.queue.length) {
        this.currentIndex = this.queue.length - 1
      }
    },

    clearQueue() {
      this.queue = []
      this.currentIndex = -1
      this.currentTime = 0
      this.duration = 0
      this.playing = false
      this.streamError = ''
    },

    // ---- 取播放地址（必要时跨音源匹配）----
    async loadCurrent(force = false) {
      const track = this.currentTrack
      if (!track) return null
      if (track.playUrl && !force) return track
      const key = musicKey(track)
      this.streamLoading = true
      this.streamError = ''
      try {
        // 带上 platform（聚合音源要回到同一个平台）与音质；曲目元信息也回传，
        // 否则接口只回 id 会让队列里的曲名/封面被冲成空
        const data = await musicApi.stream(track.source, track.id, {
          platform: track.platform || '',
          quality: this.quality || '',
          name: track.name || '',
          pic: track.pic || '',
          picId: track.picId || '',
          duration: track.duration || 0
        })
        if (musicKey(this.currentTrack) !== key) return null
        const stream = pickStream(data?.streams)
        if (!stream?.playUrl) throw new Error('该音源没有给出可用地址')
        track.playUrl = stream.playUrl
        track.bitrate = Number(stream.bitrate) || 0
        track.quality = stream.quality || ''
        track.lossless = Boolean(stream.lossless)
        // 服务端补齐的元信息只在本地缺失时才覆盖，别把搜索时的信息盖掉
        if (!track.name && data?.track?.name) track.name = data.track.name
        if (!track.pic && data?.track?.pic) track.pic = data.track.pic
        if (!track.duration && data?.track?.duration) {
          track.duration = data.track.duration
          this.fillDuration(track)
        }
        return track
      } catch (err) {
        const fallback = await this.matchTrack(track).catch(() => null)
        if (fallback) return fallback
        this.streamError = err.message || '无法获取播放地址'
        throw err
      } finally {
        this.streamLoading = false
      }
    },

    // 搜索结果里时长是 0（搜索接口不给），播放后把真实时长回填到列表项上，
    // 免得回到列表还看到一排 0:00
    fillDuration(track) {
      const key = musicKey(track)
      const seconds = Number(track?.duration) || 0
      if (!key || seconds <= 0) return
      for (const item of this.results) {
        if (musicKey(item) === key && !item.duration) item.duration = seconds
      }
      for (const item of this.favorites) {
        if (musicKey(item) === key && !item.duration) item.duration = seconds
      }
      for (const item of this.history) {
        if (musicKey(item) === key && !item.duration) item.duration = seconds
      }
    },

    async matchTrack(track) {
      if (!track) return null
      const data = await musicApi.match({
        title: track.name,
        artists: artistText(track.artists),
        duration: track.duration
      })
      if (!data?.matched || !data?.match) return null
      const stream = pickStream(data.streams)
      if (!stream?.playUrl) return null
      const key = musicKey(track)
      if (musicKey(this.currentTrack) !== key) return null
      // 只并入播放地址与匹配来源：队列位置、原曲目 id 保持不变，收藏仍指向原音源
      track.playUrl = stream.playUrl
      track.bitrate = Number(stream.bitrate) || 0
      track.matchedFrom = data.sourceName || data.match.sourceName || ''
      return track
    },

    // ---- 收藏 / 历史 ----
    toggleFavorite(track) {
      if (!track?.source || !track?.id) return false
      const index = this.favorites.findIndex((f) => f.source === track.source && f.id === track.id)
      if (index >= 0) this.favorites.splice(index, 1)
      else this.favorites.unshift({ ...baseRecord(track), at: Date.now() })
      saveJson(FAVORITES_KEY, this.favorites)
      return index < 0
    },

    removeFavorite(track) {
      this.favorites = this.favorites.filter(
        (f) => !(f.source === track?.source && f.id === track?.id)
      )
      saveJson(FAVORITES_KEY, this.favorites)
    },

    clearFavorites() {
      this.favorites = []
      saveJson(FAVORITES_KEY, this.favorites)
    },

    addHistory(track) {
      if (!track?.source || !track?.id) return
      const record = { ...baseRecord(track), at: Date.now() }
      const next = this.history.filter((h) => !(h.source === record.source && h.id === record.id))
      next.unshift(record)
      this.history = next.slice(0, HISTORY_LIMIT)
      saveJson(HISTORY_KEY, this.history)
    },

    removeHistory(track) {
      this.history = this.history.filter(
        (h) => !(h.source === track?.source && h.id === track?.id)
      )
      saveJson(HISTORY_KEY, this.history)
    },

    clearHistory() {
      this.history = []
      saveJson(HISTORY_KEY, this.history)
    }
  }
})
