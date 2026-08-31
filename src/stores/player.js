import { defineStore } from 'pinia'
import { loadJson, saveJson } from '../lib/storage'

const PREFS_KEY = 'playerPrefs'

export const usePlayerStore = defineStore('player', {
  state: () => {
    const prefs = loadJson(PREFS_KEY, {})
    return {
      volume: typeof prefs.volume === 'number' ? prefs.volume : 0.8,
      muted: Boolean(prefs.muted),
      playbackRate: typeof prefs.playbackRate === 'number' ? prefs.playbackRate : 1,
      autoplay: prefs.autoplay === true,
      currentChannel: null,
      loading: false,
      buffering: false,
      error: null,
      audioMode: false,
      isLive: false,
      started: false,
      networkOffline: false
    }
  },

  actions: {
    persistPrefs() {
      saveJson(PREFS_KEY, {
        volume: this.volume,
        muted: this.muted,
        playbackRate: this.playbackRate,
        autoplay: this.autoplay
      })
    },
    setPrefs(partial) {
      Object.assign(this, partial)
      this.persistPrefs()
    },
    startChannel(channel) {
      this.currentChannel = channel
      this.error = null
      this.loading = true
      this.buffering = false
      this.audioMode = false
      this.isLive = false
      this.started = false
    },
    waiting() {
      this.buffering = true
    },
    ready() {
      this.loading = false
      this.buffering = false
    },
    playing() {
      this.loading = false
      this.buffering = false
      this.error = null
      this.started = true
    },
    fail(message) {
      this.loading = false
      this.buffering = false
      this.error = message
    },
    setAudioMode(value) {
      this.audioMode = Boolean(value)
    },
    setLive(value) {
      this.isLive = Boolean(value)
    },
    setNetwork(offline) {
      this.networkOffline = Boolean(offline)
    }
  }
})
