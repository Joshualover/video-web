<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ArrowRight,
  Clock,
  FileUp,
  Flame,
  History,
  Link2,
  Pencil,
  Play,
  RefreshCw,
  Sparkles,
  Star,
  Trash2,
  X
} from 'lucide-vue-next'
import { usePlaylistStore } from '../stores/playlist'
import { useLibraryStore } from '../stores/library'
import { useUiStore } from '../stores/ui'
import { isValidStreamUrl } from '../lib/m3u'

const router = useRouter()
const playlistStore = usePlaylistStore()
const libraryStore = useLibraryStore()
const uiStore = useUiStore()

const urlInput = ref('')
const fileInputRef = ref(null)
const editingSavedId = ref(null)
const editingName = ref('')

const errorMessage = computed(() => playlistStore.loadError)

function clearError() {
  playlistStore.loadError = null
}

async function loadFromUrl() {
  const url = urlInput.value.trim()
  if (!isValidStreamUrl(url)) {
    playlistStore.loadError = '请输入有效的 http/https 链接'
    return
  }
  clearError()
  const ok = await playlistStore.loadByUrl('', url, {
    navigate: () => router.push('/player')
  })
  if (ok) urlInput.value = ''
}

function openFilePicker() {
  fileInputRef.value?.click()
}

async function handleFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  if (file.size > 5 * 1024 * 1024) {
    uiStore.toast('文件过大，请精简后上传（上限 5MB）', 'warning')
    return
  }
  const name = file.name.replace(/\.(m3u|m3u8|txt)$/i, '') || file.name
  const text = await file.text()
  clearError()
  if (playlistStore.loadByContent(name, text)) {
    router.push('/player')
  }
}

function loadSample() {
  clearError()
  playlistStore.loadSample()
  router.push('/player')
}

function loadSaved(item) {
  clearError()
  playlistStore.loadByUrl(item.name, item.url, {
    navigate: () => router.push('/player')
  })
}

function startEdit(item) {
  editingSavedId.value = item.id
  editingName.value = item.name
}

function saveEdit(item) {
  const name = editingName.value.trim()
  if (!name) return
  libraryStore.updateSaved(item.id, { name })
  editingSavedId.value = null
}

async function refreshSaved(item) {
  const ok = await playlistStore.loadByUrl(item.name, item.url)
  if (ok) {
    libraryStore.updateSaved(item.id, { channelCount: playlistStore.playlist.channelCount })
  }
}

function playRecent(item) {
  playlistStore.playSingle(
    {
      id: 'single-recent',
      name: item.name,
      url: item.url,
      logo: item.logo,
      group: item.group || '未分类',
      valid: true,
      status: 'idle',
      duration: -1
    },
    item.sourceName || '最近播放',
    item.sourceUrl
  )
  router.push('/player')
}

function playFavorite(item) {
  playlistStore.playSingle(
    {
      id: 'single-favorite',
      name: item.name,
      url: item.url,
      logo: item.logo,
      group: item.group || '未分类',
      valid: true,
      status: 'idle',
      duration: -1
    },
    item.sourceName || '收藏',
    item.sourceUrl
  )
  router.push('/player')
}

