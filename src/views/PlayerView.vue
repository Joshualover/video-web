<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ArrowLeft,
  Home,
  ListVideo,
  Play,
  SkipBack,
  SkipForward
} from 'lucide-vue-next'
import PlayerPanel from '../components/PlayerPanel.vue'
import { usePlaylistStore } from '../stores/playlist'
import { useUiStore } from '../stores/ui'

const router = useRouter()
const playlistStore = usePlaylistStore()
const uiStore = useUiStore()

const playerPanelRef = ref(null)

const activeChannel = computed(() => playlistStore.activeChannel)
const channelCount = computed(() => playlistStore.playlist?.channels.length || 0)

// 播放页内频道切换遍历整个列表（跳过无效频道）
const playableChannels = computed(() =>
  (playlistStore.playlist?.channels || []).filter((c) => c.valid)
)

function currentIndex() {
  return playableChannels.value.findIndex(
    (channel) => channel.id === playlistStore.activeChannelId
  )
}

function goNext() {
  const list = playableChannels.value
  const index = currentIndex()
  if (index < 0 || index >= list.length - 1) {
    uiStore.toast('已经是最后一个频道')
    return
  }
  playlistStore.setActiveChannel(list[index + 1].id)
}

function goPrev() {
  const list = playableChannels.value
  const index = currentIndex()
  if (index <= 0) {
    uiStore.toast('已经是第一个频道')
    return
  }
  playlistStore.setActiveChannel(list[index - 1].id)
}

function backToList() {
  router.push('/channels')
}

function goHome() {
  router.push('/')
}

function isEditableTarget(target) {
  return (
    target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable)
  )
}

// video.js 在播放器内部有自己的键位处理且控制条按钮会 stopPropagation，
// 播放器内部的按键完全交给 video.js，避免双重触发。
function isPlayerInternal(target) {
  return Boolean(target?.closest?.('.video-js'))
}

function onKeydown(event) {
  if (isEditableTarget(event.target)) return
  if (isPlayerInternal(event.target)) return
  const api = playerPanelRef.value
  if (!api) return
  switch (event.key) {
    case ' ':
      event.preventDefault()
      api.togglePlay()
      break
    case 'ArrowLeft':
      event.preventDefault()
      api.seek(-10)
      break
    case 'ArrowRight':
      event.preventDefault()
      api.seek(10)
      break
    case 'ArrowUp':
      event.preventDefault()
      api.changeVolume(0.1)
      break
    case 'ArrowDown':
      event.preventDefault()
      api.changeVolume(-0.1)
      break
    case 'f':
    case 'F':
      api.toggleFullscreen()
      break
    case 'm':
    case 'M':
      api.toggleMute()
      break
    case 'n':
    case 'N':
      goNext()
      break
    case 'p':
    case 'P':
      goPrev()
      break
    default:
      break
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="watch-page">
    <div
      v-if="!playlistStore.playlist || !activeChannel"
      class="page-state"
    >
      <Play :size="38" />
      <h1>还没有选择频道</h1>
      <p>先去频道列表选择一个频道开始播放。</p>
      <button class="btn btn-primary" type="button" @click="backToList">
        <ListVideo :size="16" /> 去频道列表
      </button>
    </div>

    <div v-else class="watch-wrap">
      <header class="watch-header">
        <button class="icon-btn" type="button" title="返回频道列表" @click="backToList">
          <ArrowLeft :size="18" />
        </button>
        <button class="icon-btn" type="button" title="返回首页" @click="goHome">
          <Home :size="16" />
        </button>
        <div class="watch-info">
          <h1>{{ activeChannel.name }}</h1>
          <span class="watch-badges">
            <span>{{ activeChannel.group }}</span>
            <span v-if="playlistStore.playlist">{{ playlistStore.playlist.name }}</span>
          </span>
        </div>
        <div class="watch-actions">
          <button class="btn btn-secondary btn-small" type="button" @click="goPrev">
            <SkipBack :size="15" /> 上一个
          </button>
          <button class="btn btn-secondary btn-small" type="button" @click="goNext">
            <SkipForward :size="15" /> 下一个
          </button>
        </div>
      </header>

      <div class="watch-stage">
        <PlayerPanel
          ref="playerPanelRef"
          :channel="activeChannel"
          :playlist="playlistStore.playlist"
          @prev="goPrev"
          @next="goNext"
        />
        <p class="watch-hint">
          <Play :size="13" :fill="'currentColor'" />
          点击播放按钮开始 · 快捷键：空格 播放/暂停 · ←→ 快进退 10s · ↑↓ 音量 · N/P 上下个频道
          <span class="watch-count">第 {{ currentIndex() + 1 }} / {{ channelCount }} 个</span>
        </p>
      </div>
    </div>
  </div>
</template>
