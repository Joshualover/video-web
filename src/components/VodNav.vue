<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { Clock, Compass, Heart, Server } from 'lucide-vue-next'
import { useVodStore } from '../stores/vod'

const route = useRoute()
const vodStore = useVodStore()

const items = computed(() => [
  { to: '/vod', label: '发现', icon: Compass, count: 0 },
  { to: '/vod/favorites', label: '收藏', icon: Heart, count: vodStore.favorites.length },
  { to: '/vod/history', label: '历史', icon: Clock, count: vodStore.recents.length },
  { to: '/vod/sources', label: '源管理', icon: Server, count: vodStore.sources.length }
])

function isActive(to) {
  if (to === '/vod') return ['vod', 'vod-detail', 'vod-play'].includes(route.name)
  return route.path === to
}
</script>

<template>
  <nav class="vod-nav">
    <router-link
      v-for="item in items"
      :key="item.to"
      :to="item.to"
      class="vod-nav-link"
      :class="{ active: isActive(item.to) }"
    >
      <component :is="item.icon" :size="15" />
      <span>{{ item.label }}</span>
      <span v-if="item.count" class="vod-nav-count">{{ item.count }}</span>
    </router-link>
  </nav>
</template>
