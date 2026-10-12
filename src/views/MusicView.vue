<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  AlertTriangle,
  Clock,
  Heart,
  ListPlus,
  Loader2,
  Music,
  Play,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  X
} from 'lucide-vue-next'
import MusicNav from '../components/MusicNav.vue'
import MusicPlayer from '../components/MusicPlayer.vue'
import { artistText, formatMusicDuration, musicImage } from '../lib/music'
import { useMusicStore } from '../stores/music'
import { useUiStore } from '../stores/ui'

const route = useRoute()
const router = useRouter()
const musicStore = useMusicStore()
const uiStore = useUiStore()

const playerRef = ref(null)
const keyword = ref(musicStore.query || '')
const failed = reactive(new Set())

function normalizeTab(value) {
  return ['favorites', 'history'].includes(value) ? value : 'results'
}

const tab = ref(normalizeTab(route.query.tab))

watch(
  () => route.query.tab,
  (value) => {
    tab.value = normalizeTab(value)
  }
)

function setTab(next) {
  tab.value = next
  router.replace({ path: '/music', query: next === 'results' ? {} : { tab: next } })
}

const sourceFilter = computed({
  get: () => musicStore.previewSourceId,
  set: (id) => {
    musicStore.setPreviewSource(id)
    if (musicStore.query) musicStore.search(musicStore.query).catch(() => {})
  }
})

// 三个标签共用同一份列表与空态，只切换数据来源
const items = computed(() => {
  if (tab.value === 'favorites') return musicStore.favorites
  if (tab.value === 'history') return musicStore.history
  return musicStore.results
})

const listState = computed(() => {
  if (tab.value !== 'results') return items.value.length ? 'ready' : 'empty'
  if (musicStore.searching) return 'loading'
  if (musicStore.searchError) return 'error'
  if (!musicStore.query) return 'idle'
  return musicStore.results.length ? 'ready' : 'empty'
})

const headTitle = computed(() => {
  if (tab.value === 'favorites') return '我的收藏'
  if (tab.value === 'history') return '播放历史'
  return musicStore.query ? `搜索结果「${musicStore.query}」` : '搜索结果'
})

const emptyText = computed(() => {
  if (tab.value === 'favorites') return '还没有收藏，点搜索结果右侧的 ♥ 加入'
  if (tab.value === 'history') return '还没有播放记录'
  if (!musicStore.query) return '输入关键词搜索歌曲、歌手或专辑'
  return `没有搜到「${musicStore.query}」，换个关键词或音源试试`
})

const emptyIcon = computed(() => {
  if (tab.value === 'favorites') return Heart
  if (tab.value === 'history') return Clock
  return Search
})

function rowKey(item) {
  return item.key || `${item.source}:${item.id}`
}

function isCurrent(item) {
  const current = musicStore.currentTrack
  return Boolean(current) && current.source === item.source && current.id === item.id
}

function markFailed(item) {
  failed.add(rowKey(item))
}

