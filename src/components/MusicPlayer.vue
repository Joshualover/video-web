<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Heart,
  ListMusic,
  Loader2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Trash2,
  Volume2,
  VolumeX,
  X
} from 'lucide-vue-next'
import { artistText, formatMusicDuration, musicImage } from '../lib/music'
import { useMusicStore } from '../stores/music'
import { useUiStore } from '../stores/ui'

const musicStore = useMusicStore()
const uiStore = useUiStore()

const audio = ref(null)
const queueOpen = ref(false)
const seeking = ref(false)
const seekValue = ref(0)
// 卸载时 audio 元素会被销毁，标记一下，避免它触发的 pause 事件把播放状态改掉
let detaching = false

const current = computed(() => musicStore.currentTrack)
const cover = computed(() => (current.value?.pic ? musicImage(current.value.pic) : ''))
const subtitle = computed(() => {
  const track = current.value
  if (!track) return ''
  const artists = artistText(track.artists) || '未知艺术家'
  return track.matchedFrom ? `${artists} · 匹配自 ${track.matchedFrom}` : artists
})
const progressMax = computed(() => musicStore.duration || Number(current.value?.duration) || 0)
const progressValue = computed(() => (seeking.value ? seekValue.value : musicStore.currentTime))
const volumeIcon = computed(() => (musicStore.volume === 0 ? VolumeX : Volume2))

function applyVolume() {
  if (audio.value) audio.value.volume = musicStore.volume
}

function syncSrc(url, resumeAt = 0, autoplay = true) {
  const el = audio.value
  if (!el) return
  const next = url || ''
  if (!next) {
    el.pause()
    el.removeAttribute('src')
    el.load()
    return
  }
  if (el.getAttribute('src') !== next) {
    el.src = next
    el.load()
  }
  if (resumeAt > 0.5) el.currentTime = resumeAt
  if (autoplay) el.play().catch(() => {})
}

async function ensureLoaded(force = false) {
  try {
    await musicStore.loadCurrent(force)
  } catch (err) {
    const name = musicStore.currentTrack?.name || '当前曲目'
    uiStore.toast(`「${name}」播放失败：${err.message}；换个音源或检查出网代理`, 'warning')
  }
}

function restart() {
  const el = audio.value
  if (!el) return
  if (!musicStore.currentPlayUrl) {
    ensureLoaded(true)
    return
  }
  el.currentTime = 0
  musicStore.currentTime = 0
  el.play().catch(() => {})
}

function seekTo(seconds) {
  const el = audio.value
  const value = Math.max(0, Number(seconds) || 0)
  if (el) el.currentTime = value
  musicStore.currentTime = value
}

// 同一首再点一次时队列 key 不变、watch 不触发，只能由外部调用 restart 重新开始
defineExpose({ restart, seekTo })

function onTimeUpdate() {
  const el = audio.value
  if (!el || seeking.value) return
  musicStore.currentTime = el.currentTime || 0
}

function onDurationChange() {
  const el = audio.value
  const value = Number(el?.duration)
  musicStore.duration = Number.isFinite(value) && value > 0 ? value : Number(current.value?.duration) || 0
}

function onPlay() {
  musicStore.playing = true
}

function onPause() {
  if (detaching) return
  musicStore.playing = false
}

function onEnded() {
  if (musicStore.queue.length > 1) {
    musicStore.next()
    return
  }
  const el = audio.value
  if (!el) return
  el.currentTime = 0
  el.play().catch(() => {})
}

function onAudioError() {
  const el = audio.value
  if (!el?.getAttribute('src')) return
  if (el.error?.code === 1) return
  musicStore.playing = false
  const name = musicStore.currentTrack?.name || '当前曲目'
  uiStore.toast(`「${name}」播放失败：音源可能不可用，换个音源或检查出网代理`, 'warning')
}

function onSeekInput(event) {
  seeking.value = true
  seekValue.value = Number(event.target.value) || 0
}

function onSeekCommit(event) {
  const value = Number(event.target.value) || 0
  const el = audio.value
  if (el) el.currentTime = value
  musicStore.currentTime = value
  seeking.value = false
}

function onVolumeInput(event) {
  musicStore.setVolume(Number(event.target.value) / 100)
}

function toggleFavorite() {
  const added = musicStore.toggleFavorite(current.value)
  uiStore.toast(added ? '已收藏' : '已取消收藏', 'success')
}

function playQueueItem(index) {
  if (index === musicStore.currentIndex) {
    restart()
    return
  }
  musicStore.playAt(index)
}

function clearQueue() {
  musicStore.clearQueue()
  queueOpen.value = false
}

function closePlayer() {
  clearQueue()
}

watch(
  () => musicStore.currentTrack?.key || '',
  (key, oldKey) => {
    if (!key || key === oldKey) return
    if (musicStore.currentTrack?.playUrl) return
    ensureLoaded()
  }
)

watch(
  () => musicStore.currentPlayUrl,
  (url) => {
    if (!url) {
      syncSrc('')
      return
    }
    syncSrc(url)
    musicStore.addHistory(musicStore.currentTrack)
  },
  // DOM 更新后再取 audio 元素，避免首曲时 ref 还是 null
  { flush: 'post' }
)

watch(() => musicStore.volume, applyVolume)

onMounted(() => {
  musicStore.attachAudio(audio.value)
  applyVolume()
  if (musicStore.currentPlayUrl) syncSrc(musicStore.currentPlayUrl, musicStore.currentTime, musicStore.playing)
  else if (musicStore.currentTrack) ensureLoaded()
})

