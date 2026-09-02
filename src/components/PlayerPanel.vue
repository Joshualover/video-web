<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import videojs from 'video.js'
import {
  AlertTriangle,
  Heart,
  Loader2,
  Maximize,
  Music,
  PictureInPicture2,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward
} from 'lucide-vue-next'
import { usePlaylistStore } from '../stores/playlist'
import { usePlayerStore } from '../stores/player'
import { useLibraryStore } from '../stores/library'
import { useUiStore } from '../stores/ui'

const props = defineProps({
  channel: { type: Object, default: null },
  playlist: { type: Object, default: null }
})

const emit = defineEmits(['prev', 'next'])

const playlistStore = usePlaylistStore()
const playerStore = usePlayerStore()
const libraryStore = useLibraryStore()
const uiStore = useUiStore()

const playerRef = ref(null)
let player = null
let retried = false
let forcePlay = false // 连播切换频道时需要自动播放（autoplay 关闭时也生效）
let loadStartedAt = 0
const longLoading = ref(false)
let longLoadingTimer = null
const pipSupported = computed(
  () => typeof document !== 'undefined' && Boolean(document.pictureInPictureEnabled)
)

const isFavorite = computed(
  () =>
    props.channel &&
    props.playlist &&
    libraryStore.isFavorite(props.channel, props.playlist.sourceUrl)
)

function mediaType(url) {
  const path = String(url || '').split('?')[0].toLowerCase()
  if (path.endsWith('.m3u8')) return 'application/x-mpegURL'
  if (path.endsWith('.mp4')) return 'video/mp4'
  if (path.endsWith('.webm')) return 'video/webm'
  if (path.endsWith('.ogg')) return 'video/ogg'
  if (path.endsWith('.mp3')) return 'audio/mp3'
  if (path.endsWith('.aac')) return 'audio/aac'
  if (path.endsWith('.flac')) return 'audio/flac'
  return 'application/x-mpegURL'
}

function initPlayer() {
  if (player) return
  const element = playerRef.value
  if (!element) return
  player = videojs(element, {
    autoplay: playerStore.autoplay,
    controls: true,
    fluid: true,
    liveui: true,
    playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2],
    html5: {
      vhs: {
        overrideNative: !(videojs.browser && videojs.browser.IS_SAFARI),
        enableLowInitialPlaylist: true
      }
    }
  })
  player.volume(playerStore.muted ? 0 : playerStore.volume)
  player.muted(playerStore.muted)

  player.on('loadedmetadata', handleMetadata)
  player.on('durationchange', updateLive)
  player.on('waiting', handleWaiting)
  player.on('playing', handlePlaying)
  player.on('canplay', handleReady)
  player.on('error', handleError)
  player.on('ended', handleEnded)
}

// 连播：点播播放结束后自动切换列表中的下一个频道
function handleEnded() {
  if (playerStore.isLive || !playerStore.autoNext) return
  if (!props.channel || !props.playlist) return
  const list = (props.playlist.channels || []).filter((channel) => channel.valid)
  const index = list.findIndex((channel) => channel.id === props.channel.id)
  if (index < 0 || index >= list.length - 1) return
  forcePlay = true
  playlistStore.setActiveChannel(list[index + 1].id)
}

function loadChannel(channel, resetRetry = true) {
  if (!player || !channel) return
  // 自动重试（resetRetry=false）时不重置标志，保证只自动重试一次；
  // 手动重试 / 切换频道时才重新允许自动重试。
  if (resetRetry) retried = false
  loadStartedAt = Date.now()
  playerStore.startChannel(channel)
  player.pause()
  player.src({ src: channel.url, type: mediaType(channel.url) })
  if (!playerStore.isLive) {
    player.playbackRate(playerStore.playbackRate)
  }
  // 连播切换（forcePlay）时即使 autoplay 关闭也要自动播放
  const shouldAutoPlay = playerStore.autoplay || forcePlay
  forcePlay = false
  if (shouldAutoPlay) {
    player.play().catch(() => {})
  }
}

function handleMetadata() {
  const videoWidth = player.videoWidth?.() || 0
  const videoHeight = player.videoHeight?.() || 0
  playerStore.setAudioMode(videoWidth === 0 && videoHeight === 0)
  updateLive()
  handleReady()
}

