<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Heart,
  ListMusic,
  Loader2,
  Mic2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Trash2,
  Volume2,
  VolumeX,
  X
} from 'lucide-vue-next'
import { artistText, formatMusicDuration, musicImage } from '../lib/music'
import { NO_LYRIC_TEXT } from '../lib/lyric'
import { useMusicStore } from '../stores/music'
import { useUiStore } from '../stores/ui'

const musicStore = useMusicStore()
const uiStore = useUiStore()

const audio = ref(null)
const queueOpen = ref(false)
const seeking = ref(false)
const seekValue = ref(0)
// 封面 / 歌词 两种视图，对齐 AlgerMusicPlayer 的大屏播放页
const viewMode = ref('cover')
const lyricEl = ref(null)
const lyricWrap = ref(null)
const qualityOpen = ref(false)
// 卸载时 audio 元素会被销毁，标记一下，避免它触发的 pause 事件把播放状态改掉
let detaching = false

const current = computed(() => musicStore.currentTrack)
const cover = computed(() => (current.value?.pic ? musicImage(current.value.pic) : ''))
const subtitle = computed(() => {
  const track = current.value
  if (!track) return ''
  const artists = artistText(track.artists) || '未知艺术家'
  const album = track.album ? ` · ${track.album}` : ''
  const matched = track.matchedFrom ? ` · 匹配自 ${track.matchedFrom}` : ''
  return `${artists}${album}${matched}`
})
const progressMax = computed(() => musicStore.duration || Number(current.value?.duration) || 0)
const progressValue = computed(() => (seeking.value ? seekValue.value : musicStore.currentTime))
const volumeIcon = computed(() => (musicStore.volume === 0 ? VolumeX : Volume2))

// 播放模式按钮：图标随模式切换
const modeIcon = computed(() => {
  if (musicStore.playMode === 'single') return Repeat1
  if (musicStore.playMode === 'shuffle') return Shuffle
  return Repeat
})

const qualityLabel = computed(() => {
  const value = musicStore.quality
  if (!value) return '音质'
  const hit = (musicStore.qualities || []).find((item) => item.value === value)
  return hit ? hit.label.replace(/\s*\d+\s*kbps/i, '').trim() : value
})

const activeIndex = computed(() => musicStore.activeLyricIndex)
const lyricLines = computed(() => musicStore.lyricLines)

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
    void musicStore.loadLyric()
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
  if (musicStore.queue.length > 1 || musicStore.playMode === 'single') {
    musicStore.next({ ended: true })
    return
  }
  const el = audio.value
  if (el) el.currentTime = 0
  const track = musicStore.currentTrack
  if (track?.name) uiStore.toast(`「${track.name}」比完了，正在单曲重播`, 'info')
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

function cycleMode() {
  const next = musicStore.cyclePlayMode()
  const label = { order: '列表循环', single: '单曲循环', shuffle: '随机播放' }[next] || next
  uiStore.toast(label, 'info')
}

async function pickQuality(value) {
  qualityOpen.value = false
  if (value === musicStore.quality) return
  uiStore.toast(`切换到 ${(musicStore.qualities || []).find((q) => q.value === value)?.label || value}`, 'info')
  await musicStore.setQuality(value)
}

// 歌词滚动：当前行保持在可视区中间
async function scrollLyricTo(index) {
  if (index < 0 || viewMode.value !== 'lyric') return
  await nextTick()
  const wrap = lyricWrap.value
  const line = lyricEl.value?.querySelector(`[data-line="${index}"]`)
  if (!wrap || !line) return
  const top = line.offsetTop - wrap.clientHeight / 2 + line.clientHeight / 2
  wrap.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}

watch(
  () => musicStore.currentTrack?.key || '',
  (key, oldKey) => {
    if (!key || key === oldKey) return
    musicStore.currentTime = 0
    if (musicStore.currentTrack?.playUrl) {
      void musicStore.loadLyric()
      return
    }
    ensureLoaded()
  }
)

