<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import videojs from 'video.js'
import {
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Film,
  Heart,
  Loader2,
  Maximize,
  PictureInPicture2,
  Play,
  RotateCcw,
  Zap
} from 'lucide-vue-next'
import { vodApi } from '../lib/vod'
import { usePlayerStore } from '../stores/player'
import { useVodStore } from '../stores/vod'
import { useUiStore } from '../stores/ui'

const route = useRoute()
const router = useRouter()
const playerStore = usePlayerStore()
const vodStore = useVodStore()
const uiStore = useUiStore()

const videoRef = ref(null)
const loading = ref(true)
const error = ref('')
const detail = ref(null)
const siteName = ref('')
const activeLine = ref(0)
const currentIndex = ref(0)
const playing = ref(false)
const playError = ref('')
const playLoading = ref(false)
const showBest = ref(false)
const bestLoading = ref(false)
const bestList = ref([])
const bestError = ref('')
const bestCacheAt = ref(0)

let player = null
let triedProxy = false
let applyToken = 0
let autoTried = false
let lastProgressSave = 0
let stallTimer = null
const playCache = new Map()
// 已尝试过的线路（组件级：切换线路时 Vue 复用组件实例，离开播放页即重置），避免自动切台来回打转
const triedSources = new Set()

// 源站清单能拉到、但分片被拒（502/403）时 VHS 会无限重试且不派发 error，这里起个兜底计时器
const STALL_MS = 15000

function clearStallWatch() {
  if (stallTimer) {
    clearTimeout(stallTimer)
    stallTimer = null
  }
}

function armStallWatch() {
  clearStallWatch()
  stallTimer = setTimeout(() => {
    stallTimer = null
    if (!player || player.isDisposed()) return
    if (player.readyState() >= 2 || player.currentTime() > 0.5) return
    handleError(true)
  }, STALL_MS)
}

const favSite = () => String(route.params.site)
const favId = () => String(route.params.id)
const isFav = computed(() => detail.value && vodStore.isFavorite(favSite(), favId()))

const pipSupported = computed(
  () => typeof document !== 'undefined' && Boolean(document.pictureInPictureEnabled)
)

const lines = computed(() => {
  const d = detail.value
  if (!d) return []
  const names = d.playFrom || []
  return (d.playUrl || []).map((episodes, index) => ({
    name: names[index] || `线路${index + 1}`,
    episodes
  }))
})

const episodes = computed(() => lines.value[activeLine.value]?.episodes || [])
const currentEpisode = computed(() => episodes.value[currentIndex.value] || null)

function mediaType(url) {
  const path = String(url || '').split('?')[0].toLowerCase()
  if (path.endsWith('.mp4')) return 'video/mp4'
  if (path.endsWith('.webm')) return 'video/webm'
  return 'application/x-mpegURL'
}

// 解析真实地址 + 走服务端 HLS 代理（解决 Referer / 跨域 / 网页播放页）
async function getPlaySrc(ep) {
  if (playCache.has(ep.url)) return playCache.get(ep.url)
  const data = await vodApi.play(ep.url)
  const direct = data.url || ep.url
  const info = {
    src: data.playUrl || ep.url,
    direct,
    type: /\.mp4(\?|$)/i.test(direct) ? 'video/mp4' : 'application/x-mpegURL'
  }
  playCache.set(ep.url, info)
  return info
}

