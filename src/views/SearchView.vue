<script setup>
import { onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ArrowLeft,
  CheckCircle2,
  ListVideo,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  XCircle
} from 'lucide-vue-next'
import { usePlaylistStore } from '../stores/playlist'
import { useUiStore } from '../stores/ui'

const router = useRouter()
const playlistStore = usePlaylistStore()
const uiStore = useUiStore()

const keyword = ref('')
const base = ref('https://678063.xyz')
const limit = ref(100)

const running = ref(false)
const polling = ref(false)
const progress = ref({ done: 0, total: 0, current: '' })
const result = ref(null) // { file, count }
const error = ref('')
let taskId = null
let pollTimer = null

function canStart() {
  return !running.value && keyword.value.trim().length > 0
}

async function startSearch() {
  error.value = ''
  result.value = null
  running.value = true
  progress.value = { done: 0, total: 0, current: '' }
  try {
    const resp = await fetch('/api/site-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wd: keyword.value.trim(), base: base.value, limit: Number(limit.value) })
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      error.value = data.error || '无法开始任务'
      running.value = false
      return
    }
    taskId = data.taskId
    poll()
  } catch {
    error.value = '请求失败，请检查服务是否可用'
    running.value = false
  }
}

async function poll() {
  if (!taskId) return
  polling.value = true
  try {
    const resp = await fetch(`/api/site-search/status?taskId=${taskId}`)
    const data = await resp.json()
    if (data.state === 'running') {
      progress.value = { done: data.done || 0, total: data.total || 0, current: data.current || '' }
      pollTimer = setTimeout(poll, 2500)
    } else if (data.state === 'done') {
      running.value = false
      polling.value = false
      result.value = { file: data.file, count: data.count }
      await playlistStore.fetchServerFiles()
      uiStore.toast(`抓取完成：${data.count} 条 → data/${data.file}`, 'success')
    } else {
      running.value = false
      polling.value = false
      error.value = data.error || '抓取失败'
    }
  } catch {
    running.value = false
    polling.value = false
    error.value = '查询任务状态失败，请刷新页面重试'
  }
}

async function loadResult() {
  if (!result.value) return
  const ok = await playlistStore.loadServerFile(result.value.file)
  if (ok) router.push('/channels')
  else uiStore.toast(playlistStore.loadError || '加载失败', 'error')
}

onBeforeUnmount(() => {
  if (pollTimer) clearTimeout(pollTimer)
})
</script>

<template>
  <div class="home-view">
    <section class="load-panel">
      <div class="load-head">
        <div>
          <h1><Sparkles :size="19" /> 站内搜索抓片</h1>
          <p>输入关键词，自动从站点搜索并抓取 m3u8 链接，生成 m3u 文件到服务器 data 目录。</p>
        </div>
      </div>

      <div class="load-form">
        <div class="url-field">
          <Search :size="18" />
          <input
            v-model="keyword"
            type="text"
            placeholder="输入关键词，如：三上悠亚 / IPZZ"
            aria-label="搜索关键词"
            @keydown.enter="startSearch"
          />
        </div>
        <div class="search-options">
          <label class="opt-field">
            站点
            <select v-model="base">
              <option value="https://678063.xyz">678063.xyz</option>
              <option value="https://678060.xyz">678060.xyz</option>
            </select>
          </label>
          <label class="opt-field">
            数量上限
            <select v-model="limit">
              <option :value="50">50</option>
              <option :value="100">100</option>
              <option :value="200">200</option>
              <option :value="500">全部（最多 500）</option>
            </select>
          </label>
        </div>
        <div class="load-actions">
          <button
            class="btn btn-primary"
            type="button"
            :disabled="!canStart()"
            @click="startSearch"
          >
            <Loader2 v-if="running" class="spin" :size="17" />
            <Search v-else :size="17" />
            {{ running ? '抓取中...' : '开始抓取' }}
          </button>
          <button
            class="btn btn-secondary"
            type="button"
            :disabled="!running"
            @click="loadResult"
          >
            刷新状态
          </button>
        </div>
      </div>

      <!-- 进度 -->
      <div v-if="running" class="crawl-progress">
        <div class="progress-bar">
          <div
            class="progress-fill"
            :style="{ width: (progress.total ? (progress.done / progress.total) * 100 : 0) + '%' }"
          ></div>
        </div>
        <p class="progress-text">
          正在抓取第 {{ progress.done }} / {{ progress.total || '?' }} 条
          <span v-if="progress.current" class="progress-current">{{ progress.current }}</span>
        </p>
        <p class="progress-hint">每个视频约需 1-2 秒，数量较多时请耐心等待（页面可关闭，任务会在后台继续）。</p>
      </div>

      <!-- 结果 -->
      <div v-if="result" class="crawl-result success">
        <CheckCircle2 :size="20" />
        <div class="result-body">
          <strong>抓取完成：{{ result.count }} 条</strong>
          <span>已生成到服务器 data/{{ result.file }}</span>
        </div>
        <div class="result-actions">
          <button class="btn btn-small btn-primary" type="button" @click="loadResult">
            <ListVideo :size="14" /> 加载此列表
          </button>
          <button class="btn btn-small btn-secondary" type="button" @click="startSearch">
            <RefreshCw :size="14" /> 重新抓取
          </button>
        </div>
      </div>

      <!-- 错误 -->
      <div v-if="error" class="crawl-result error">
        <XCircle :size="20" />
        <div class="result-body">
          <strong>抓取失败</strong>
          <span>{{ error }}</span>
        </div>
        <button class="btn btn-small btn-secondary" type="button" @click="error = ''">
          关闭
        </button>
      </div>

      <p class="crawl-note">
        <Play :size="13" :fill="'currentColor'" />
        提示：生成后可在「服务器目录」找到该文件；如需并入 v100 大列表，请手动操作或告诉我处理。
      </p>
    </section>
  </div>
</template>
