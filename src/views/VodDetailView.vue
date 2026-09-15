<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  AlertTriangle,
  ArrowLeft,
  Calendar,
  Film,
  Heart,
  Loader2,
  Play,
  RefreshCw,
  Star,
  User,
  Zap
} from 'lucide-vue-next'
import { vodApi } from '../lib/vod'
import { useVodStore } from '../stores/vod'

const route = useRoute()
const router = useRouter()
const vodStore = useVodStore()

const loading = ref(true)
const error = ref('')
const detail = ref(null)
const siteName = ref('')
const activeLine = ref(0)
const bestLoading = ref(false)
const bestList = ref([])
const bestError = ref('')
const bestCacheAt = ref(0)

const isFav = computed(
  () =>
    detail.value &&
    vodStore.isFavorite(String(route.params.site), String(route.params.id))
)

const lines = computed(() => {
  const d = detail.value
  if (!d) return []
  const names = d.playFrom || []
  return (d.playUrl || []).map((episodes, index) => ({
    name: names[index] || `线路${index + 1}`,
    episodes
  }))
})

const episodes = computed(() => lines.value[activeLine.value]?.episodes || [])

function back() {
  if (window.history.length > 1) router.back()
  else router.push('/vod')
}

function play(lineIndex, epIndex) {
  router.push({
    path: `/vod/play/${route.params.site}/${encodeURIComponent(route.params.id)}`,
    query: { line: lineIndex, index: epIndex }
  })
}

function toggleFav() {
  if (!detail.value) return
  vodStore.toggleFavorite({
    site: String(route.params.site),
    id: String(route.params.id),
    name: detail.value.name,
    pic: detail.value.pic,
    year: detail.value.year,
    type: detail.value.type,
    remarks: detail.value.remarks
  })
}

async function findBest(force = false) {
  if (!detail.value) return
  const cached = !force && vodStore.getBest(detail.value.name, detail.value.year)
  if (cached) {
    bestList.value = cached.data.list || []
    bestCacheAt.value = cached.at
    bestError.value = bestList.value.length ? '' : '没有找到其他可用线路'
    return
  }
  bestLoading.value = true
  bestError.value = ''
  bestList.value = []
  try {
    const data = await vodApi.best(detail.value.name, { year: detail.value.year, limit: 10 })
    bestList.value = data.list || []
    bestCacheAt.value = Date.now()
    vodStore.setBest(detail.value.name, detail.value.year, data)
    if (!bestList.value.length) bestError.value = '没有找到其他可用线路'
  } catch (err) {
    bestError.value = err.message || '选路失败'
  } finally {
    bestLoading.value = false
  }
}

function switchToSource(item) {
  if (item.site === String(route.params.site) && item.id === String(route.params.id)) return
  router.push(`/vod/detail/${item.site}/${encodeURIComponent(item.id)}`)
}

async function load() {
  loading.value = true
  error.value = ''
  detail.value = null
  try {
    const data = await vodApi.detail(String(route.params.site), String(route.params.id))
    detail.value = data.detail
    siteName.value = data.siteName || ''
    activeLine.value = 0
    bestList.value = []
    bestError.value = ''
    bestCacheAt.value = 0
  } catch (err) {
    error.value = err.message || '加载影片详情失败'
  } finally {
    loading.value = false
  }
}

watch(() => `${route.params.site}|${route.params.id}`, load)
onMounted(load)
</script>

