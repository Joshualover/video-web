<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, Heart, Play, Search, Star, Trash2 } from 'lucide-vue-next'
import { useLibraryStore } from '../stores/library'
import { usePlaylistStore } from '../stores/playlist'

const router = useRouter()
const libraryStore = useLibraryStore()
const playlistStore = usePlaylistStore()
const search = ref('')

const filteredFavorites = computed(() => {
  const query = search.value.trim().toLowerCase()
  if (!query) return libraryStore.favorites
  return libraryStore.favorites.filter(
    (item) =>
      item.name.toLowerCase().includes(query) ||
      item.group?.toLowerCase().includes(query) ||
      item.sourceName?.toLowerCase().includes(query)
  )
})

function playFavorite(item) {
  playlistStore.playSingle(
    {
      id: 'single-favorite',
      name: item.name,
      url: item.url,
      logo: item.logo,
      group: item.group || '未分类',
      valid: true,
      status: 'idle',
      duration: -1
    },
    item.sourceName || '收藏',
    item.sourceUrl
  )
  router.push('/player')
}

function removeFavorite(item) {
  libraryStore.toggleFavorite(
    { name: item.name, url: item.url, logo: item.logo, group: item.group },
    item.sourceName,
    item.sourceUrl
  )
}
</script>

<template>
  <div class="favorites-page">
    <header class="page-head">
      <button class="icon-btn" type="button" title="返回首页" @click="router.push('/')">
        <ArrowLeft :size="18" />
      </button>
      <div>
        <h1>收藏</h1>
        <p>{{ libraryStore.favoriteCount }} / 100 个频道</p>
      </div>
      <div class="channel-search">
        <Search :size="15" />
        <input v-model="search" type="text" placeholder="搜索收藏" aria-label="搜索收藏" />
      </div>
    </header>

    <div v-if="filteredFavorites.length" class="favorites-list">
      <article v-for="item in filteredFavorites" :key="item.id" class="favorite-row">
        <button class="favorite-main" type="button" @click="playFavorite(item)">
          <span class="channel-logo">
            <img v-if="item.logo" :src="item.logo" alt="" loading="lazy" />
            <span v-else class="channel-logo-fallback">{{ item.name.slice(0, 1) }}</span>
          </span>
          <span class="favorite-text">
            <strong>{{ item.name }}</strong>
            <span>{{ item.group || '未分类' }} · {{ item.sourceName }}</span>
          </span>
          <span class="btn btn-small btn-primary">
            <Play :size="14" /> 播放
          </span>
        </button>
        <button
          class="icon-btn danger"
          type="button"
          title="移除收藏"
          @click="removeFavorite(item)"
        >
          <Trash2 :size="16" />
        </button>
      </article>
    </div>

    <div v-else class="page-state">
      <Heart :size="36" />
      <h1>暂无收藏</h1>
      <p>在播放页点击频道行或播放器上的心形按钮，即可收藏频道。</p>
      <button class="btn btn-primary" type="button" @click="router.push('/')">
        <Star :size="16" /> 去首页
      </button>
    </div>
  </div>
</template>