onBeforeUnmount(() => {
  detaching = true
  const el = audio.value
  if (el) {
    musicStore.currentTime = el.currentTime || musicStore.currentTime
    musicStore.playing = !el.paused && !el.ended
    el.pause()
    el.removeAttribute('src')
    el.load()
  }
  musicStore.attachAudio(null)
})
</script>

<template>
  <!-- audio 元素常驻（用 v-show 而不是 v-if），否则首曲播放时 ref 还没挂上 -->
  <div v-show="current" class="music-player">
    <audio
      ref="audio"
      preload="metadata"
      @timeupdate="onTimeUpdate"
      @durationchange="onDurationChange"
      @loadedmetadata="onDurationChange"
      @play="onPlay"
      @pause="onPause"
      @ended="onEnded"
      @error="onAudioError"
    ></audio>

    <template v-if="current">
    <div class="music-player-inner">
      <div class="music-player-now">
        <img v-if="cover" class="music-player-cover" :src="cover" alt="" />
        <span v-else class="music-player-cover music-player-cover-fallback">
          {{ (current.name || '?').slice(0, 1) }}
        </span>
        <div class="music-player-text">
          <strong :title="current.name">
            {{ current.name }}
            <span v-if="current.preview" class="music-badge preview">试听</span>
          </strong>
          <span :title="subtitle">{{ subtitle }}</span>
        </div>
      </div>

      <div class="music-player-controls">
        <button class="icon-btn" type="button" title="上一首" @click="musicStore.prev()">
          <SkipBack :size="17" />
        </button>
        <button
          class="icon-btn music-play-btn"
          type="button"
          :title="musicStore.playing ? '暂停' : '播放'"
          @click="musicStore.togglePlay()"
        >
          <Loader2 v-if="musicStore.streamLoading" class="spin" :size="18" />
          <Pause v-else-if="musicStore.playing" :size="18" />
          <Play v-else :size="18" />
        </button>
        <button class="icon-btn" type="button" title="下一首" @click="musicStore.next()">
          <SkipForward :size="17" />
        </button>
      </div>

      <div class="music-player-progress">
        <span>{{ formatMusicDuration(progressValue) }}</span>
        <input
          class="music-seek"
          type="range"
          min="0"
          :max="Math.max(progressMax, 1)"
          step="1"
          :value="progressValue"
          aria-label="播放进度"
          @input="onSeekInput"
          @change="onSeekCommit"
        />
        <span>{{ formatMusicDuration(progressMax) }}</span>
      </div>

      <div class="music-player-tools">
        <div class="music-volume">
          <button
            class="icon-btn"
            type="button"
            :title="musicStore.volume === 0 ? '取消静音' : '静音'"
            @click="musicStore.setVolume(musicStore.volume === 0 ? 0.8 : 0)"
          >
            <component :is="volumeIcon" :size="17" />
          </button>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            :value="Math.round(musicStore.volume * 100)"
            aria-label="音量"
            @input="onVolumeInput"
          />
        </div>
        <button
          class="icon-btn"
          :class="{ active: musicStore.isFavorite(current) }"
          type="button"
          title="收藏"
          @click="toggleFavorite"
        >
          <Heart :size="17" />
        </button>
        <button
          class="icon-btn"
          :class="{ active: queueOpen }"
          type="button"
          title="播放队列"
          @click="queueOpen = !queueOpen"
        >
          <ListMusic :size="17" />
          <span v-if="musicStore.queue.length" class="music-queue-count">{{ musicStore.queue.length }}</span>
        </button>
        <button class="icon-btn" type="button" title="关闭播放器" @click="closePlayer">
          <X :size="17" />
        </button>
      </div>
    </div>

    <div v-if="queueOpen" class="music-queue-panel">
      <div class="music-queue-head">
        <span class="music-queue-title">
          <ListMusic :size="15" /> 播放队列（{{ musicStore.queue.length }}）
        </span>
        <button v-if="musicStore.queue.length" class="text-link" type="button" @click="clearQueue">
          清空
        </button>
        <button class="icon-btn" type="button" title="收起" @click="queueOpen = false">
          <X :size="15" />
        </button>
      </div>

      <div v-if="!musicStore.queue.length" class="music-queue-empty">队列是空的</div>
      <ul v-else class="music-queue-list">
        <li
          v-for="(item, index) in musicStore.queue"
          :key="`${item.key}-${index}`"
          class="music-queue-item"
          :class="{ active: index === musicStore.currentIndex }"
          @click="playQueueItem(index)"
        >
          <img v-if="item.pic" class="music-queue-thumb" :src="musicImage(item.pic)" alt="" />
          <span v-else class="music-queue-thumb music-queue-thumb-fallback">
            {{ (item.name || '?').slice(0, 1) }}
          </span>
          <span class="music-queue-text">
            <strong>{{ item.name }}</strong>
            <span>{{ artistText(item.artists) || '未知艺术家' }}</span>
          </span>
          <span class="music-duration">{{ formatMusicDuration(item.duration) }}</span>
          <button
            class="icon-btn danger"
            type="button"
            title="移出队列"
            @click.stop="musicStore.removeFromQueue(index)"
          >
            <Trash2 :size="14" />
          </button>
        </li>
      </ul>
    </div>
    </template>
  </div>
</template>
