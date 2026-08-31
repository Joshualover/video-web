<script setup>
import { computed, ref } from 'vue'
import { Layers, Search } from 'lucide-vue-next'
import { usePlaylistStore } from '../stores/playlist'

const playlistStore = usePlaylistStore()
const groupQuery = ref('')

const groupsWithCounts = computed(() => {
  const counts = new Map()
  playlistStore.channels.forEach((channel) => {
    const group = channel.group || '未分类'
    counts.set(group, (counts.get(group) || 0) + 1)
  })
  return playlistStore.groups
    .filter((group) => group.toLowerCase().includes(groupQuery.value.trim().toLowerCase()))
    .map((group) => ({ name: group, count: counts.get(group) || 0 }))
})

const totalCount = computed(() => playlistStore.channels.length)
</script>

<template>
  <div class="group-sidebar">
    <div class="group-search">
      <Search :size="15" />
      <input
        v-model="groupQuery"
        type="text"
        placeholder="搜索分组"
        aria-label="搜索分组"
      />
    </div>
    <div class="group-list">
      <button
        class="group-item"
        :class="{ active: playlistStore.activeGroup === '全部' }"
        type="button"
        @click="playlistStore.setActiveGroup('全部')"
      >
        <span class="group-name"><Layers :size="15" /> 全部频道</span>
        <span class="group-count">{{ totalCount }}</span>
      </button>
      <button
        v-for="group in groupsWithCounts"
        :key="group.name"
        class="group-item"
        :class="{ active: playlistStore.activeGroup === group.name }"
        type="button"
        @click="playlistStore.setActiveGroup(group.name)"
      >
        <span class="group-name">{{ group.name }}</span>
        <span class="group-count">{{ group.count }}</span>
      </button>
      <div v-if="!groupsWithCounts.length" class="group-empty">没有匹配的分组</div>
    </div>
  </div>
</template>
