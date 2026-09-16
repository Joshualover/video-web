<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Clock, Layers, List, Play, Trash2, X } from 'lucide-vue-next'
import VodNav from '../components/VodNav.vue'
import { useVodStore } from '../stores/vod'
import { formatDuration, vodImage } from '../lib/vod'

const router = useRouter()
const vodStore = useVodStore()

const mode = ref('aggregated')

const list = computed(() =>
  mode.value === 'all' ? vodStore.recents : vodStore.historyAggregated
)

function resume(item) {
  router.push({
    path: `/vod/play/${item.site}/${encodeURIComponent(item.id)}`,
    query: { line: item.line || 0, index: item.index || 0, t: item.position || 0 }
  })
}

function remove(item) {
  if (mode.value === 'aggregated' && (item.variants || 1) > 1) {
    vodStore.removeRecentByTitle(item.name, item.year)
  } else if (mode.value === 'aggregated') {
    vodStore.removeRecentByTitle(item.name, item.year)
  } else {
    vodStore.removeRecent(item.site, item.id)
  }
}

function progressPercent(item) {
  if (!item.duration || !item.position) return 0
  return Math.min(100, Math.round((item.position / item.duration) * 100))
}

function formatTime(timestamp) {
  const date = new Date(timestamp)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
</script>

<template>
  <div class="vod-page">
    <VodNav />

    <div class="section-head">
      <h2><Clock :size="17" /> 播放历史</h2>
      <div class="vod-head-actions">
        <div class="vod-seg">
          <button
            class="vod-seg-btn"
            :class="{ active: mode === 'aggregated' }"
            type="button"
            @click="mode = 'aggregated'"
          >
            <Layers :size="13" /> 按片聚合
          </button>
          <button
            class="vod-seg-btn"
            :class="{ active: mode === 'all' }"
            type="button"
            @click="mode = 'all'"
          >
            <List :size="13" /> 全部记录
          </button>
        </div>
        <button
          v-if="vodStore.recents.length"
          class="btn btn-ghost btn-small"
          type="button"
          @click="vodStore.clearRecents()"
        >
          <Trash2 :size="14" /> 清空
        </button>
      </div>
    </div>

    <div v-if="list.length" class="vod-history-list">
      <article
        v-for="item in list"
        :key="mode === 'all' ? `${item.site}|${item.id}` : item.groupKey"
        class="vod-history-row"
        @click="resume(item)"
      >
        <div class="vod-history-thumb">
          <img v-if="item.pic" :src="vodImage(item.pic)" alt="" loading="lazy" />
          <span v-else>{{ (item.name || '?').slice(0, 2) }}</span>
        </div>
        <div class="vod-history-main">
          <strong>
            {{ item.name }}
            <span v-if="mode === 'aggregated' && item.variants > 1" class="vod-variant-badge">
              {{ item.variants }} 个来源
            </span>
          </strong>
          <span class="vod-history-sub">
            <span v-if="item.episodeName">{{ item.episodeName }}</span>
            <span v-if="item.duration">
              {{ formatDuration(item.position) }} / {{ formatDuration(item.duration) }}
            </span>
            <span>{{ formatTime(item.at) }}</span>
          </span>
          <div v-if="item.duration" class="vod-history-bar">
            <div class="vod-history-fill" :style="{ width: progressPercent(item) + '%' }"></div>
          </div>
        </div>
        <button class="btn btn-small btn-primary" type="button" @click.stop="resume(item)">
          <Play :size="13" /> {{ item.position > 10 ? '续播' : '播放' }}
        </button>
        <button
          class="icon-btn danger"
          type="button"
          :title="mode === 'aggregated' ? '删除该片全部记录' : '删除这条记录'"
          @click.stop="remove(item)"
        >
          <X :size="15" />
        </button>
      </article>
    </div>

    <div v-else class="empty-block"><Clock :size="22" /> 还没有播放记录</div>
  </div>
</template>