function historyTime(at) {
  const date = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function playRow(item) {
  if (isCurrent(item)) {
    playerRef.value?.restart()
    return
  }
  musicStore.playTrack(item, items.value)
}

function enqueue(item) {
  const added = musicStore.addToQueue(item)
  if (added) uiStore.toast(`已把「${item.name}」加入播放队列`, 'success')
  else uiStore.toast('这首歌已经在播放队列里了', 'info')
}

function toggleFavorite(item) {
  const added = musicStore.toggleFavorite(item)
  uiStore.toast(added ? `已收藏「${item.name}」` : `已取消收藏「${item.name}」`, 'success')
}

function removeItem(item) {
  if (tab.value === 'favorites') {
    musicStore.removeFavorite(item)
    uiStore.toast('已取消收藏', 'success')
    return
  }
  musicStore.removeHistory(item)
  uiStore.toast('已从历史中删除', 'success')
}

function clearCurrentList() {
  const isFavorites = tab.value === 'favorites'
  const label = isFavorites ? '全部收藏' : '全部播放历史'
  if (!window.confirm(`确定清空${label}？`)) return
  if (isFavorites) musicStore.clearFavorites()
  else musicStore.clearHistory()
  uiStore.toast('已清空', 'success')
}

async function doSearch() {
  const wd = keyword.value.trim()
  if (!wd) return
  setTab('results')
  try {
    await musicStore.search(wd)
  } catch {
    // 失败信息已存在 store.searchError
  }
}

onMounted(() => {
  musicStore.fetchSources().catch(() => {})
})
</script>

<template>
  <div class="music-page">
    <MusicNav />

    <section class="music-hero">
      <div class="music-hero-text">
        <h1><Music :size="19" /> 音乐</h1>
        <p>按 Spotube 的音源模型聚合免费音源：搜索 → 试听 → 播放。音源可在「音源管理」里启停与测试。</p>
      </div>
      <form class="music-search" @submit.prevent="doSearch">
        <Search :size="17" />
        <input
          v-model="keyword"
          type="text"
          placeholder="搜索歌曲、歌手、专辑…"
          aria-label="搜索音乐"
        />
        <button v-if="keyword" class="icon-btn" type="button" title="清空" @click="keyword = ''">
          <X :size="15" />
        </button>
        <button class="btn btn-primary" type="submit" :disabled="musicStore.searching || !keyword.trim()">
          <Loader2 v-if="musicStore.searching" class="spin" :size="16" />
          <Search v-else :size="16" />
          搜索
        </button>
      </form>
    </section>

    <p v-if="musicStore.sourcesError" class="load-error">{{ musicStore.sourcesError }}</p>

    <div class="music-toolbar">
      <label class="music-source-filter">
        <SlidersHorizontal :size="15" />
        <span>音源</span>
        <select v-model="sourceFilter" :disabled="!musicStore.enabledSources.length">
          <option value="">全部已启用音源</option>
          <option v-for="s in musicStore.enabledSources" :key="s.id" :value="s.id">
            {{ s.name }}{{ s.status === 'ok' ? ' ✓' : s.status === 'fail' ? ' ✕' : '' }}
          </option>
        </select>
      </label>
      <span class="count-note">
        已启用 {{ musicStore.enabledSources.length }} / {{ musicStore.sources.length }} 个音源
      </span>
    </div>

    <div class="music-tabs">
      <button
        class="music-tab"
        :class="{ active: tab === 'results' }"
        type="button"
        @click="setTab('results')"
      >
        <Search :size="15" /> 搜索结果
        <span v-if="musicStore.results.length" class="music-tab-count">{{ musicStore.results.length }}</span>
      </button>
      <button
        class="music-tab"
        :class="{ active: tab === 'favorites' }"
        type="button"
        @click="setTab('favorites')"
      >
        <Heart :size="15" /> 我的收藏
        <span v-if="musicStore.favorites.length" class="music-tab-count">{{ musicStore.favorites.length }}</span>
      </button>
      <button
        class="music-tab"
        :class="{ active: tab === 'history' }"
        type="button"
        @click="setTab('history')"
      >
        <Clock :size="15" /> 播放历史
        <span v-if="musicStore.history.length" class="music-tab-count">{{ musicStore.history.length }}</span>
      </button>
    </div>

    <div v-if="tab === 'results' && musicStore.errors.length" class="music-alert">
      <AlertTriangle :size="15" />
      <div>
        <strong>部分音源搜索失败</strong>
        <ul>
          <li v-for="e in musicStore.errors" :key="e.source">
            {{ e.sourceName || e.source }}：{{ e.error }}
          </li>
        </ul>
      </div>
    </div>

    <div class="section-head spaced">
      <h2>{{ headTitle }}</h2>
      <div class="music-head-actions">
        <span v-if="listState === 'ready'" class="count-note">{{ items.length }} 首</span>
        <button
          v-if="tab === 'favorites' && musicStore.favorites.length"
          class="btn btn-ghost btn-small"
          type="button"
          @click="clearCurrentList"
        >
          <Trash2 :size="14" /> 清空
        </button>
        <button
          v-else-if="tab === 'history' && musicStore.history.length"
          class="btn btn-ghost btn-small"
          type="button"
          @click="clearCurrentList"
        >
          <Trash2 :size="14" /> 清空
        </button>
        <button
          v-else-if="tab === 'results' && musicStore.query"
          class="text-link"
          type="button"
          @click="doSearch"
        >
          <RefreshCw :size="14" /> 重新搜索
        </button>
      </div>
    </div>

    <div v-if="listState === 'loading'" class="music-state">
      <Loader2 class="spin" :size="22" /> 正在聚合搜索多个音源…
    </div>

    <div v-else-if="listState === 'error'" class="music-state error">
      <AlertTriangle :size="20" /> {{ musicStore.searchError }}
      <button class="btn btn-small btn-secondary" type="button" @click="doSearch">
        <RefreshCw :size="14" /> 重试
      </button>
    </div>

    <div v-else-if="listState === 'ready'" class="music-list">
      <article
        v-for="item in items"
        :key="rowKey(item)"
        class="music-row"
        :class="{ active: isCurrent(item) }"
        @click="playRow(item)"
      >
        <div class="music-cover">
          <img
            v-if="item.pic && !failed.has(rowKey(item))"
            :src="musicImage(item.pic)"
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
            @error="markFailed(item)"
          />
          <span v-else>{{ (item.name || '?').slice(0, 1) }}</span>
        </div>

        <div class="music-main">
          <strong class="music-name">
            {{ item.name }}
            <span v-if="item.preview" class="music-badge preview">试听</span>
          </strong>
          <span class="music-sub">
            {{ artistText(item.artists) || '未知艺术家' }}
            <template v-if="item.album"> · {{ item.album }}</template>
            <template v-if="tab === 'history' && item.at"> · {{ historyTime(item.at) }}</template>
          </span>
        </div>

        <span class="music-badge music-source-badge">{{ item.sourceName || item.source }}</span>
        <span class="music-duration">{{ formatMusicDuration(item.duration) }}</span>

        <div class="music-actions" @click.stop>
          <button class="icon-btn" type="button" title="播放" @click="playRow(item)">
            <Play :size="15" />
          </button>
          <button class="icon-btn" type="button" title="加入队列" @click="enqueue(item)">
            <ListPlus :size="15" />
          </button>
          <button
            v-if="tab === 'results'"
            class="icon-btn"
            :class="{ active: musicStore.isFavorite(item) }"
            type="button"
            title="收藏"
            @click="toggleFavorite(item)"
          >
            <Heart :size="15" />
          </button>
          <button v-else class="icon-btn danger" type="button" title="删除" @click="removeItem(item)">
            <Trash2 :size="15" />
          </button>
        </div>
      </article>
    </div>

    <div v-else class="empty-block">
      <component :is="emptyIcon" :size="22" /> {{ emptyText }}
    </div>

    <footer class="disclaimer">
      <strong>说明</strong>
      <span>
        音乐来自第三方公开音源（Piped / Invidious / JioSaavn / Apple 试听），本站只做搜索聚合与播放代理，不存储任何音频。
      </span>
    </footer>

    <MusicPlayer ref="playerRef" />
  </div>
</template>
