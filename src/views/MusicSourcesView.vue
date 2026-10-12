<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import {
  CheckCircle2,
  Loader2,
  Music,
  Play,
  Plus,
  RefreshCw,
  Server,
  Trash2
} from 'lucide-vue-next'
import MusicNav from '../components/MusicNav.vue'
import MusicPlayer from '../components/MusicPlayer.vue'
import { useMusicStore } from '../stores/music'
import { useUiStore } from '../stores/ui'

const musicStore = useMusicStore()
const uiStore = useUiStore()

const KIND_LABELS = {
  piped: 'Piped',
  invidious: 'Invidious',
  jiosaavn: 'JioSaavn',
  itunes: 'Apple 试听',
  ytdlp: 'yt-dlp'
}

const form = reactive({ kind: 'piped', api: '', name: '' })
const adding = ref(false)
const error = ref('')
const testingId = ref('')
const togglingId = ref('')
const removingId = ref('')

const groups = computed(() => {
  const map = new Map()
  for (const source of musicStore.sources) {
    const key = source.from || '内置'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(source)
  }
  // 内置在前，自定义在后
  return [...map.entries()]
    .map(([group, sources]) => ({ group, sources }))
    .sort((a, b) => (a.group === '内置' ? -1 : b.group === '内置' ? 1 : 0))
})

const proxyText = computed(() => {
  const proxy = musicStore.sourcesMeta?.proxy
  if (!proxy?.enabled) {
    return '出网代理：未启用（YouTube 系音源需要服务端设置 VOD_HTTP_PROXY 才能访问）'
  }
  const noProxy = proxy.noProxy?.length ? ` · 直连 ${proxy.noProxy.join(' / ')}` : ''
  return `出网代理：${proxy.url}${noProxy}`
})

function kindLabel(kind) {
  return KIND_LABELS[kind] || kind || '未知'
}

function statusClass(item) {
  return item.status === 'ok' ? 'ok' : item.status === 'fail' ? 'fail' : 'unknown'
}

async function addSource() {
  error.value = ''
  const api = form.api.trim()
  if (!api) {
    error.value = '请填写实例地址'
    return
  }
  if (!/^https?:\/\//i.test(api)) {
    error.value = '实例地址需要以 http:// 或 https:// 开头'
    return
  }
  adding.value = true
  try {
    await musicStore.addSource({ kind: form.kind, api, name: form.name.trim() || undefined })
    form.api = ''
    form.name = ''
    uiStore.toast('已添加音源，可点「测试」确认是否可用', 'success')
  } catch (err) {
    error.value = err.message
  } finally {
    adding.value = false
  }
}

async function testSource(item) {
  testingId.value = item.id
  error.value = ''
  try {
    const result = await musicStore.checkSource(item.id)
    if (result.status === 'ok') uiStore.toast(`「${item.name}」可用，延迟 ${result.latency} ms`, 'success')
    else uiStore.toast(`「${item.name}」不可用：${result.error || '未知错误'}`, 'warning')
  } catch (err) {
    error.value = err.message
  } finally {
    testingId.value = ''
  }
}

async function toggleSource(item) {
  togglingId.value = item.id
  error.value = ''
  const next = item.enabled === false
  try {
    await musicStore.setSourceEnabled(item.id, next)
    uiStore.toast(next ? `已启用「${item.name}」` : `已停用「${item.name}」，不再参与搜索`, 'success')
  } catch (err) {
    error.value = err.message
  } finally {
    togglingId.value = ''
  }
}

async function removeSource(item) {
  if (!window.confirm(`确定删除音源「${item.name}」？`)) return
  removingId.value = item.id
  error.value = ''
  try {
    await musicStore.removeSource(item.id)
    uiStore.toast('已删除', 'success')
  } catch (err) {
    error.value = err.message
  } finally {
    removingId.value = ''
  }
}

async function refresh() {
  error.value = ''
  try {
    await musicStore.fetchSources()
  } catch (err) {
    error.value = err.message
  }
}

onMounted(() => {
  musicStore.fetchSources().catch(() => {})
})
</script>

