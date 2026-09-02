<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Heart, Play } from 'lucide-vue-next'
import { usePlaylistStore } from '../stores/playlist'
import { useLibraryStore } from '../stores/library'
import { useUiStore } from '../stores/ui'

// 模块级缓存：坏 logo 在重新挂载后不再重复请求
const brokenLogos = new Set()

const props = defineProps({
  height: { type: String, default: '100%' },
  view: { type: String, default: 'list' } // 'list' | 'grid'
})

const emit = defineEmits(['play'])

const playlistStore = usePlaylistStore()
const libraryStore = useLibraryStore()
const uiStore = useUiStore()

const ROW_HEIGHT = 56
const OVERSCAN = 6
const containerRef = ref(null)
const scrollTop = ref(0)
const viewportHeight = ref(600)

const isGrid = computed(() => props.view === 'grid')
const filtered = computed(() => playlistStore.filteredChannels)

// ---- 列表视图（虚拟滚动）----
const startIndex = computed(() => {
  const start = Math.floor((scrollTop.value - OVERSCAN * ROW_HEIGHT) / ROW_HEIGHT)
  return Math.max(0, start)
})

const endIndex = computed(() => {
  const end = Math.ceil(
    (scrollTop.value + viewportHeight.value + OVERSCAN * ROW_HEIGHT) / ROW_HEIGHT
  )
  return Math.min(filtered.value.length, end)
})

const visibleChannels = computed(() =>
  filtered.value.slice(startIndex.value, endIndex.value)
)

const totalHeight = computed(() => filtered.value.length * ROW_HEIGHT)

function onScroll() {
  scrollTop.value = containerRef.value?.scrollTop || 0
}

function updateViewport() {
  if (!containerRef.value) return
  viewportHeight.value = containerRef.value.clientHeight || 600
}

// ---- 通用 ----
function logoFailed(channel) {
  brokenLogos.add(channel.id)
  channel.logo = ''
}

function channelStatusClass(channel) {
  if (!channel.valid) return 'invalid'
  if (channel.id === playlistStore.activeChannelId) return 'playing'
  return channel.status || 'idle'
}

function selectChannel(channel) {
  if (!channel.valid) return
  playlistStore.setActiveChannel(channel.id)
  emit('play', channel)
}

function toggleFavorite(channel, event) {
  event.stopPropagation()
  if (!playlistStore.playlist) return
  libraryStore.toggleFavorite(
    channel,
    playlistStore.playlist.name,
    playlistStore.playlist.sourceUrl
  )
}

function isFavorite(channel) {
  if (!playlistStore.playlist) return false
  return libraryStore.isFavorite(channel, playlistStore.playlist.sourceUrl)
}

function scrollActiveIntoView() {
  const index = filtered.value.findIndex(
    (channel) => channel.id === playlistStore.activeChannelId
  )
  if (index < 0 || !containerRef.value) return
  if (isGrid.value) {
    const el = containerRef.value.querySelector(
      `.channel-card[data-id="${playlistStore.activeChannelId}"]`
    )
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    return
  }
  const top = index * ROW_HEIGHT
  if (top < scrollTop.value || top > scrollTop.value + viewportHeight.value - ROW_HEIGHT) {
    containerRef.value.scrollTop = Math.max(0, top - viewportHeight.value / 2)
  }
}

watch(() => playlistStore.activeChannelId, () => nextTick(scrollActiveIntoView))

// 搜索 / 切换分组 / 更换列表后，列表内容变化，滚动位置重置到顶部
watch(
  () => [playlistStore.search, playlistStore.activeGroup, playlistStore.playlist?.channels],
  () => {
    if (containerRef.value) containerRef.value.scrollTop = 0
    scrollTop.value = 0
  }
)

onMounted(() => {
  updateViewport()
  window.addEventListener('resize', updateViewport)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateViewport)
})
</script>

<template>
  <div
    v-if="isGrid"
    class="channel-list channel-grid"
    :class="'card-' + uiStore.channelCardSize"
    ref="containerRef"
    :style="{ height }"
    @scroll.passive="onScroll"
  >
    <button
      v-for="channel in filtered"
      :key="channel.id"
      class="channel-card"
      :data-id="channel.id"
      :class="{
        active: channel.id === playlistStore.activeChannelId,
        invalid: !channel.valid
      }"
      type="button"
      :title="channel.valid ? channel.name : '地址格式无效'"
      @click="selectChannel(channel)"
    >
      <span class="channel-thumb">
        <img
          v-if="channel.logo && !brokenLogos.has(channel.id)"
          :src="channel.logo"
          alt=""
          loading="lazy"
          @error="logoFailed(channel)"
        />
        <span v-else class="channel-thumb-fallback">{{ channel.name.slice(0, 2) }}</span>
        <span class="status-dot" :class="channelStatusClass(channel)"></span>
      </span>
      <span class="channel-card-name">{{ channel.name }}</span>
      <button
        class="icon-btn fav-btn"
        :class="{ active: isFavorite(channel) }"
        type="button"
        :title="isFavorite(channel) ? '取消收藏' : '收藏'"
        @click="toggleFavorite(channel, $event)"
      >
        <Heart :size="13" :fill="isFavorite(channel) ? 'currentColor' : 'none'" />
      </button>
    </button>

    <div v-if="!filtered.length" class="channel-empty">
      <Play :size="22" />
      <span>没有匹配的频道</span>
    </div>
  </div>

  <div
    v-else
    class="channel-list"
    ref="containerRef"
    :style="{ height }"
    @scroll.passive="onScroll"
  >
    <div class="channel-list-inner" :style="{ height: totalHeight + 'px' }">
      <button
        v-for="(channel, index) in visibleChannels"
        :key="channel.id"
        class="channel-row"
        :class="{
          active: channel.id === playlistStore.activeChannelId,
          invalid: !channel.valid
        }"
        :style="{ transform: `translateY(${(startIndex + index) * ROW_HEIGHT}px)` }"
        type="button"
        :title="channel.valid ? channel.name : '地址格式无效'"
        @click="selectChannel(channel)"
      >
        <span class="channel-logo">
          <img
            v-if="channel.logo && !brokenLogos.has(channel.id)"
            :src="channel.logo"
            alt=""
            loading="lazy"
            @error="logoFailed(channel)"
          />
          <span v-else class="channel-logo-fallback">{{ channel.name.slice(0, 1) }}</span>
        </span>
        <span class="channel-text">
          <span class="channel-name">{{ channel.name }}</span>
          <span class="channel-sub">{{ channel.group }}</span>
        </span>
        <span class="status-dot" :class="channelStatusClass(channel)"></span>
        <button
          class="icon-btn fav-btn"
          :class="{ active: isFavorite(channel) }"
          type="button"
          :title="isFavorite(channel) ? '取消收藏' : '收藏'"
          @click="toggleFavorite(channel, $event)"
        >
          <Heart :size="15" :fill="isFavorite(channel) ? 'currentColor' : 'none'" />
        </button>
      </button>
    </div>

    <div v-if="!filtered.length" class="channel-empty">
      <Play :size="22" />
      <span>没有匹配的频道</span>
    </div>
  </div>
</template>