function updateLive() {
  let live = false
  if (player.liveTracker && typeof player.liveTracker.isLive === 'function') {
    try {
      live = player.liveTracker.isLive()
    } catch {
      live = false
    }
  }
  if (!live && player.duration) {
    live = player.duration() === Infinity
  }
  playerStore.setLive(live)
  if (live) {
    player.playbackRate(1)
  }
}

function handleWaiting() {
  playerStore.waiting()
  if (longLoadingTimer) clearTimeout(longLoadingTimer)
  longLoadingTimer = setTimeout(() => {
    longLoading.value = true
  }, 5000)
}

function handleReady() {
  if (longLoadingTimer) clearTimeout(longLoadingTimer)
  longLoading.value = false
  playerStore.ready()
}

function handlePlaying() {
  handleReady()
  const firstPlay = !playerStore.started
  playerStore.playing()
  if (props.channel) {
    playlistStore.markChannelStatus(props.channel.id, 'online')
    if (firstPlay && props.playlist) {
      libraryStore.addRecent(
        props.channel,
        props.playlist.name,
        props.playlist.sourceUrl
      )
    }
  }
}

function friendlyError(error) {
  const code = error?.code
  const message = String(error?.message || '').toLowerCase()
  if (code === 4 || message.includes('404') || message.includes('not found')) {
    return '视频源不存在或已被移除'
  }
  if (code === 2 || message.includes('network')) {
    return '网络连接失败，请检查网络后重试'
  }
  if (code === 5 || message.includes('unsupported')) {
    return '播放格式不支持，请确认源为 HLS 流'
  }
  if (message.includes('manifest') || message.includes('playlist')) {
    return '无法解析 HLS 播放列表，源站可能不可用'
  }
  if (message.includes('cors')) {
    return '该源存在跨域限制，建议使用支持 CORS 的源'
  }
  return '播放失败，源站不可用或存在跨域限制'
}

function handleError() {
  const error = player?.error?.()
  const elapsed = Date.now() - loadStartedAt
  if (!retried && elapsed > 1500) {
    retried = true
    playerStore.waiting()
    setTimeout(() => loadChannel(props.channel, false), 900)
    return
  }
  if (props.channel) playlistStore.markChannelStatus(props.channel.id, 'offline')
  playerStore.fail(friendlyError(error))
}

function togglePlay() {
  if (!player) return
  if (player.paused()) player.play().catch(() => {})
  else player.pause()
}

function seek(seconds) {
  if (!player || playerStore.isLive) return
  const target = (player.currentTime() || 0) + seconds
  player.currentTime(Math.max(0, Math.min(target, player.duration() || target)))
}

function changeVolume(delta) {
  const next = Math.min(1, Math.max(0, playerStore.volume + delta))
  playerStore.setPrefs({ volume: next, muted: next === 0 })
  player.volume(next)
}

function toggleMute() {
  const muted = !playerStore.muted
  playerStore.setPrefs({ muted })
  player.muted(muted)
}

function toggleFullscreen() {
  if (!player) return
  if (!player.isFullscreen()) player.requestFullscreen()
  else player.exitFullscreen()
}

async function togglePip() {
  const videoEl = player?.videoEl?.()
  if (!videoEl || !document.pictureInPictureEnabled) {
    uiStore.toast('当前浏览器不支持画中画', 'warning')
    return
  }
  try {
    if (document.pictureInPictureElement === videoEl) {
      await document.exitPictureInPicture()
    } else {
      await videoEl.requestPictureInPicture()
    }
  } catch {
    uiStore.toast('画中画切换失败', 'warning')
  }
}

function toggleFavorite() {
  if (!props.channel || !props.playlist) return
  libraryStore.toggleFavorite(
    props.channel,
    props.playlist.name,
    props.playlist.sourceUrl
  )
}

function retry() {
  if (!props.channel) return
  loadChannel(props.channel)
}

function goNext() {
  emit('next')
}

function goPrev() {
  emit('prev')
}

watch(
  () => `${props.channel?.id}|${props.channel?.url}`,
  (key) => {
    if (key && key !== '|') loadChannel(props.channel)
  }
)

watch(
  () => playerStore.networkOffline,
  (offline) => {
    if (!offline && playerStore.error && props.channel) {
      setTimeout(retry, 600)
    }
  }
)