<template>
  <div class="music-page">
    <MusicNav />

    <section class="music-panel">
      <div class="section-head">
        <h2><Plus :size="17" /> 添加自定义音源</h2>
      </div>
      <p class="music-panel-tip">
        支持 Piped 与 Invidious 实例（都是 YouTube 的开放前端），实例地址填到 API 根路径即可，例如
        <code>https://pipedapi.kavin.rocks</code>。
      </p>
      <form class="music-source-form" @submit.prevent="addSource">
        <select v-model="form.kind" aria-label="音源类型">
          <option value="piped">Piped</option>
          <option value="invidious">Invidious</option>
        </select>
        <input
          v-model="form.api"
          type="text"
          placeholder="实例地址，如 https://pipedapi.kavin.rocks"
          aria-label="实例地址"
        />
        <input v-model="form.name" type="text" placeholder="名称（可选）" aria-label="音源名称" />
        <button class="btn btn-primary" type="submit" :disabled="adding">
          <Loader2 v-if="adding" class="spin" :size="16" />
          <Plus v-else :size="16" />
          添加
        </button>
      </form>
      <p v-if="error" class="load-error">{{ error }}</p>
    </section>

    <div class="section-head">
      <h2><Server :size="17" /> 音源列表</h2>
      <div class="music-head-actions">
        <span class="count-note">
          启用 {{ musicStore.enabledSources.length }} / {{ musicStore.sources.length }}
          <template v-if="musicStore.disabledSourceCount">
            · 已停用 {{ musicStore.disabledSourceCount }}
          </template>
        </span>
        <button class="btn btn-secondary btn-small" type="button" :disabled="musicStore.sourcesLoading" @click="refresh">
          <Loader2 v-if="musicStore.sourcesLoading" class="spin" :size="14" />
          <RefreshCw v-else :size="14" />
          刷新
        </button>
      </div>
    </div>
    <p class="music-panel-tip">
      YouTube 系音源（Piped / Invidious）在中国大陆需要给服务端配 <code>VOD_HTTP_PROXY</code> 才能访问；
      JioSaavn 与 Apple 试听源可直连。{{ proxyText }}
    </p>

    <div v-if="musicStore.sourcesLoading && !musicStore.sources.length" class="music-state">
      <Loader2 class="spin" :size="22" /> 正在加载音源…
    </div>

    <div v-else-if="!musicStore.sources.length" class="empty-block">
      <Music :size="22" /> 暂无音源，检查服务端是否已实现 /api/music/sources
    </div>

    <div v-else class="music-source-groups">
      <section v-for="groupItem in groups" :key="groupItem.group" class="music-source-group">
        <div class="music-group-head">
          <span>{{ groupItem.group }}</span>
          <span class="count-note">
            {{ groupItem.sources.filter((s) => s.enabled !== false).length }} / {{ groupItem.sources.length }} 启用
          </span>
        </div>
        <div class="music-source-list">
          <article
            v-for="item in groupItem.sources"
            :key="item.id"
            class="music-source-row"
            :class="{ disabled: item.enabled === false }"
          >
            <span class="music-dot" :class="statusClass(item)"></span>

            <div class="music-source-main">
              <span class="music-source-name">
                {{ item.name }}
                <span class="music-badge">{{ kindLabel(item.kind) }}</span>
                <span v-if="item.group" class="music-badge group">{{ item.group }}</span>
              </span>
              <span class="music-source-api" :title="item.api">{{ item.api }}</span>
            </div>

            <span class="music-source-meta">
              <template v-if="item.status === 'ok'">
                <CheckCircle2 :size="12" /> {{ item.latency }} ms
              </template>
              <template v-else-if="item.status === 'fail'">不可用：{{ item.error || '未知' }}</template>
              <template v-else>未检测</template>
            </span>

            <button
              class="icon-btn"
              type="button"
              :title="'测试「' + item.name + '」'"
              :disabled="testingId === item.id"
              @click="testSource(item)"
            >
              <Loader2 v-if="testingId === item.id" class="spin" :size="15" />
              <Play v-else :size="15" />
            </button>

            <button
              class="btn btn-small"
              :class="item.enabled === false ? 'btn-primary' : 'btn-ghost'"
              type="button"
              :disabled="togglingId === item.id"
              @click="toggleSource(item)"
            >
              <Loader2 v-if="togglingId === item.id" class="spin" :size="13" />
              {{ item.enabled === false ? '启用' : '停用' }}
            </button>

            <button
              v-if="!item.builtin"
              class="icon-btn danger"
              type="button"
              title="删除"
              :disabled="removingId === item.id"
              @click="removeSource(item)"
            >
              <Loader2 v-if="removingId === item.id" class="spin" :size="15" />
              <Trash2 v-else :size="15" />
            </button>
          </article>
        </div>
      </section>
    </div>

    <footer class="disclaimer">
      <strong>说明</strong>
      <span>
        音源均为第三方公开服务，可用性与内容由其决定；Piped / Invidious 公共实例经常限流或失效，建议自建实例或配置出网代理。
      </span>
    </footer>

    <!-- 播放条跨音乐页面常驻，来回音源管理时不断播 -->
    <MusicPlayer />
  </div>
</template>
