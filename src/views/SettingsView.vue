<script setup>
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ArrowLeft,
  Database,
  Download,
  Info,
  KeyRound,
  LogOut,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Upload
} from 'lucide-vue-next'
import { usePlaylistStore } from '../stores/playlist'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { useUiStore } from '../stores/ui'
import { useAuthStore } from '../stores/auth'
import { isValidStreamUrl } from '../lib/m3u'

const router = useRouter()
const playlistStore = usePlaylistStore()
const libraryStore = useLibraryStore()
const playerStore = usePlayerStore()
const uiStore = useUiStore()
const authStore = useAuthStore()

const newPlaylist = reactive({ name: '', url: '' })
const saving = ref(false)
const formError = ref('')

const usageText = computed(() => {
  const bytes = libraryStore.usageBytes()
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
})

async function saveNewPlaylist() {
  const name = newPlaylist.name.trim()
  const url = newPlaylist.url.trim()
  if (!name || !isValidStreamUrl(url)) {
    formError.value = '请填写名称和有效的 http/https 链接'
    return
  }
  formError.value = ''
  saving.value = true
  const ok = await playlistStore.loadByUrl(name, url)
  saving.value = false
  if (ok && playlistStore.playlist) {
    libraryStore.addSaved(name, url, playlistStore.playlist.channelCount)
    newPlaylist.name = ''
    newPlaylist.url = ''
  } else {
    formError.value = playlistStore.loadError || '保存失败，请检查链接是否可访问'
  }
}

function loadSaved(item) {
  playlistStore.loadByUrl(item.name, item.url, {
    navigate: () => router.push('/channels')
  })
}

async function refreshSaved(item) {
  const ok = await playlistStore.loadByUrl(item.name, item.url)
  if (ok && playlistStore.playlist) {
    libraryStore.updateSaved(item.id, {
      channelCount: playlistStore.playlist.channelCount
    })
  }
}

const importInputRef = ref(null)
const serverUploadRef = ref(null)

function exportBackup() {
  const data = libraryStore.exportBackup()
  const stamp = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const date = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json'
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `flow-player-backup-${date}.json`
  link.click()
  URL.revokeObjectURL(url)
  uiStore.toast('备份已导出，请把文件发送到手机后导入', 'success')
}

function openImportPicker() {
  importInputRef.value?.click()
}

async function handleImportFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  if (file.size > 2 * 1024 * 1024) {
    uiStore.toast('备份文件过大', 'warning')
    return
  }
  try {
    const data = JSON.parse(await file.text())
    libraryStore.importBackup(data)
  } catch {
    uiStore.toast('无法解析备份文件，请确认是导出的 JSON', 'error')
  }
}

function formatSize(value) {
  return `${Math.round(value * 100)}%`
}

// ---- 账号与安全 ----
const passForm = reactive({ oldPass: '', newPass: '', confirm: '' })
const passError = ref('')
const passOk = ref('')

function changePassword() {
  passError.value = ''
  passOk.value = ''
  const { oldPass, newPass, confirm } = passForm
  if (!oldPass || !newPass || !confirm) {
    passError.value = '请填写完整'
    return
  }
  if (newPass.length < 4) {
    passError.value = '新密码至少 4 位'
    return
  }
  if (newPass !== confirm) {
    passError.value = '两次输入的新密码不一致'
    return
  }
  if (authStore.changePassword(oldPass, newPass)) {
    passForm.oldPass = ''
    passForm.newPass = ''
    passForm.confirm = ''
    passOk.value = '密码修改成功'
    uiStore.toast('密码已修改', 'success')
  } else {
    passError.value = '原密码错误'
  }
}

function logout() {
  authStore.logout()
  uiStore.toast('已退出登录')
  router.push('/login')
}

function openServerUpload() {
  serverUploadRef.value?.click()
}

