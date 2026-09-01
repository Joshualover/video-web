<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, Clock, History, Play, Search, Trash2 } from 'lucide-vue-next'
import { useLibraryStore } from '../stores/library'
import { usePlaylistStore } from '../stores/playlist'

const router = useRouter()
const libraryStore = useLibraryStore()
const playlistStore = usePlaylistStore()
const search = ref('')

const filteredRecents = computed(() => {
  const query = search.value.trim().toLowerCase()
  if (!query) return libraryStore.recents
  return libraryStore.recents.filter(
    (item) =>
      item.name.toLowerCase().includes(query) ||
      item.group?.toLowerCase().includes(query) ||
      item.sourceName?.toLowerCase().includes(query)
  )
})

function playRecent(item) {
  playlistStore.playSingle(
    {
      id: 'single-recent',
      name: item.name,
      url: item.url,
      logo: item.logo,
      group: item.group || '未分类',
      valid: true,
      status: 'idle',
      duration: -1
    },
    item.sourceName || '最近播放',
    item.sourceUrl
  )
  router.push('/player')
}

function formatTime(timestamp) {
  const date = new Date(timestamp)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
</script>

<template>
  <div class="recents-page">
    <header class="page-head">
      <button class="icon-btn" type="button" title="返回首页" @click="router.push('/')">
        <ArrowLeft :size="18" />
      </button>
      <div>
        <h1>最近播放</h1>
        <p>{{ libraryStore.recentCount }} 条记录（最多保留 20 条）</p>
      </div>
      <div class="channel-search">
        <Search :size="15" />
        <input v-model="search" type="text" placeholder="搜索最近播放" aria-label="搜索最近播放" />
      </div>
      <button
        v-if="libraryStore.recentCount"
        class="btn btn-small btn-danger"
        type="button"
        @click="libraryStore.clearRecents()"
      >
        <Trash2 :size="14" /> 清空
      </button>
    </header>

    <div v-if="filteredRecents.length" class="favorites-list">
      <article v-for="item in filteredRecents" :key="item.id" class="favorite-row">
        <button class="favorite-main" type="button" @click="playRecent(item)">
          <span class="channel-logo">
            <img v-if="item.logo" :src="item.logo" alt="" loading="lazy" />
            <span v-else class="channel-logo-fallback">{{ item.name.slice(0, 1) }}</span>
          </span>
          <span class="favorite-text">
            <strong>{{ item.name }}</strong>
            <span>{{ item.group || '未分类' }} · {{ item.sourceName }} · {{ formatTime(item.playedAt) }}</span>
          </span>
          <span class="btn btn-small btn-primary">
            <Play :size="14" /> 播放
          </span>
        </button>
      </article>
    </div>

    <div v-else class="page-state">
      <History :size="36" />
      <h1>暂无播放记录</h1>
      <p>播放过的频道会出现在这里。</p>
      <button class="btn btn-primary" type="button" @click="router.push('/')">
        <Clock :size="16" /> 去首页
      </button>
    </div>
  </div>
</template>