<template>
  <div class="vod-detail-page">
    <div class="player-header">
      <button class="icon-btn" type="button" title="返回" @click="back">
        <ArrowLeft :size="18" />
      </button>
      <div class="header-info">
        <h1>{{ detail?.name || '影片详情' }}</h1>
        <div v-if="detail" class="header-badges">
          <span v-if="siteName">{{ siteName }}</span>
          <span v-if="detail.type">{{ detail.type }}</span>
          <span v-if="detail.year">{{ detail.year }}</span>
          <span v-if="detail.area">{{ detail.area }}</span>
          <span v-if="detail.remarks">{{ detail.remarks }}</span>
        </div>
      </div>
    </div>

    <div v-if="loading" class="vod-state"><Loader2 class="spin" :size="24" /> 正在加载详情…</div>

    <div v-else-if="error" class="vod-state error">
      <AlertTriangle :size="22" /> {{ error }}
      <button class="btn btn-small btn-secondary" type="button" @click="load">
        <RefreshCw :size="14" /> 重试
      </button>
    </div>

    <template v-else-if="detail">
      <section class="vod-detail">
        <div class="vod-detail-poster">
          <img v-if="detail.pic" :src="detail.pic" alt="" referrerpolicy="no-referrer" />
          <span v-else class="vod-poster-fallback">{{ detail.name.slice(0, 2) }}</span>
        </div>
        <div class="vod-detail-info">
          <h2>{{ detail.name }}</h2>
          <div class="vod-detail-meta">
            <span v-if="detail.score"><Star :size="14" /> {{ detail.score }}</span>
            <span v-if="detail.year"><Calendar :size="14" /> {{ detail.year }}</span>
            <span v-if="detail.duration"><Film :size="14" /> {{ detail.duration }}</span>
            <span v-if="detail.actor"><User :size="14" /> {{ detail.actor }}</span>
          </div>
          <p v-if="detail.director" class="vod-detail-line">导演：{{ detail.director }}</p>
          <p class="vod-detail-content">{{ detail.content || '暂无简介' }}</p>
          <button
            v-if="episodes.length"
            class="btn btn-primary"
            type="button"
            @click="play(activeLine, 0)"
          >
            <Play :size="16" :fill="'currentColor'" /> 立即播放
          </button>
          <button
            class="btn btn-secondary"
            type="button"
            :disabled="bestLoading"
            @click="findBest"
          >
            <Loader2 v-if="bestLoading" class="spin" :size="15" />
            <Zap v-else :size="15" />
            多源选路
          </button>
          <button class="btn btn-ghost" type="button" @click="toggleFav">
            <Heart :size="15" :fill="isFav ? 'currentColor' : 'none'" />
            {{ isFav ? '已收藏' : '收藏' }}
          </button>
        </div>
      </section>

      <section v-if="bestLoading || bestList.length || bestError" class="vod-best">
        <div class="section-head">
          <h2><Zap :size="16" /> 多源选路（同片自动测速）</h2>
          <div class="vod-head-actions">
            <span v-if="bestLoading" class="count-note">正在搜索并测速…</span>
            <span v-else-if="bestCacheAt" class="count-note">
              缓存于 {{ new Date(bestCacheAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}
            </span>
            <span v-else class="count-note">按可用性与延迟排序</span>
            <button
              class="btn btn-ghost btn-small"
              type="button"
              :disabled="bestLoading"
              @click="findBest(true)"
            >
              <RefreshCw :size="13" /> 重新测速
            </button>
          </div>
        </div>
        <p v-if="bestError" class="load-error">{{ bestError }}</p>
        <div v-if="bestList.length" class="vod-best-list">
          <button
            v-for="item in bestList"
            :key="`${item.site}|${item.id}`"
            class="vod-best-row"
            :class="{
              current: item.site === String(route.params.site) && item.id === String(route.params.id)
            }"
            type="button"
            @click="switchToSource(item)"
          >
            <span class="vod-best-dot" :class="item.ok ? 'ok' : 'fail'"></span>
            <span class="vod-best-name">{{ item.siteName }}</span>
            <span class="vod-best-title">{{ item.name }}</span>
            <span class="vod-best-ep">{{ item.episodeName }}</span>
            <span class="vod-best-latency">{{ item.ok ? item.latency + ' ms' : '不可用' }}</span>
          </button>
        </div>
      </section>

      <section v-if="lines.length" class="vod-episodes">
        <div class="section-head">
          <h2>剧集 · 共 {{ episodes.length }} 集</h2>
        </div>
        <div v-if="lines.length > 1" class="vod-lines">
          <button
            v-for="(line, index) in lines"
            :key="index"
            class="vod-chip sm"
            :class="{ active: activeLine === index }"
            type="button"
            @click="activeLine = index"
          >
            {{ line.name }}
          </button>
        </div>
        <div class="vod-episode-grid">
          <button
            v-for="(ep, index) in episodes"
            :key="index"
            class="vod-episode"
            type="button"
            :title="ep.name"
            @click="play(activeLine, index)"
          >
            {{ ep.name }}
          </button>
        </div>
      </section>

      <div v-else class="empty-block"><Film :size="22" /> 该影片暂无可用播放地址</div>
    </template>

    <footer class="disclaimer">
      <strong>免责声明</strong>
      <span>影视数据来自第三方采集接口，本站不存储、不转码、不传播任何内容；播放可用性取决于对应源站。</span>
    </footer>
  </div>
</template>