async function handleServerUpload(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  if (file.size > 10 * 1024 * 1024) {
    uiStore.toast('文件超过 10MB 限制', 'warning')
    return
  }
  if (!/\.(m3u|m3u8|txt)$/i.test(file.name)) {
    uiStore.toast('仅支持 .m3u / .m3u8 / .txt 文件', 'warning')
    return
  }
  const ok = await playlistStore.uploadServerFile(file)
  if (ok) {
    uiStore.toast(`已上传到服务器目录：${file.name}`, 'success')
  } else {
    uiStore.toast(playlistStore.loadError || '上传失败', 'error')
  }
}
</script>

<template>
  <div class="settings-page">
    <header class="page-head">
      <button class="icon-btn" type="button" title="返回首页" @click="router.push('/')">
        <ArrowLeft :size="18" />
      </button>
      <div>
        <h1>设置</h1>
        <p>管理播放列表、播放默认值与本地数据。</p>
      </div>
    </header>

    <div class="settings-grid">
      <section class="settings-section">
        <div class="section-head">
          <h2>播放列表管理</h2>
          <span class="count-note">{{ libraryStore.savedCount }} / 10</span>
        </div>

        <form class="add-saved-form" @submit.prevent="saveNewPlaylist">
          <input
            v-model="newPlaylist.name"
            type="text"
            placeholder="列表名称"
            aria-label="列表名称"
          />
          <input
            v-model="newPlaylist.url"
            type="url"
            placeholder="https://.../playlist.m3u8"
            aria-label="播放列表链接"
          />
          <button class="btn btn-primary" type="submit" :disabled="saving">
            <Plus :size="16" /> {{ saving ? '验证中...' : '保存' }}
          </button>
        </form>
        <div class="upload-row">
          <button
            class="btn btn-secondary"
            type="button"
            @click="openServerUpload"
          >
            <Upload :size="15" /> 上传 m3u 文件到服务器目录
          </button>
          <input
            ref="serverUploadRef"
            class="visually-hidden"
            type="file"
            accept=".m3u,.m3u8,.txt,application/x-mpegurl,audio/x-mpegurl,text/plain"
            @change="handleServerUpload"
          />
          <span class="upload-hint">上传后会在首页「服务器目录」中自动出现，可切换加载</span>
        </div>
        <p v-if="formError" class="load-error">{{ formError }}</p>

        <div v-if="libraryStore.saved.length" class="saved-admin-list">
          <article v-for="item in libraryStore.saved" :key="item.id" class="saved-admin-row">
            <div class="admin-text">
              <strong>{{ item.name }}</strong>
              <span class="saved-url" :title="item.url">{{ item.url }}</span>
              <span class="admin-meta">{{ item.channelCount ?? '-' }} 频道</span>
            </div>
            <div class="admin-actions">
              <button class="btn btn-small btn-secondary" type="button" @click="loadSaved(item)">
                <Play :size="14" /> 加载
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
          <Database :size="22" />
          <span>保存常用 m3u / m3u8 地址，便于一键切换。</span>
        </div>
      </section>

      <section class="settings-section">
        <div class="section-head">
          <h2>播放默认值</h2>
        </div>
        <div class="pref-row">
          <label for="volume-pref">默认音量</label>
          <input
            id="volume-pref"
            class="range-input"
            type="range"
            min="0"
            max="100"
            :value="Math.round(playerStore.volume * 100)"
            @input="
              playerStore.setPrefs({ volume: Number($event.target.value) / 100 })
            "
          />
          <span class="pref-value">{{ formatSize(playerStore.volume) }}</span>
        </div>
        <div class="pref-row">
          <label for="rate-pref">默认倍速</label>
          <select
            id="rate-pref"
            :value="playerStore.playbackRate"
            @change="playerStore.setPrefs({ playbackRate: Number($event.target.value) })"
          >
            <option :value="0.5">0.5x</option>
            <option :value="0.75">0.75x</option>
            <option :value="1">1x</option>
            <option :value="1.25">1.25x</option>
            <option :value="1.5">1.5x</option>
            <option :value="2">2x</option>
          </select>
          <span class="pref-value">{{ playerStore.playbackRate }}x</span>
        </div>
        <label class="switch-row">
          <span>切换频道后自动播放</span>
          <input
            type="checkbox"
            :checked="playerStore.autoplay"
            @change="playerStore.setPrefs({ autoplay: $event.target.checked })"
          />
          <i class="switch"></i>
        </label>
      </section>

      <section class="settings-section">
        <div class="section-head">
          <h2>本地缓存</h2>
          <span class="count-note">占用 {{ usageText }}</span>
        </div>
        <div class="cache-actions">
          <button class="btn btn-secondary" type="button" @click="libraryStore.clearRecents()">
            <Trash2 :size="15" /> 清空最近播放
          </button>
          <button class="btn btn-secondary" type="button" @click="libraryStore.clearFavorites()">
            <Trash2 :size="15" /> 清空收藏
          </button>
          <button class="btn btn-secondary" type="button" @click="libraryStore.clearSaved()">
            <Trash2 :size="15" /> 清空已保存列表
          </button>
          <button class="btn btn-danger" type="button" @click="libraryStore.clearAllData()">
            <Trash2 :size="15" /> 清空全部数据
          </button>
        </div>
      </section>

      <section class="settings-section">
        <div class="section-head">
          <h2>账号与安全</h2>
          <span class="count-note">当前账号：{{ authStore.username }}</span>
        </div>
        <form class="add-saved-form pass-form" @submit.prevent="changePassword">
          <input
            v-model="passForm.oldPass"
            type="password"
            placeholder="原密码"
            autocomplete="current-password"
            aria-label="原密码"
          />
          <input
            v-model="passForm.newPass"
            type="password"
            placeholder="新密码（至少 4 位）"
            autocomplete="new-password"
            aria-label="新密码"
          />
          <input
            v-model="passForm.confirm"
            type="password"
            placeholder="确认新密码"
            autocomplete="new-password"
            aria-label="确认新密码"
          />
          <button class="btn btn-primary" type="submit">
            <KeyRound :size="16" /> 修改密码
          </button>
        </form>
        <p v-if="passError" class="load-error">{{ passError }}</p>
        <p v-if="passOk" class="load-success">{{ passOk }}</p>
        <div class="cache-actions">
          <button class="btn btn-secondary" type="button" @click="logout">
            <LogOut :size="15" /> 退出登录
          </button>
        </div>
      </section>

      <section class="settings-section">
        <div class="section-head">
          <h2>数据备份与迁移</h2>
          <span class="count-note">跨设备同步</span>
        </div>
        <div class="cache-actions">
          <button class="btn btn-secondary" type="button" @click="exportBackup">
            <Download :size="15" /> 导出备份
          </button>
          <button class="btn btn-secondary" type="button" @click="openImportPicker">
            <Upload :size="15" /> 导入备份
          </button>
          <input
            ref="importInputRef"
            class="visually-hidden"
            type="file"
            accept=".json,application/json"
            @change="handleImportFile"
          />
        </div>
        <div class="about-card">
          <Info :size="15" />
          <span>
            收藏、最近播放、已保存列表仅保存在当前浏览器（localStorage），不会自动跨设备同步。
            换设备/换浏览器时：先在这台设备「导出备份」，把 JSON 文件发送到新设备，再点「导入备份」即可恢复。
          </span>
        </div>
      </section>

      <section class="settings-section">
        <div class="section-head">
          <h2>关于</h2>
        </div>
        <div class="about-card">
          <p><strong>流光播放器</strong> v1.0.0</p>
          <p>Vue 3 + Vite + video.js + Express CORS 代理。</p>
          <ul>
            <li>支持 m3u / m3u8 / txt 播放列表</li>
            <li>HLS 点播与直播播放、音频模式</li>
            <li>最近播放、收藏、多列表管理均保存在本地</li>
          </ul>
          <div class="disclaimer">
            <Info :size="15" />
            <span>本工具不存储、不转码、不传播任何音视频内容；播放质量与可用性取决于第三方源站。</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