watch(
  () => playerStore.volume,
  (volume) => {
    if (player && !playerStore.muted) player.volume(volume)
  }
)

watch(
  () => playerStore.muted,
  (muted) => {
    if (player) player.muted(muted)
  }
)

watch(
  () => playerStore.playbackRate,
  (rate) => {
    if (player && !playerStore.isLive) player.playbackRate(rate)
  }
)

onMounted(() => {
  initPlayer()
  if (props.channel) loadChannel(props.channel)
})

onBeforeUnmount(() => {
  if (longLoadingTimer) clearTimeout(longLoadingTimer)
  if (player) {
    player.dispose()
    player = null
  }
})

defineExpose({
  togglePlay,
  seek,
  changeVolume,
  toggleMute,
  toggleFullscreen
})
</script>

<template>
  <section class="player-panel">
    <div class="video-wrap" @dblclick="toggleFullscreen">
      <video ref="playerRef" class="video-js vjs-big-play-centered"></video>

      <div v-if="playerStore.audioMode && channel" class="audio-stage">
        <div class="audio-art">
          <img v-if="channel.logo" :src="channel.logo" alt="" />
          <Music v-else :size="44" />
          <span class="audio-equalizer" aria-hidden="true">
            <i></i><i></i><i></i><i></i>
          </span>
        </div>
        <div class="audio-title">{{ channel.name }}</div>
      </div>

      <div v-if="playerStore.loading || playerStore.buffering" class="player-overlay">
        <Loader2 class="spin" :size="34" />
        <span>{{ longLoading ? '正在缓冲，请稍候...' : '正在加载播放源...' }}</span>
      </div>

      <div v-if="playerStore.error" class="player-overlay error-overlay">
        <AlertTriangle :size="34" />
        <strong>播放失败</strong>
        <span>{{ playerStore.error }}</span>
        <div class="error-actions">
          <button class="btn btn-secondary" type="button" @click="retry">
            <RotateCcw :size="15" /> 重试
          </button>
          <button class="btn btn-primary" type="button" @click="goNext">
            <SkipForward :size="15" /> 下一个频道
          </button>
        </div>
      </div>

      <div v-if="playerStore.networkOffline" class="network-banner">
        网络已断开，恢复后将自动重试
      </div>

      <div v-if="channel" class="player-tools">
        <span v-if="playerStore.isLive" class="live-badge">LIVE</span>
        <span class="tool-group">
          <button
            class="icon-btn"
            type="button"
            title="上一个频道"
            @click="goPrev"
          >
            <SkipBack :size="17" />
          </button>
          <button class="icon-btn" type="button" title="播放 / 暂停" @click="togglePlay">
            <Play :size="17" />
          </button>
          <button class="icon-btn" type="button" title="下一个频道" @click="goNext">
            <SkipForward :size="17" />
          </button>
          <button
            class="icon-btn"
            :class="{ active: isFavorite }"
            type="button"
            :title="isFavorite ? '取消收藏' : '加入收藏'"
            @click="toggleFavorite"
          >
            <Heart :size="17" :fill="isFavorite ? 'currentColor' : 'none'" />
          </button>
          <button
            v-if="pipSupported"
            class="icon-btn"
            type="button"
            title="画中画"
            @click="togglePip"
          >
            <PictureInPicture2 :size="17" />
          </button>
          <button class="icon-btn" type="button" title="全屏" @click="toggleFullscreen">
            <Maximize :size="17" />
          </button>
        </span>
      </div>

      <div v-if="!channel" class="player-overlay empty-player">
        <Play :size="36" />
        <span>选择左侧频道开始播放</span>
      </div>
    </div>

    <div v-if="channel" class="channel-meta">
      <div class="meta-main">
        <strong>{{ channel.name }}</strong>
        <span class="meta-badge">{{ channel.group }}</span>
        <span class="meta-badge" :class="{ live: playerStore.isLive }">
          {{ playerStore.isLive ? '直播' : channel.duration === -1 ? '直播源' : '点播' }}
        </span>
      </div>
      <div class="meta-url">{{ channel.url }}</div>
      <div class="meta-source">来源：{{ playlist?.name }} · {{ playlist?.source }}</div>
    </div>
  </section>
</template>
