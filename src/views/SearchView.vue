<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ArrowLeft,
  CheckSquare,
  CheckCircle2,
  FilePlus2,
  GitMerge,
  ListVideo,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  XCircle
} from 'lucide-vue-next'
import { usePlaylistStore } from '../stores/playlist'
import { useUiStore } from '../stores/ui'

const router = useRouter()
const playlistStore = usePlaylistStore()
const uiStore = useUiStore()

const keyword = ref('')
const base = ref('https://678064.xyz')

// 阶段一：搜索结果
const searching = ref(false)
const results = ref([]) // {title, href}
const selected = ref(new Set())
const searchInfo = ref('')

// 阶段二：抓取
const mode = ref('merge') // 'merge' | 'new'
const mergeTarget = ref('')
const crawlRunning = ref(false)
const progress = ref({ done: 0, total: 0, current: '' })
const result = ref(null) // {mode, file, group, added/dup/count...}
const error = ref('')

let pollTimer = null
let activeTask = null

const serverFiles = computed(() => playlistStore.serverFiles)

const allSelected = computed(
  () => results.value.length > 0 && selected.value.size === results.value.length
)

function toggleAll() {
  if (allSelected.value) selected.value = new Set()
  else selected.value = new Set(results.value.map((r) => r.href))
}

function toggleOne(href) {
  const next = new Set(selected.value)
  if (next.has(href)) next.delete(href)
  else next.add(href)
  selected.value = next
}

async function startSearch() {
  error.value = ''
  result.value = null
  results.value = []
  selected.value = new Set()
  searching.value = true
  searchInfo.value = '正在搜索...'
  try {
    const resp = await fetch('/api/site-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wd: keyword.value.trim(), base: base.value, limit: 500 })
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      error.value = data.error || '无法开始搜索'
      searching.value = false
      return
    }
    activeTask = { id: data.taskId, type: 'search' }
    poll()
  } catch {
    error.value = '请求失败，请检查服务是否可用'
    searching.value = false
  }
}

async function startCrawl() {
  if (!selected.value.size) {
    uiStore.toast('请先勾选要抓取的结果', 'warning')
    return
  }
  if (mode.value === 'merge' && !mergeTarget.value) {
    uiStore.toast('请选择要并入的目标文件', 'warning')
    return
  }
  error.value = ''
  result.value = null
  crawlRunning.value = true
  progress.value = { done: 0, total: selected.value.size, current: '' }
  const items = results.value.filter((r) => selected.value.has(r.href))
  try {
    const resp = await fetch('/api/site-crawl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wd: keyword.value.trim(),
        base: base.value,
        group: keyword.value.trim(),
        mode: mode.value,
        target: mode.value === 'merge' ? mergeTarget.value : '',
        items
      })
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      error.value = data.error || '无法开始抓取'
      crawlRunning.value = false
      return
    }
    activeTask = { id: data.taskId, type: 'crawl' }
    poll()
  } catch {
    error.value = '请求失败，请检查服务是否可用'
    crawlRunning.value = false
  }
}

async function poll() {
  if (!activeTask) return
  try {
    const resp = await fetch(`/api/site-search/status?taskId=${activeTask.id}`)
    const data = await resp.json()
    if (data.state === 'running') {
      if (activeTask.type === 'search') {
        searchInfo.value = '正在搜索，请稍候...'
      } else {
        progress.value = { done: data.done || 0, total: data.total || 0, current: data.current || '' }
      }
      pollTimer = setTimeout(poll, 2500)
    } else if (data.state === 'done') {
      searching.value = false
      crawlRunning.value = false
      if (activeTask.type === 'search') {
        results.value = data.items || []
        selected.value = new Set((data.items || []).map((r) => r.href))
        searchInfo.value = ''
        if (!results.value.length) error.value = '没有搜索到结果'
      } else {
        result.value = data.result
        await playlistStore.fetchServerFiles()
        const msg = describeResult(data.result)
        uiStore.toast(msg, 'success')
      }
      activeTask = null
    } else {
      searching.value = false
      crawlRunning.value = false
      error.value = data.error || '任务失败'
      activeTask = null
    }
  } catch {
    searching.value = false
    crawlRunning.value = false
    error.value = '查询任务状态失败，请刷新页面重试'
    activeTask = null
  }
}

function describeResult(r) {
  if (!r) return '完成'
  if (r.mode === 'merge') {
    const groupNote = r.groupExisted ? `已有分组「${r.group}」` : `新建分组「${r.group}」`
    return `并入 ${r.file}（${groupNote}）：新增 ${r.added} 条，去重 ${r.dup} 条`
  }
  return `已生成 data/${r.file}，共 ${r.count} 条`
}

function loadFile() {
  if (mode.value === 'merge' && result.value?.file) {
    playlistStore.loadServerFile(result.value.file).then((ok) => {
      if (ok) router.push('/channels')
    })
  } else if (result.value?.file) {
    playlistStore.loadServerFile(result.value.file).then((ok) => {
      if (ok) router.push('/channels')
    })
  }
}

function resetAll() {
  results.value = []
  selected.value = new Set()
  result.value = null
  error.value = ''
  activeTask = null
}

onMounted(() => {
  playlistStore.fetchServerFiles()
})