// 单曲循环：key 不变但要重新绑定 src
watch(
  () => musicStore.restartTick,
  () => {
    const el = audio.value
    if (!el || !musicStore.currentPlayUrl) return
    el.currentTime = 0
    el.play().catch(() => {})
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
watch(activeIndex, (index) => void scrollLyricTo(index))
watch(viewMode, (mode) => {
  if (mode === 'lyric') void scrollLyricTo(musicStore.activeLyricIndex)
})

onMounted(async () => {
  musicStore.attachAudio(audio.value)
  applyVolume()
  // 音质档位由服务端下发，前端不写死
  if (!musicStore.qualities.length) {
    await musicStore.fetchSources().catch(() => {})
    musicStore.qualities = musicStore.sourcesMeta?.qualities || []
    if (!musicStore.quality) {
      musicStore.quality = musicStore.sourcesMeta?.defaultQuality || '320'
    }
  }
  if (musicStore.currentPlayUrl) syncSrc(musicStore.currentPlayUrl, musicStore.currentTime, musicStore.playing)
  else if (musicStore.currentTrack) ensureLoaded()
  if (musicStore.currentTrack) void musicStore.loadLyric()
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
        <!-- 封面 / 歌词 切换：点封面进歌词，点歌词回封面 -->
        <div class="music-player-stage" :class="`is-${viewMode}`">
          <button
            v-if="viewMode === 'cover'"
            class="music-stage-art"
            type="button"
            title="查看歌词"
            @click="viewMode = 'lyric'"
          >
            <img v-if="cover" class="music-cover-img" :src="cover" alt="" />
            <span v-else class="music-cover-img music-cover-fallback">
              {{ (current.name || '?').slice(0, 1) }}
            </span>
          </button>

          <div v-else class="music-lyric-panel" @click="viewMode = 'cover'">
            <div v-if="musicStore.lyricLoading" class="music-lyric-hint">
              <Loader2 class="spin" :size="16" /> 歌词加载中…
            </div>
            <div v-else-if="!lyricLines.length" class="music-lyric-hint">
              {{ musicStore.lyricError || NO_LYRIC_TEXT }}
            </div>
            <div v-else ref="lyricWrap" class="music-lyric-scroll">
              <div ref="lyricEl" class="music-lyric-lines">
                <p
                  v-for="(line, index) in lyricLines"
                  :key="`${line.time}-${index}`"
                  :data-line="index"
                  class="music-lyric-line"
                  :class="{ active: index === activeIndex, passed: index < activeIndex }"
                  @click.stop="seekTo(line.time)"
                >
                  {{ line.text }}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div class="music-player-meta">
          <strong class="music-player-title" :title="current.name">
            {{ current.name }}
            <span v-if="current.preview" class="music-badge preview">试听</span>
            <span v-if="current.lossless" class="music-badge lossless">无损</span>
          </strong>
          <span class="music-player-artist" :title="subtitle">{{ subtitle }}</span>
        </div>

        <div class="music-player-controls">
          <button
            class="icon-btn"
            :class="{ active: musicStore.playMode !== 'order' }"
            type="button"
            :title="musicStore.playModeLabel"
            @click="cycleMode"
          >
            <component :is="modeIcon" :size="17" />
          </button>
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
          <button
            class="icon-btn"
            :class="{ active: viewMode === 'lyric' }"
            type="button"
            :title="viewMode === 'lyric' ? '回到封面' : '查看歌词'"
            @click="viewMode = viewMode === 'lyric' ? 'cover' : 'lyric'"
          >
            <Mic2 :size="17" />
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

          <!-- 音质切换：档位由服务端下发，切了会重新取流 -->
          <div class="music-quality">
            <button
              class="music-quality-btn"
              type="button"
              title="切换音质"
              @click="qualityOpen = !qualityOpen"
            >
              {{ qualityLabel }}
            </button>
            <div v-if="qualityOpen" class="music-quality-menu">
              <button
                v-for="item in musicStore.qualities"
                :key="item.value"
                class="music-quality-item"
                :class="{ active: item.value === musicStore.quality }"
                type="button"
                @click="pickQuality(item.value)"
              >
                {{ item.label }}
              </button>
            </div>
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
