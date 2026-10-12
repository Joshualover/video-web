<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { Clock, Heart, Search, Server } from 'lucide-vue-next'
import { useMusicStore } from '../stores/music'

const route = useRoute()
const musicStore = useMusicStore()

// 收藏 / 历史是音乐主页里的标签，用 query 表达，便于直接跳转与刷新后保留
const items = computed(() => [
  { to: '/music', label: '音乐搜索', icon: Search, count: 0 },
  { to: '/music', label: '收藏', icon: Heart, count: musicStore.favorites.length, query: { tab: 'favorites' } },
  { to: '/music', label: '历史', icon: Clock, count: musicStore.history.length, query: { tab: 'history' } },
  { to: '/music/sources', label: '音源管理', icon: Server, count: musicStore.sources.length }
])

function isActive(item) {
  if (item.to === '/music/sources') return route.path === '/music/sources'
  if (route.path !== '/music') return false
  const tab = ['favorites', 'history'].includes(route.query.tab) ? route.query.tab : 'results'
  if (item.label === '收藏') return tab === 'favorites'
  if (item.label === '历史') return tab === 'history'
  return tab === 'results'
}
</script>

<template>
  <nav class="music-nav">
    <router-link
      v-for="item in items"
      :key="item.label"
      :to="item.query ? { path: item.to, query: item.query } : { path: item.to }"
      class="music-nav-link"
      :class="{ active: isActive(item) }"
    >
      <component :is="item.icon" :size="15" />
      <span>{{ item.label }}</span>
      <span v-if="item.count" class="music-nav-count">{{ item.count }}</span>
    </router-link>
  </nav>
</template>