onBeforeUnmount(() => {
  if (pollTimer) clearTimeout(pollTimer)
})
</script>

<template>
  <div class="home-view">
    <section class="load-panel">
      <div class="load-head">
        <div>
          <h1><Sparkles :size="19" /> 站内搜片</h1>
          <p>先在站点搜索并预览结果，勾选需要的视频后再抓取；抓取后可生成新文件或并入 data 中已有列表。</p>
        </div>
      </div>

      <div class="load-form">
        <div class="url-field">
          <Search :size="18" />
          <input
            v-model="keyword"
            type="text"
            placeholder="输入关键词，如：三上悠亚 / 小那海"
            aria-label="搜索关键词"
            :disabled="searching || crawlRunning"
            @keydown.enter="startSearch"
          />
        </div>
        <div class="search-options">
          <label class="opt-field">
            站点
            <select v-model="base" :disabled="searching || crawlRunning">
              <option value="https://678064.xyz">678064.xyz（当前）</option>
              <option value="https://678063.xyz">678063.xyz</option>
              <option value="https://678060.xyz">678060.xyz</option>
            </select>
          </label>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="searching || crawlRunning || !keyword.trim()"
            @click="startSearch"
          >
            <Loader2 v-if="searching" class="spin" :size="17" />
            <Search v-else :size="17" />
            {{ searching ? '搜索中...' : '搜索' }}
          </button>
        </div>
        <p v-if="searchInfo" class="load-progress">{{ searchInfo }}</p>
      </div>

      <!-- 搜索结果列表 -->
      <div v-if="results.length" class="search-results">
        <div class="results-head">
          <button class="btn btn-small btn-ghost" type="button" @click="toggleAll">
            <CheckSquare v-if="!allSelected" :size="14" />
            <CheckSquare v-else :size="14" />
            {{ allSelected ? '取消全选' : '全选' }}
          </button>
          <span class="results-count">共 {{ results.length }} 条 · 已选 {{ selected.size }} 条</span>
        </div>
        <div class="results-list">
          <label
            v-for="r in results"
            :key="r.href"
            class="result-row"
            :class="{ picked: selected.has(r.href) }"
          >
            <input
              type="checkbox"
              :checked="selected.has(r.href)"
              @change="toggleOne(r.href)"
            />
            <span class="result-title">{{ r.title }}</span>
          </label>
        </div>

        <!-- 抓取选项 -->
        <div class="crawl-options">
          <div class="opt-row">
            <label class="opt-field">
              处理方式
              <select v-model="mode" :disabled="crawlRunning">
                <option value="merge">并入已有文件</option>
                <option value="new">生成新文件</option>
              </select>
            </label>
            <label v-if="mode === 'merge'" class="opt-field">
              目标文件
              <select v-model="mergeTarget" :disabled="crawlRunning">
                <option v-for="f in serverFiles" :key="f.name" :value="f.name">{{ f.name }}</option>
              </select>
            </label>
            <span v-if="mode === 'new'" class="opt-hint">将生成 data/{{ keyword.trim() || '关键词' }}.m3u</span>
          </div>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="crawlRunning || !selected.size"
            @click="startCrawl"
          >
            <Loader2 v-if="crawlRunning" class="spin" :size="17" />
            <GitMerge v-else-if="mode === 'merge'" :size="17" />
            <FilePlus2 v-else :size="17" />
            {{ crawlRunning ? '抓取中...' : `抓取所选 ${selected.size} 条` }}
          </button>
          <button class="btn btn-ghost" type="button" :disabled="crawlRunning" @click="resetAll">
            <RefreshCw :size="15" /> 清空结果
          </button>
        </div>

        <!-- 抓取进度 -->
        <div v-if="crawlRunning" class="crawl-progress">
          <div class="progress-bar">
            <div
              class="progress-fill"
              :style="{ width: (progress.total ? (progress.done / progress.total) * 100 : 0) + '%' }"
            ></div>
          </div>
          <p class="progress-text">
            正在抓取第 {{ progress.done }} / {{ progress.total }} 条
            <span v-if="progress.current" class="progress-current">{{ progress.current }}</span>
          </p>
          <p class="progress-hint">每个视频约需 1-2 秒，页面可关闭，任务会在后台继续。</p>
        </div>
      </div>

      <!-- 结果 -->
      <div v-if="result" class="crawl-result success">
        <CheckCircle2 :size="20" />
        <div class="result-body">
          <strong>{{ describeResult(result) }}</strong>
          <span v-if="result.mode === 'merge'">
            {{ result.groupExisted ? '并入已有' : '新建' }}分组「{{ result.group }}」· 命名 {{ result.groupNext ? '至 ' + result.groupNext : '' }}号
          </span>
          <span v-else>已生成到 data/{{ result.file }}</span>
        </div>
        <div class="result-actions">
          <button class="btn btn-small btn-primary" type="button" @click="loadFile">
            <ListVideo :size="14" /> 加载列表
          </button>
        </div>
      </div>

      <!-- 错误 -->
      <div v-if="error" class="crawl-result error">
        <XCircle :size="20" />
        <div class="result-body">
          <strong>操作失败</strong>
          <span>{{ error }}</span>
        </div>
        <button class="btn btn-small btn-secondary" type="button" @click="error = ''">关闭</button>
      </div>
    </section>
  </div>
</template>
