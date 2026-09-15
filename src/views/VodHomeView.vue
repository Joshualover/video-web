<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Film,
  Loader2,
  RefreshCw,
  Search,
  Server,
  X
} from 'lucide-vue-next'
import { vodApi, groupCategories } from '../lib/vod'
import { useVodStore } from '../stores/vod'
import { useUiStore } from '../stores/ui'
import VodNav from '../components/VodNav.vue'

const route = useRoute()
const router = useRouter()
const vodStore = useVodStore()
const uiStore = useUiStore()

const keyword = ref('')
const searchMode = ref(false)
const searching = ref(false)
const searchResults = ref([])

const classes = ref([])
const selectedRoot = ref('')
const selectedType = ref('')
const list = ref([])
const page = ref(1)
const pageCount = ref(1)
const total = ref(0)
const listLoading = ref(false)
const listError = ref('')

const failed = reactive(new Set())

const sources = computed(() => vodStore.sources)
const activeSite = computed(() => vodStore.activeSiteId)

const grouped = computed(() => groupCategories(classes.value))
const roots = computed(() => grouped.value.roots)
const childTypes = computed(() => grouped.value.childrenOf.get(selectedRoot.value) || [])

function videoKey(v) {
  return `${v.site || activeSite.value}|${v.id}`
}

function markFailed(v) {
  failed.add(videoKey(v))
}

function openDetail(v) {
  const site = v.site || activeSite.value
  router.push(`/vod/detail/${site}/${encodeURIComponent(v.id)}`)
}

function openRecent(r) {
  router.push({
    path: `/vod/play/${r.site}/${encodeURIComponent(r.id)}`,
    query: { line: r.line || 0, index: r.index || 0 }
  })
}

async function loadCategories() {
  listError.value = ''
  classes.value = []
  selectedRoot.value = ''
  selectedType.value = ''
  if (!activeSite.value) return
  try {
    const data = await vodApi.categories(activeSite.value)
    classes.value = data.classes || []
    await loadList(1)
  } catch (err) {
    listError.value = err.message || '加载分类失败'
  }
}

async function loadList(targetPage = 1) {
  if (!activeSite.value) return
  listLoading.value = true
  listError.value = ''
  const filtered = Boolean(selectedType.value)
  try {
    const data = await vodApi.list(activeSite.value, selectedType.value, targetPage)
    list.value = data.list || []
    page.value = data.page || targetPage
    pageCount.value = data.pageCount || 1
    total.value = data.total || list.value.length
    failed.clear()
    // 部分源是扁平分类，父分类（如「电影」）本身无内容，自动回退到最近更新
    if (filtered && targetPage === 1 && !list.value.length) {
      uiStore.toast('该分类暂无内容，已切换为最近更新', 'warning')
      selectedRoot.value = ''
      selectedType.value = ''
      await loadList(1)
    }
  } catch (err) {
    list.value = []
    listError.value = err.message || '加载影片列表失败'
  } finally {
    listLoading.value = false
  }
}

function selectRoot(root) {
  selectedRoot.value = root.id
  selectedType.value = root.id
  loadList(1)
}

function selectLatest() {
  selectedRoot.value = ''
  selectedType.value = ''
  loadList(1)
}

function selectType(type) {
  selectedType.value = type.id
  loadList(1)
}

async function doSearch() {
  const wd = keyword.value.trim()
  if (!wd) return
  searchMode.value = true
  searching.value = true
  listError.value = ''
  searchResults.value = []
  failed.clear()
  try {
    const data = await vodApi.search(wd, { limit: 60 })
    searchResults.value = data.list || []
    if (!searchResults.value.length) listError.value = '没有搜索到结果，换个关键词试试'
  } catch (err) {
    listError.value = err.message || '搜索失败'
  } finally {
    searching.value = false
  }
}

function exitSearch() {
  searchMode.value = false
  searchResults.value = []
  listError.value = ''
  if (!list.value.length && activeSite.value) loadList(1)
}

async function changeSite(event) {
  vodStore.setActiveSite(event.target.value)
}

const bootstrapping = ref(true)

watch(
  () => vodStore.activeSiteId,
  () => {
    if (bootstrapping.value) return
    exitSearch()
    loadCategories()
  }
)

