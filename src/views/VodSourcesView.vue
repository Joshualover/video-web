<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import {
  AlertTriangle,
  CheckCircle2,
  FolderCog,
  Loader2,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-vue-next'
import VodNav from '../components/VodNav.vue'
import { useVodStore } from '../stores/vod'
import { useUiStore } from '../stores/ui'

const vodStore = useVodStore()
const uiStore = useUiStore()

const form = reactive({ name: '', url: '', group: '' })
const adding = ref(false)
const refreshingAll = ref(false)
const refreshingId = ref('')
const editingId = ref('')
const editForm = reactive({ name: '', group: '' })
const error = ref('')
const testingId = ref('')
const togglingId = ref('')

// 源级列表：按分组展示，可逐个启停/测速
const sourceGroups = computed(() => {
  const map = new Map()
  for (const s of vodStore.sources) {
    const key = s.group || '默认配置'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(s)
  }
  return [...map.entries()].map(([group, sources]) => ({ group, sources }))
})

const proxyText = computed(() => {
  const proxy = vodStore.sourcesMeta?.proxy
  if (!proxy?.enabled) return '出网代理：未启用（设置 VOD_HTTP_PROXY 可代理抓取与播放）'
  return `出网代理：${proxy.url}${proxy.noProxy?.length ? ' · 直连 ' + proxy.noProxy.join(' / ') : ''}`
})

async function toggleSource(item) {
  togglingId.value = item.id
  error.value = ''
  try {
    const next = item.enabled === false
    await vodStore.setSourceEnabled(item.id, next)
    uiStore.toast(next ? `已启用「${item.name}」` : `已停用「${item.name}」，不再参与搜索与选路`, 'success')
  } catch (err) {
    error.value = err.message
  } finally {
    togglingId.value = ''
  }
}

async function testSource(item) {
  testingId.value = item.id
  error.value = ''
  try {
    const result = await vodStore.checkSource(item.id)
    if (result.status === 'ok') uiStore.toast(`「${item.name}」可用，延迟 ${result.latency} ms`, 'success')
    else uiStore.toast(`「${item.name}」不可用：${result.error || '未知错误'}`, 'warning')
  } catch (err) {
    error.value = err.message
  } finally {
    testingId.value = ''
  }
}

const groups = computed(() => {
  const map = new Map()
  for (const c of vodStore.configs) {
    const key = c.group || '默认配置'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(c)
  }
  return [...map.entries()].map(([group, configs]) => ({ group, configs }))
})

const groupOptions = computed(() => groups.value.map((g) => g.group))

const metaText = computed(() => {
  const meta = vodStore.sourcesMeta || {}
  if (!meta.autoRefreshHours) return '自动刷新已关闭（VOD_AUTO_REFRESH_HOURS=0）'
  const last = meta.lastRefreshAt
    ? new Date(meta.lastRefreshAt).toLocaleString('zh-CN', { hour12: false })
    : '尚未执行'
  return `自动刷新：每 ${meta.autoRefreshHours} 小时 · 上次 ${last}`
})

async function addConfig() {
  error.value = ''
  if (!form.url.trim()) {
    error.value = '请填写配置地址'
    return
  }
  adding.value = true
  try {
    await vodStore.addConfig({
      name: form.name.trim() || form.url.trim(),
      url: form.url.trim(),
      group: form.group.trim() || '默认配置'
    })
    form.name = ''
    form.url = ''
    uiStore.toast('已添加配置，点击「刷新」抓取源', 'success')
  } catch (err) {
    error.value = err.message
  } finally {
    adding.value = false
  }
}

async function refreshOne(id) {
  refreshingId.value = id
  error.value = ''
  try {
    await vodStore.refreshConfigs(id)
    uiStore.toast('配置已刷新', 'success')
  } catch (err) {
    error.value = err.message
  } finally {
    refreshingId.value = ''
  }
}

async function refreshAll() {
  refreshingAll.value = true
  error.value = ''
  try {
    await vodStore.refreshConfigs()
    uiStore.toast('全部配置已刷新', 'success')
  } catch (err) {
    error.value = err.message
  } finally {
    refreshingAll.value = false
  }
}

async function toggleEnabled(item) {
  try {
    await vodStore.updateConfig(item.id, { enabled: !item.enabled })
  } catch (err) {
    error.value = err.message
  }
}

function startEdit(item) {
  editingId.value = item.id
  editForm.name = item.name
  editForm.group = item.group
}

async function saveEdit(item) {
  try {
    await vodStore.updateConfig(item.id, { name: editForm.name, group: editForm.group })
    editingId.value = ''
  } catch (err) {
    error.value = err.message
  }
}

async function remove(item) {
  if (!window.confirm(`确定删除配置「${item.name}」？`)) return
  try {
    await vodStore.removeConfig(item.id)
    uiStore.toast('已删除', 'success')
  } catch (err) {
    error.value = err.message
  }
}

onMounted(() => {
  vodStore.fetchConfigs().catch(() => {})
  vodStore.fetchSources().catch(() => {})
})
</script>

<template>
  <div class="vod-page">
    <VodNav />

    <section class="vod-panel">
      <div class="section-head">
        <h2><Plus :size="17" /> 添加 TVBox / 影视仓 配置地址</h2>
      </div>
      <p class="vod-panel-tip">
        配置里的 <code>type=1</code> 苹果 CMS 接口会被解析为可用影视源；<code>csp_</code> 蜘蛛源（type=3）依赖 TVBox 内核，Web 端无法使用，会自动跳过。
      </p>
      <form class="vod-config-form" @submit.prevent="addConfig">
        <input v-model="form.name" type="text" placeholder="名称（可选）" aria-label="配置名称" />
        <input
          v-model="form.url"
          type="text"
          placeholder="配置地址，如 https://raw.liucn.cc/box/m.json"
          aria-label="配置地址"
        />
        <input
          v-model="form.group"
          list="vod-group-options"
          type="text"
          placeholder="分组（可选）"
          aria-label="分组"
        />
        <datalist id="vod-group-options">
          <option v-for="g in groupOptions" :key="g" :value="g"></option>
        </datalist>
        <button class="btn btn-primary" type="submit" :disabled="adding">
          <Loader2 v-if="adding" class="spin" :size="16" />
          <Plus v-else :size="16" />
          添加
        </button>
      </form>
      <p v-if="error" class="load-error">{{ error }}</p>
    </section>

    <div class="section-head">
      <h2><FolderCog :size="17" /> 配置与分组</h2>
      <div class="vod-head-actions">
        <span class="count-note">共 {{ vodStore.configs.length }} 个配置 · {{ vodStore.sources.length }} 个源</span>
        <span class="count-note">{{ metaText }}</span>
        <button
          class="btn btn-secondary btn-small"
          type="button"
          :disabled="refreshingAll"
          @click="refreshAll"
        >
          <Loader2 v-if="refreshingAll" class="spin" :size="14" />
          <RefreshCw v-else :size="14" />
          全部刷新
        </button>
      </div>
    </div>

    <div v-if="vodStore.configsLoading && !vodStore.configs.length" class="vod-state">
      <Loader2 class="spin" :size="22" /> 正在加载配置…
    </div>

    <div v-else-if="!vodStore.configs.length" class="empty-block">
      <Server :size="22" /> 暂无配置，添加一个 TVBox 配置地址开始使用
    </div>

    <div v-else class="vod-config-groups">
      <section v-for="groupItem in groups" :key="groupItem.group" class="vod-config-group">
        <div class="vod-config-group-head">
          <span>{{ groupItem.group }}</span>
          <span class="count-note">{{ groupItem.configs.length }} 个</span>
        </div>
        <div class="saved-list">
          <article
            v-for="item in groupItem.configs"
            :key="item.id"
            class="saved-card vod-config-card"
            :class="{ disabled: !item.enabled }"
          >
            <div class="saved-main">
              <template v-if="editingId === item.id">
                <div class="vod-config-edit">
                  <input v-model="editForm.name" type="text" aria-label="配置名称" />
                  <input v-model="editForm.group" list="vod-group-options" type="text" aria-label="分组" />
                  <button class="btn btn-small btn-primary" type="button" @click="saveEdit(item)">保存</button>
                  <button class="btn btn-small btn-ghost" type="button" @click="editingId = ''">取消</button>
                </div>
              </template>
              <template v-else>
                <strong>
                  <span
                    class="vod-dot"
                    :class="item.status === 'ok' ? 'ok' : item.status === 'fail' ? 'fail' : 'unknown'"
                  ></span>
                  {{ item.name }}
                </strong>
                <span class="saved-url" :title="item.url">{{ item.url }}</span>
              </template>
            </div>

            <div class="saved-meta">
              <span v-if="item.status === 'ok'" class="vod-meta-ok">
                <CheckCircle2 :size="12" /> {{ item.sourceCount }} 个源
              </span>
              <span v-else-if="item.status === 'fail'" class="vod-meta-fail">
                <AlertTriangle :size="12" /> 拉取失败{{ item.error ? '：' + item.error : '' }}
              </span>
              <span v-else>未抓取 · {{ item.sourceCount }} 个源</span>
              <span v-if="!item.enabled">已停用</span>
            </div>

            <div class="saved-actions">
              <button
                class="btn btn-small btn-secondary"
                type="button"
                :disabled="refreshingId === item.id || !item.enabled"
                @click="refreshOne(item.id)"
              >
                <Loader2 v-if="refreshingId === item.id" class="spin" :size="13" />
                <RefreshCw v-else :size="13" />
                刷新
              </button>
              <button class="btn btn-small btn-ghost" type="button" @click="toggleEnabled(item)">
                {{ item.enabled ? '停用' : '启用' }}
              </button>
              <button class="icon-btn" type="button" title="编辑" @click="startEdit(item)">
                <Pencil :size="15" />
              </button>
              <button class="icon-btn danger" type="button" title="删除" @click="remove(item)">
                <Trash2 :size="15" />
              </button>
            </div>
          </article>
        </div>
      </section>
    </div>

    <div class="section-head">
      <h2><Power :size="17" /> 源列表（按源启停）</h2>
      <div class="vod-head-actions">
        <span class="count-note">
          启用 {{ vodStore.sources.length - vodStore.disabledSourceCount }} / {{ vodStore.sources.length }}
          <template v-if="vodStore.disabledSourceCount">· 已停用 {{ vodStore.disabledSourceCount }}</template>
        </span>
        <button
          class="btn btn-secondary btn-small"
          type="button"
          :disabled="vodStore.sourcesLoading"
          @click="vodStore.fetchSources({ check: true })"
        >
          <Loader2 v-if="vodStore.sourcesLoading" class="spin" :size="14" />
          <ShieldCheck v-else :size="14" />
          检测全部
        </button>
      </div>
    </div>
    <p class="vod-panel-tip">
      停用的源不会参与聚合搜索与选路（源级偏好存在服务端 <code>data/vod-source-prefs.json</code>，与配置地址无关）。{{ proxyText }}
    </p>

    <div v-if="vodStore.sourcesLoading && !vodStore.sources.length" class="vod-state">
      <Loader2 class="spin" :size="22" /> 正在加载源列表…
    </div>

    <div v-else-if="!vodStore.sources.length" class="empty-block">
      <Server :size="22" /> 暂无源，先添加配置地址并刷新
    </div>

    <div v-else class="vod-source-groups">
      <section v-for="groupItem in sourceGroups" :key="groupItem.group" class="vod-source-group">
        <div class="vod-config-group-head">
          <span>{{ groupItem.group }}</span>
          <span class="count-note">
            {{ groupItem.sources.filter((s) => s.enabled !== false).length }} / {{ groupItem.sources.length }} 启用
          </span>
        </div>
        <div class="vod-source-list">
          <article
            v-for="item in groupItem.sources"
            :key="item.id"
            class="vod-source-row"
            :class="{ disabled: item.enabled === false }"
          >
            <span
              class="vod-dot"
              :class="item.status === 'ok' ? 'ok' : item.status === 'fail' ? 'fail' : 'unknown'"
            ></span>
            <span class="vod-source-name" :title="item.api">{{ item.name }}</span>
            <span class="vod-source-meta">
              <template v-if="item.status === 'ok'">
                {{ item.latency }} ms<template v-if="item.classes"> · {{ item.classes }} 分类</template>
              </template>
              <template v-else-if="item.status === 'fail'">不可用：{{ item.error || '未知' }}</template>
              <template v-else>未检测</template>
            </span>
            <span v-if="item.from" class="vod-source-from" :title="item.from">{{ item.from }}</span>
            <button
              class="icon-btn"
              type="button"
              :title="'测试「' + item.name + '」'"
              :disabled="testingId === item.id"
              @click="testSource(item)"
            >
              <Loader2 v-if="testingId === item.id" class="spin" :size="14" />
              <Play v-else :size="14" />
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
          </article>
        </div>
      </section>
    </div>

    <footer class="disclaimer">
      <strong>说明</strong>
      <span>配置来自互联网，内容与可用性由对应源站决定；本项目仅做接口聚合与播放代理，不存储任何内容。</span>
    </footer>
  </div>
</template>