function initPlayer() {
  if (player || !videoRef.value) return
  player = videojs(videoRef.value, {
    autoplay: true,
    controls: true,
    fluid: true,
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
  player.on('playing', () => {
    playing.value = true
    playError.value = ''
    clearStallWatch()
  })
  player.on('loadeddata', clearStallWatch)
  player.on('waiting', () => {
    playing.value = false
  })
  player.on('error', () => handleError())
  player.on('ended', () => {
    vodStore.updateProgress(favSite(), favId(), player.duration(), player.duration())
    playNext()
  })
  player.on('timeupdate', () => {
    const now = Date.now()
    if (now - lastProgressSave < 5000) return
    lastProgressSave = now
    const t = player.currentTime()
    if (t > 1) vodStore.updateProgress(favSite(), favId(), t, player.duration())
  })
  player.on('volumechange', () => {
    if (player.muted()) {
      if (!playerStore.muted) playerStore.setPrefs({ muted: true })
    } else {
      const vol = player.volume()
      if (Math.abs(vol - playerStore.volume) > 0.01 || playerStore.muted) {
        playerStore.setPrefs({ volume: vol, muted: false })
      }
    }
  })
  player.on('ratechange', () => {
    const rate = player.playbackRate()
    if (rate && Math.abs(rate - playerStore.playbackRate) > 0.001) {
      playerStore.setPrefs({ playbackRate: rate })
    }
  })
}

async function applySource() {
  const ep = currentEpisode.value
  if (!player || player.isDisposed() || !ep) return
  const token = ++applyToken
  playError.value = ''
  triedProxy = false
  playLoading.value = true
  try {
    const info = await getPlaySrc(ep)
    if (token !== applyToken || !player || player.isDisposed()) return
    player.src({ src: info.src, type: info.type })
    const resumeAt = Number(route.query.t) || 0
    if (resumeAt > 10) {
      player.one('loadedmetadata', () => {
        try {
          player.currentTime(resumeAt)
        } catch {
          // 忽略
        }
      })
    }
    player.play().catch(() => {})
    armStallWatch()
  } catch {
    if (token !== applyToken || !player || player.isDisposed()) return
    // 解析/代理失败时退回直连
    player.src({ src: ep.url, type: mediaType(ep.url) })
    player.play().catch(() => {})
    armStallWatch()
  } finally {
    if (token === applyToken) playLoading.value = false
  }
}

function handleError(fromStall = false) {
  clearStallWatch()
  if (!player || player.isDisposed()) return
  const ep = currentEpisode.value
  if (!ep) return
  // 真·error 事件时才退回直连（部分源允许跨域）；卡死说明地址已解析成功、是源站拒了分片，直连没意义，直接换源
  if (!fromStall && !triedProxy) {
    triedProxy = true
    // 代理失败时退回直连（部分源本身允许跨域）
    player.src({ src: ep.url, type: mediaType(ep.url) })
    player.play().catch(() => {})
    armStallWatch()
    return
  }
  playing.value = false
  playError.value = '播放失败：源站不可用、已下架或存在跨域限制'
  void autoSwitchOnFail()
}

function toggleFav() {
  if (!detail.value) return
  vodStore.toggleFavorite({
    site: favSite(),
    id: favId(),
    name: detail.value.name,
    pic: detail.value.pic,
    year: detail.value.year,
    type: detail.value.type,
    remarks: detail.value.remarks
  })
}

async function loadBest(force = false) {
  if (!detail.value) return
  const cached = !force && vodStore.getBest(detail.value.name, detail.value.year)
  if (cached) {
    bestList.value = cached.data.list || []
    bestCacheAt.value = cached.at
    bestError.value = bestList.value.length ? '' : '没有找到其他可用线路'
    return
  }
  bestLoading.value = true
  bestError.value = ''
  if (force) bestList.value = []
  try {
    const data = await vodApi.best(detail.value.name, { year: detail.value.year, limit: 10 })
    bestList.value = data.list || []
    bestCacheAt.value = Date.now()
    vodStore.setBest(detail.value.name, detail.value.year, data)
    if (!bestList.value.length) bestError.value = '没有找到其他可用线路'
  } catch (err) {
    bestError.value = err.message || '选路失败'
  } finally {
    bestLoading.value = false
  }
}

// 播放失败时自动切到同片最快线路（只尝试一次；优先用缓存）
async function autoSwitchOnFail() {
  if (autoTried || !detail.value) return
  autoTried = true
  try {
    const cached = vodStore.getBest(detail.value.name, detail.value.year)
    let data = cached?.data
    if (!data) {
      data = await vodApi.best(detail.value.name, { year: detail.value.year, limit: 8 })
      vodStore.setBest(detail.value.name, detail.value.year, data)
      bestCacheAt.value = Date.now()
    }
    const cand = (data.list || []).find(
      (x) =>
        x.ok &&
        !(x.site === favSite() && x.id === favId()) &&
        !triedSources.has(`${x.site}|${x.id}`)
    )
    if (cand) {
      triedSources.add(`${favSite()}|${favId()}`)
      triedSources.add(`${cand.site}|${cand.id}`)
      uiStore.toast(`当前线路不可用，已自动切换到「${cand.siteName}」`, 'warning')
      switchToSource(cand)
    }
  } catch {
    // 忽略
  }
}

function switchToSource(item) {
  router.replace({
    path: `/vod/play/${item.site}/${encodeURIComponent(item.id)}`,
    query: { line: 0, index: 0 }
  })
}

async function openBest() {
  showBest.value = !showBest.value
  if (showBest.value && !bestList.value.length) await loadBest()
}

function bestCachedAt() {
  return bestCacheAt.value
}

function gotoEpisode(lineIndex, index) {
  router.replace({
    path: route.path,
    query: { line: lineIndex, index }
  })
}

function playNext() {
  if (currentIndex.value < episodes.value.length - 1) {
    gotoEpisode(activeLine.value, currentIndex.value + 1)
  }
}

function playPrev() {
  if (currentIndex.value > 0) gotoEpisode(activeLine.value, currentIndex.value - 1)
}

function switchLine(index) {
  activeLine.value = index
  if (episodes.value.length) gotoEpisode(index, 0)
}

function retry() {
  playError.value = ''
  applySource()
}

function togglePlay() {
  if (!player) return
  if (player.paused()) player.play().catch(() => {})
  else player.pause()
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
    if (document.pictureInPictureElement === videoEl) await document.exitPictureInPicture()
    else await videoEl.requestPictureInPicture()
  } catch {
    uiStore.toast('画中画切换失败', 'warning')
  }
}

async function load() {
  loading.value = true
  error.value = ''
  detail.value = null
  showBest.value = false
  bestList.value = []
  bestError.value = ''
  bestCacheAt.value = 0
  autoTried = false
  try {
    const data = await vodApi.detail(String(route.params.site), String(route.params.id))
    detail.value = data.detail
    siteName.value = data.siteName || ''
    const line = Math.min(Math.max(Number(route.query.line) || 0, 0), Math.max(lines.value.length - 1, 0))
    activeLine.value = line
    currentIndex.value = Math.min(
      Math.max(Number(route.query.index) || 0, 0),
      Math.max(episodes.value.length - 1, 0)
    )
    if (!episodes.value.length) {
      error.value = '该影片暂无可用播放地址'
    } else {
      const ep = currentEpisode.value
      vodStore.addRecent({
        site: route.params.site,
        id: route.params.id,
        name: detail.value.name,
        pic: detail.value.pic,
        line: activeLine.value,
        index: currentIndex.value,
        episodeName: ep?.name || ''
      })
    }
  } catch (err) {
    error.value = err.message || '加载失败'
  } finally {
    loading.value = false
  }
  // 播放器元素在 loading 结束后才渲染，需等 DOM 更新后再初始化
  await nextTick()
  initPlayer()
  if (!error.value && currentEpisode.value) applySource()
}

watch(
  () => `${route.params.site}|${route.params.id}`,
  () => {
    playCache.clear()
    clearStallWatch()
    applyToken += 1
    // 参数变化时模板会重建 <video>，必须销毁旧实例；否则播放器仍绑在被移除的元素上，画布永远黑屏
    if (player) {
      player.dispose()
      player = null
    }
    load()
  }
)

watch(
  () => `${route.query.line}|${route.query.index}`,
  () => {
    if (!detail.value) return
    activeLine.value = Math.min(
      Math.max(Number(route.query.line) || 0, 0),
      Math.max(lines.value.length - 1, 0)
    )
    currentIndex.value = Math.min(
      Math.max(Number(route.query.index) || 0, 0),
      Math.max(episodes.value.length - 1, 0)
    )
    applySource()
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

onMounted(() => {
  load()
})

onBeforeUnmount(() => {
  clearStallWatch()
  if (player) {
    player.dispose()
    player = null
  }
})
</script>

<template>
  <div class="vod-player-page">
    <div class="player-header">
      <button class="icon-btn" type="button" title="返回详情" @click="router.back()">
        <ArrowLeft :size="18" />
      </button>
      <div class="header-info">
        <h1>{{ detail?.name || '播放' }}</h1>
        <div class="header-badges">
          <span v-if="siteName">{{ siteName }}</span>
          <span v-if="currentEpisode">{{ currentEpisode.name }}</span>
          <span v-if="lines.length > 1">{{ lines[activeLine]?.name }}</span>
        </div>
      </div>
      <div class="header-actions">
        <button
          class="icon-btn"
          :class="{ active: isFav }"
          type="button"
          :title="isFav ? '取消收藏' : '收藏'"
          @click="toggleFav"
        >
          <Heart :size="17" :fill="isFav ? 'currentColor' : 'none'" />
        </button>
      </div>
    </div>

    <div v-if="loading" class="vod-state"><Loader2 class="spin" :size="24" /> 正在加载播放地址…</div>

    <div v-else-if="error" class="vod-state error">
      <AlertTriangle :size="22" /> {{ error }}
      <button class="btn btn-small btn-secondary" type="button" @click="load">
        <RotateCcw :size="14" /> 重试
      </button>
    </div>

    <div v-else class="vod-player-layout">
      <section class="vod-stage">
        <div class="vod-video-wrap" @dblclick="toggleFullscreen">
          <video ref="videoRef" class="video-js vjs-big-play-centered"></video>
          <div v-if="playLoading" class="player-overlay">
            <Loader2 class="spin" :size="30" />
            <span>正在解析播放地址…</span>
          </div>
          <div v-if="playError" class="player-overlay error-overlay">
            <AlertTriangle :size="32" />
            <strong>播放失败</strong>
            <span>{{ playError }}</span>
            <div class="error-actions">
              <button class="btn btn-secondary" type="button" @click="retry">
                <RotateCcw :size="15" /> 重试
              </button>
              <button
                v-if="lines.length > 1"
                class="btn btn-primary"
                type="button"
                @click="switchLine((activeLine + 1) % lines.length)"
              >
                换个线路
              </button>
            </div>
          </div>
        </div>

        <div class="vod-stage-tools">
          <button class="icon-btn" type="button" title="上一集" :disabled="currentIndex <= 0" @click="playPrev">
            <ChevronLeft :size="17" />
          </button>
          <button class="icon-btn" type="button" title="播放 / 暂停" @click="togglePlay">
            <Play :size="17" />
          </button>
          <button
            class="icon-btn"
            type="button"
            title="下一集"
            :disabled="currentIndex >= episodes.length - 1"
            @click="playNext"
          >
            <ChevronRight :size="17" />
          </button>
          <button v-if="pipSupported" class="icon-btn" type="button" title="画中画" @click="togglePip">
            <PictureInPicture2 :size="17" />
          </button>
          <button class="icon-btn" type="button" title="全屏" @click="toggleFullscreen">
            <Maximize :size="17" />
          </button>
          <button
            class="icon-btn"
            :class="{ active: showBest }"
            type="button"
            title="多源选路（换源）"
            @click="openBest"
          >
            <Zap :size="17" />
          </button>
          <span class="vod-stage-title">{{ currentEpisode?.name }}</span>
        </div>
      </section>

      <aside class="vod-episode-panel">
        <div v-if="lines.length > 1" class="vod-lines">
          <button
            v-for="(line, index) in lines"
            :key="index"
            class="vod-chip sm"
            :class="{ active: activeLine === index }"
            type="button"
            @click="switchLine(index)"
          >
            {{ line.name }}
          </button>
        </div>
        <div class="vod-episode-scroll">
          <button
            v-for="(ep, index) in episodes"
            :key="index"
            class="vod-episode"
            :class="{ active: index === currentIndex }"
            type="button"
            :title="ep.name"
            @click="gotoEpisode(activeLine, index)"
          >
            {{ ep.name }}
          </button>
        </div>
      </aside>
    </div>

    <section v-if="showBest" class="vod-best">
      <div class="section-head">
        <h2><Zap :size="16" /> 同片其他线路</h2>
        <div class="vod-head-actions">
          <span v-if="bestCachedAt()" class="count-note">
            缓存于 {{ new Date(bestCachedAt()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}
          </span>
          <button class="btn btn-ghost btn-small" type="button" :disabled="bestLoading" @click="loadBest(true)">
            <Loader2 v-if="bestLoading" class="spin" :size="13" />
            <RotateCcw v-else :size="13" />
            重新测速
          </button>
        </div>
      </div>
      <p v-if="bestError" class="load-error">{{ bestError }}</p>
      <div v-if="bestList.length" class="vod-best-list">
        <button
          v-for="item in bestList"
          :key="`${item.site}|${item.id}`"
          class="vod-best-row"
          :class="{ current: item.site === favSite() && item.id === favId() }"
          type="button"
          @click="switchToSource(item)"
        >
          <span class="vod-best-dot" :class="item.ok ? 'ok' : 'fail'"></span>
          <span class="vod-best-name">{{ item.siteName }}</span>
          <span class="vod-best-title">{{ item.name }}</span>
          <span class="vod-best-ep">{{ item.episodeName }}</span>
          <span class="vod-best-latency">{{ item.ok ? item.latency + ' ms' : '不可用' }}</span>
        </button>
      </div>
    </section>

    <footer class="disclaimer">
      <strong>免责声明</strong>
      <span>影视数据来自第三方采集接口，本站不存储、不转码、不传播任何内容；播放可用性取决于对应源站。</span>
    </footer>
  </div>
</template>