function formatTime(timestamp) {
  const date = new Date(timestamp)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function truncateUrl(url, length = 44) {
  return url.length > length ? `${url.slice(0, length)}...` : url
}
</script>

<template>
  <div class="home-view">
    <section class="load-panel">
      <div class="load-head">
        <div>
          <h1>加载播放列表</h1>
          <p>粘贴 m3u / m3u8 链接，或上传本地文件，直接在浏览器中播放 HLS 音视频流。</p>
        </div>
        <div class="load-stats" aria-label="本地数据统计">
          <span><Flame :size="14" /> 已保存 {{ libraryStore.savedCount }}</span>
          <span><History :size="14" /> 最近 {{ libraryStore.recentCount }}</span>
          <span><Star :size="14" /> 收藏 {{ libraryStore.favoriteCount }}</span>
        </div>
      </div>

      <div class="load-form">
        <div class="url-field">
          <Link2 :size="18" />
          <input
            v-model="urlInput"
            type="url"
            placeholder="粘贴 https://.../playlist.m3u8 播放列表链接"
            aria-label="播放列表链接"
            @input="clearError"
            @keydown.enter="loadFromUrl"
          />
          <button v-if="urlInput" class="icon-btn field-clear" type="button" @click="urlInput = ''">
            <X :size="15" />
          </button>
        </div>
        <div class="load-actions">
          <button
            class="btn btn-primary"
            type="button"
            :disabled="playlistStore.loading"
            @click="loadFromUrl"
          >
            <Play :size="17" :fill="'currentColor'" /> 加载
          </button>
          <button class="btn btn-secondary" type="button" @click="openFilePicker">
            <FileUp :size="17" /> 上传文件
          </button>
          <button class="btn btn-ghost" type="button" @click="loadSample">
            <Sparkles :size="17" /> 示例列表
          </button>
        </div>
        <input
          ref="fileInputRef"
          class="visually-hidden"
          type="file"
          accept=".m3u,.m3u8,.txt,application/x-mpegurl,audio/x-mpegurl,text/plain"
          @change="handleFile"
        />
      </div>
      <p v-if="errorMessage" class="load-error">{{ errorMessage }}</p>
      <p v-if="playlistStore.loading" class="load-progress">{{ playlistStore.loadStage }}</p>
    </section>

    <section class="home-grid">
      <div class="home-col">
        <div class="section-head">
          <h2>已保存播放列表</h2>
          <router-link to="/settings" class="text-link">管理 <ArrowRight :size="14" /></router-link>
        </div>

        <div v-if="libraryStore.saved.length" class="saved-list">
          <article v-for="item in libraryStore.saved" :key="item.id" class="saved-card">
            <div class="saved-main">
              <input
                v-if="editingSavedId === item.id"
                v-model="editingName"
                class="inline-input"
                type="text"
                aria-label="播放列表名称"
              />
              <strong v-else>{{ item.name }}</strong>
              <span class="saved-url" :title="item.url">{{ truncateUrl(item.url) }}</span>
            </div>
            <div class="saved-meta">
              <span>{{ item.channelCount ?? '-' }} 频道</span>
              <span>{{ formatTime(item.updatedAt) }}</span>
            </div>
            <div class="saved-actions">
              <button class="btn btn-small btn-primary" type="button" @click="loadSaved(item)">
                <Play :size="14" /> 加载
              </button>
              <button
                v-if="editingSavedId === item.id"
                class="btn btn-small btn-secondary"
                type="button"
                @click="saveEdit(item)"
              >
                保存
              </button>
              <button
                v-else
                class="icon-btn"
                type="button"
                title="重命名"
                @click="startEdit(item)"
              >
                <Pencil :size="15" />
              </button>
              <button class="icon-btn" type="button" title="刷新" @click="refreshSaved(item)">
                <RefreshCw :size="15" />
              </button>
              <button
                class="icon-btn danger"
                type="button"
                title="删除"
                @click="libraryStore.removeSaved(item.id)"
              >
                <Trash2 :size="15" />
              </button>
            </div>
          </article>
        </div>

        <div v-else class="empty-block">
          <Link2 :size="22" />
          <span>还没有保存的播放列表，加载后可在设置页保存。</span>
        </div>
      </div>

      <div class="home-col">
        <div class="section-head">
          <h2>最近播放</h2>
          <router-link to="/favorites" class="text-link">收藏页 <ArrowRight :size="14" /></router-link>
        </div>
        <div v-if="libraryStore.recents.length" class="recent-list">
          <button
            v-for="item in libraryStore.recents.slice(0, 8)"
            :key="item.id"
            class="recent-row"
            type="button"
            @click="playRecent(item)"
          >
            <span class="channel-logo small">
              <span class="channel-logo-fallback">{{ item.name.slice(0, 1) }}</span>
            </span>
            <span class="recent-text">
              <strong>{{ item.name }}</strong>
              <span>{{ item.sourceName }} · {{ formatTime(item.playedAt) }}</span>
            </span>
            <Play :size="16" class="recent-play" />
          </button>
        </div>
        <div v-else class="empty-block">
          <Clock :size="22" />
          <span>播放过的频道会出现在这里，最多保留 20 条。</span>
        </div>

        <div class="section-head spaced">
          <h2>收藏预览</h2>
          <span v-if="libraryStore.favoriteCount" class="count-note">{{ libraryStore.favoriteCount }} / 100</span>
        </div>
        <div v-if="libraryStore.favorites.length" class="fav-list">
          <button
            v-for="item in libraryStore.favorites.slice(0, 4)"
            :key="item.id"
            class="recent-row"
            type="button"
            @click="playFavorite(item)"
          >
            <span class="channel-logo small">
              <span class="channel-logo-fallback">{{ item.name.slice(0, 1) }}</span>
            </span>
            <span class="recent-text">
              <strong>{{ item.name }}</strong>
              <span>{{ item.group }} · {{ item.sourceName }}</span>
            </span>
            <Star :size="15" class="fav-star" :fill="'currentColor'" />
          </button>
        </div>
        <div v-else class="empty-block">
          <Star :size="22" />
          <span>在频道列表中点击心形即可收藏。</span>
        </div>
      </div>
    </section>

    <footer class="disclaimer">
      <strong>免责声明</strong>
      <span>本网站仅提供播放工具，不存储、不转码、不传播任何音视频内容；所有播放数据均保存在您的浏览器本地。</span>
    </footer>
  </div>
</template>
