<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { Clapperboard, Home, ListVideo, Settings, Star, Zap } from 'lucide-vue-next'
import { usePlaylistStore } from '../stores/playlist'

const route = useRoute()
const playlistStore = usePlaylistStore()

const navItems = [
  { to: '/', label: '首页', icon: Home },
  { to: '/player', label: '播放', icon: ListVideo, disabled: computed(() => !playlistStore.playlist) },
  { to: '/favorites', label: '收藏', icon: Star },
  { to: '/settings', label: '设置', icon: Settings }
]

const activeName = computed(() => {
  if (route.path === '/player') return '播放'
  if (route.path === '/favorites') return '收藏'
  if (route.path === '/settings') return '设置'
  return '首页'
})
</script>

<template>
  <header class="top-bar">
    <router-link to="/" class="brand">
      <span class="brand-mark"><Clapperboard :size="20" /></span>
      <span class="brand-name">流光播放器</span>
      <span class="brand-sub">m3u / m3u8</span>
    </router-link>

    <nav class="top-nav" aria-label="主导航">
      <router-link
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        class="nav-link"
        :class="{
          active: activeName === item.label,
          disabled: item.disabled?.value
        }"
        :aria-disabled="item.disabled?.value ? 'true' : undefined"
        @click="item.disabled?.value && $event.preventDefault()"
      >
        <component :is="item.icon" :size="16" />
        <span>{{ item.label }}</span>
      </router-link>
    </nav>

    <div class="top-meta">
      <span v-if="playlistStore.playlist" class="meta-chip">
        <Zap :size="13" />
        {{ playlistStore.playlist.channelCount }} 个频道
      </span>
    </div>
  </header>
</template>
