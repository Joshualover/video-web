<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import {
  AlertTriangle,
  CheckCircle2,
  FolderCog,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
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

    <footer class="disclaimer">
      <strong>说明</strong>
      <span>配置来自互联网，内容与可用性由对应源站决定；本项目仅做接口聚合与播放代理，不存储任何内容。</span>
    </footer>
  </div>
</template>