onMounted(async () => {
  try {
    await vodStore.fetchSources()
  } catch {
    // 错误已存入 store
  }
  await loadCategories()
  bootstrapping.value = false

  // 后台健康检查：若当前源不可用，自动切到可用源
  vodStore
    .fetchSources({ check: true })
    .then(() => {
      const current = vodStore.sources.find((s) => s.id === vodStore.activeSiteId)
      if (current && current.status === 'fail') {
        const healthy = vodStore.sources.find((s) => s.status === 'ok')
        if (healthy && healthy.id !== current.id) {
          uiStore.toast(`当前源不可用，已切换到「${healthy.name}」`, 'warning')
          vodStore.setActiveSite(healthy.id)
        }
      }
    })
    .catch(() => {})

  if (route.query.wd) {
    keyword.value = String(route.query.wd)
    doSearch()
  }
})
</script>

<template>
  <div class="vod-page">
    <VodNav />

    <section class="vod-hero">
      <div class="vod-hero-text">
        <h1><Film :size="19" /> 影视聚合</h1>
        <p>数据源来自 awesome-zhuiju-free 收录的 TVBox / 影视仓配置，聚合多个苹果 CMS 采集接口。</p>
      </div>
      <form class="vod-search" @submit.prevent="doSearch">
        <Search :size="17" />
        <input
          v-model="keyword"
          type="text"
          placeholder="搜索电影、剧集、动漫、综艺…"
          aria-label="搜索影视"
        />
        <button v-if="keyword" class="icon-btn" type="button" title="清空" @click="keyword = ''">
          <X :size="15" />
        </button>
        <button class="btn btn-primary" type="submit" :disabled="searching || !keyword.trim()">
          <Loader2 v-if="searching" class="spin" :size="16" />
          <Search v-else :size="16" />
          搜索
        </button>
      </form>
    </section>

    <section class="vod-toolbar">
      <label class="vod-site">
        <Server :size="15" />
        <span>数据源</span>
        <select :value="activeSite" :disabled="!sources.length" @change="changeSite">
          <option v-if="!sources.length" value="">加载中...</option>
          <optgroup v-for="g in vodStore.sourceGroups" :key="g.group" :label="g.group">
            <option v-for="s in g.sources" :key="s.id" :value="s.id">
              {{ s.name }}{{ s.status === 'ok' ? ' ✓' : s.status === 'fail' ? ' ✕' : '' }}
            </option>
          </optgroup>
        </select>
      </label>
      <span class="vod-health">
        <span v-if="vodStore.sourcesLoading">正在加载数据源…</span>
        <span v-else-if="!vodStore.healthChecked">可用 {{ vodStore.healthySources.length }} / {{ sources.length }}（检测中）</span>
        <span v-else>可用 {{ vodStore.healthySources.length }} / {{ sources.length }} 个源</span>
      </span>
      <button
        class="btn btn-ghost btn-small"
        type="button"
        :disabled="vodStore.sourcesLoading"
        @click="vodStore.fetchSources({ check: true })"
      >
        <RefreshCw :size="14" /> 检测源
      </button>
    </section>

    <p v-if="vodStore.sourcesError" class="load-error">{{ vodStore.sourcesError }}</p>

    <!-- 搜索结果 -->
    <template v-if="searchMode">
      <div class="section-head">
        <h2>搜索结果「{{ keyword }}」</h2>
        <button class="text-link" type="button" @click="exitSearch">返回浏览 <X :size="14" /></button>
      </div>
      <div v-if="searching" class="vod-state"><Loader2 class="spin" :size="22" /> 正在聚合搜索多个源…</div>
      <div v-else-if="searchResults.length" class="vod-grid">
        <article
          v-for="v in searchResults"
          :key="videoKey(v)"
          class="vod-card"
          @click="openDetail(v)"
        >
          <div class="vod-poster">
            <img
              v-if="v.pic && !failed.has(videoKey(v))"
              :src="v.pic"
              alt=""
              loading="lazy"
              referrerpolicy="no-referrer"
              @error="markFailed(v)"
            />
            <span v-else class="vod-poster-fallback">{{ (v.name || '?').slice(0, 2) }}</span>
            <span v-if="v.remarks" class="vod-remark">{{ v.remarks }}</span>
          </div>
          <div class="vod-card-body">
            <strong class="vod-card-name">{{ v.name }}</strong>
            <span class="vod-card-meta">
              <span>{{ v.year || '—' }}</span>
              <span v-if="v.type">· {{ v.type }}</span>
              <span class="vod-site-badge">{{ v.siteName }}</span>
            </span>
          </div>
        </article>
      </div>
      <div v-else-if="listError" class="vod-state error"><AlertTriangle :size="20" /> {{ listError }}</div>
    </template>

    <!-- 分类浏览 -->
    <template v-else>
      <div v-if="roots.length" class="vod-cats">
        <div class="vod-cat-row">
          <button
            class="vod-chip"
            :class="{ active: selectedType === '' }"
            type="button"
            @click="selectLatest"
          >
            最近更新
          </button>
          <button
            v-for="r in roots"
            :key="r.id"
            class="vod-chip"
            :class="{ active: selectedRoot === r.id }"
            type="button"
            @click="selectRoot(r)"
          >
            {{ r.name }}
          </button>
        </div>
        <div v-if="childTypes.length" class="vod-cat-row sub">
          <button
            class="vod-chip sm"
            :class="{ active: selectedType === selectedRoot }"
            type="button"
            @click="selectType({ id: selectedRoot })"
          >
            全部
          </button>
          <button
            v-for="c in childTypes"
            :key="c.id"
            class="vod-chip sm"
            :class="{ active: selectedType === c.id }"
            type="button"
            @click="selectType(c)"
          >
            {{ c.name }}
          </button>
        </div>
      </div>

      <div v-if="listLoading" class="vod-state"><Loader2 class="spin" :size="22" /> 正在加载影片…</div>
      <div v-else-if="listError" class="vod-state error">
        <AlertTriangle :size="20" /> {{ listError }}
        <button class="btn btn-small btn-secondary" type="button" @click="loadList(page)">
          <RefreshCw :size="14" /> 重试
        </button>
      </div>
      <template v-else>
        <div v-if="list.length" class="vod-grid">
          <article
            v-for="v in list"
            :key="videoKey(v)"
            class="vod-card"
            @click="openDetail(v)"
          >
            <div class="vod-poster">
              <img
                v-if="v.pic && !failed.has(videoKey(v))"
                :src="v.pic"
                alt=""
                loading="lazy"
                referrerpolicy="no-referrer"
                @error="markFailed(v)"
              />
              <span v-else class="vod-poster-fallback">{{ (v.name || '?').slice(0, 2) }}</span>
              <span v-if="v.remarks" class="vod-remark">{{ v.remarks }}</span>
            </div>
            <div class="vod-card-body">
              <strong class="vod-card-name">{{ v.name }}</strong>
              <span class="vod-card-meta">
                <span>{{ v.year || '—' }}</span>
                <span v-if="v.type">· {{ v.type }}</span>
              </span>
            </div>
          </article>
        </div>
        <div v-else class="empty-block"><Film :size="22" /> 该分类暂无影片</div>

        <div v-if="list.length" class="vod-pager">
          <button
            class="btn btn-secondary btn-small"
            type="button"
            :disabled="page <= 1 || listLoading"
            @click="loadList(page - 1)"
          >
            <ChevronLeft :size="15" /> 上一页
          </button>
          <span class="vod-page-info">第 {{ page }} / {{ pageCount }} 页 · 共 {{ total }} 部</span>
          <button
            class="btn btn-secondary btn-small"
            type="button"
            :disabled="page >= pageCount || listLoading"
            @click="loadList(page + 1)"
          >
            下一页 <ChevronRight :size="15" />
          </button>
        </div>
      </template>
    </template>

    <section v-if="vodStore.recents.length" class="vod-recents">
      <div class="section-head spaced">
        <h2>最近观看</h2>
        <button class="text-link" type="button" @click="vodStore.clearRecents()">清空</button>
      </div>
      <div class="vod-grid">
        <article
          v-for="r in vodStore.recents.slice(0, 12)"
          :key="`${r.site}|${r.id}`"
          class="vod-card"
          @click="openRecent(r)"
        >
          <div class="vod-poster">
            <img v-if="r.pic" :src="r.pic" alt="" loading="lazy" referrerpolicy="no-referrer" />
            <span v-else class="vod-poster-fallback">{{ (r.name || '?').slice(0, 2) }}</span>
            <span v-if="r.episodeName" class="vod-remark">{{ r.episodeName }}</span>
          </div>
          <div class="vod-card-body">
            <strong class="vod-card-name">{{ r.name }}</strong>
          </div>
        </article>
      </div>
    </section>

    <footer class="disclaimer">
      <strong>免责声明</strong>
      <span>影视数据来自第三方采集接口，本站不存储、不转码、不传播任何内容；可用性取决于对应源站。</span>
    </footer>
  </div>
</template>
