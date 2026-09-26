<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, Layers, LayoutGrid, Play, Plus } from 'lucide-vue-next'
import { usePlaylistStore } from '../stores/playlist'

const router = useRouter()
const playlistStore = usePlaylistStore()

const groupsWithCounts = computed(() => {
  const counts = new Map()
  playlistStore.channels.forEach((channel) => {
    const group = channel.group || '未分类'
    counts.set(group, (counts.get(group) || 0) + 1)
  })
  return playlistStore.groups.map((group) => ({
    name: group,
    count: counts.get(group) || 0
  }))
})

const totalCount = computed(() => playlistStore.channels.length)

function openGroup(group) {
  playlistStore.setActiveGroup(group)
  router.push({ path: '/channels', query: { group } })
}

function goHome() {
  router.push('/m3u')
}
</script>

<template>
  <div class="groups-page">
    <header class="page-head">
      <button class="icon-btn" type="button" title="返回 m3u 列表" @click="goHome">
        <ArrowLeft :size="18" />
      </button>
      <div>
        <h1>频道分组</h1>
        <p>选择分组进入对应频道列表</p>
      </div>
    </header>

    <div v-if="!playlistStore.playlist" class="page-state">
      <Play :size="38" />
      <h1>还没有播放列表</h1>
      <p>先加载一个 m3u / m3u8 播放列表，再回来选择频道。</p>
      <button class="btn btn-primary" type="button" @click="goHome">
        <Plus :size="16" /> 去加载播放列表
      </button>
    </div>

    <div v-else class="group-grid">
      <button class="group-tile" type="button" @click="openGroup('全部')">
        <span class="group-tile-icon"><Layers :size="20" /></span>
        <span class="group-tile-name">全部频道</span>
        <span class="group-tile-count">{{ totalCount }} 个频道</span>
      </button>
      <button
        v-for="group in groupsWithCounts"
        :key="group.name"
        class="group-tile"
        type="button"
        @click="openGroup(group.name)"
      >
        <span class="group-tile-icon"><LayoutGrid :size="20" /></span>
        <span class="group-tile-name">{{ group.name }}</span>
        <span class="group-tile-count">{{ group.count }} 个频道</span>
      </button>
    </div>
  </div>
</template>
