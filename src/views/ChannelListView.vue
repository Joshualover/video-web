<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ArrowLeft,
  LayoutGrid,
  LayoutList,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Search,
  X
} from 'lucide-vue-next'
import GroupSidebar from '../components/GroupSidebar.vue'
import ChannelList from '../components/ChannelList.vue'
import { usePlaylistStore } from '../stores/playlist'
import { useUiStore } from '../stores/ui'

const router = useRouter()
const playlistStore = usePlaylistStore()
const uiStore = useUiStore()

const isMobile = ref(false)
const isTablet = ref(false)
const sidebarCollapsed = ref(false)
const drawerOpen = ref(false)
const mobileQuery = window.matchMedia('(max-width: 767px)')
const tabletQuery = window.matchMedia('(max-width: 1023px)')

const activeGroupLabel = computed(() =>
  playlistStore.activeGroup === '全部'
    ? `全部频道（${playlistStore.playlist?.groups.length || 0} 组）`
    : `分组：${playlistStore.activeGroup}`
)

function updateViewport() {
  isMobile.value = mobileQuery.matches
  isTablet.value = tabletQuery.matches
  if (!isTablet.value) drawerOpen.value = false
}

function toggleSidebar() {
  if (isTablet.value) {
    drawerOpen.value = !drawerOpen.value
  } else {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }
}

function goHome() {
  router.push('/')
}

// 点击频道：跳转到独立播放页
function playChannel(channel) {
  if (!channel.valid) return
  playlistStore.setActiveChannel(channel.id)
  router.push('/player')
}

onMounted(() => {
  updateViewport()
  mobileQuery.addEventListener('change', updateViewport)
  tabletQuery.addEventListener('change', updateViewport)
})

onBeforeUnmount(() => {
  mobileQuery.removeEventListener('change', updateViewport)
  tabletQuery.removeEventListener('change', updateViewport)
})
</script>

<template>
  <div class="browse-page">
    <div v-if="!playlistStore.playlist" class="page-state">
      <Play :size="38" />
      <h1>还没有播放列表</h1>
      <p>先加载一个 m3u / m3u8 播放列表，再回来选择频道。</p>
      <button class="btn btn-primary" type="button" @click="goHome">
        <Plus :size="16" /> 去加载播放列表
      </button>
    </div>

    <div v-else class="browse-wrap">
      <header class="player-header">
        <button class="icon-btn" type="button" title="返回首页" @click="goHome">
          <ArrowLeft :size="18" />
        </button>
        <div class="header-info">
          <h1>{{ playlistStore.playlist.name }}</h1>
          <div class="header-badges">
            <span>{{ playlistStore.playlist.source }}</span>
            <span>{{ playlistStore.playlist.channelCount }} 频道</span>
            <span>{{ playlistStore.playlist.groups.length }} 分组</span>
          </div>
        </div>
        <div class="header-actions">
          <div class="channel-search">
            <Search :size="15" />
            <input
              v-model="playlistStore.search"
              type="text"
              placeholder="搜索频道"
              aria-label="搜索频道"
            />
            <button
              v-if="playlistStore.search"
              class="icon-btn"
              type="button"
              @click="playlistStore.setSearch('')"
            >
              <X :size="14" />
            </button>
          </div>
          <button
            v-if="!isMobile"
            class="icon-btn"
            type="button"
            :title="isTablet || sidebarCollapsed ? '展开分组' : '收起分组'"
            @click="toggleSidebar"
          >
            <Menu v-if="isTablet" :size="18" />
            <PanelLeftClose v-else-if="!sidebarCollapsed" :size="18" />
            <PanelLeftOpen v-else :size="18" />
          </button>
          <button class="btn btn-secondary btn-small" type="button" @click="goHome">
            <Plus :size="15" /> 新列表
          </button>
        </div>
      </header>

      <div
        class="browse-layout"
        :class="{ 'sidebar-collapsed': sidebarCollapsed, 'drawer-open': drawerOpen }"
      >
        <!-- 分组栏：桌面固定 / 平板抽屉 / 移动端隐藏 -->
        <aside
          class="channel-sidebar"
          :class="{ 'mobile-hidden': isMobile, collapsed: sidebarCollapsed && !isTablet }"
        >
          <div class="sidebar-head">
            <span>分组导航</span>
            <span class="sidebar-count">{{ playlistStore.groups.length }} 组</span>
          </div>
          <GroupSidebar />
        </aside>

        <div v-if="drawerOpen && isTablet" class="drawer-backdrop" @click="drawerOpen = false"></div>

        <main class="browse-stage">
          <!-- 移动端：分组横向切换 -->
          <div v-if="isMobile" class="mobile-tabs">
            <button
              class="tab-chip"
              :class="{ active: playlistStore.activeGroup === '全部' }"
              type="button"
              @click="playlistStore.setActiveGroup('全部')"
            >
              全部
            </button>
            <button
              v-for="group in playlistStore.groups"
              :key="group"
              class="tab-chip"
              :class="{ active: playlistStore.activeGroup === group }"
              type="button"
              @click="playlistStore.setActiveGroup(group)"
            >
              {{ group }}
            </button>
          </div>

          <!-- 频道面板：右侧，支持方块 / 列表两种视图 -->
          <section class="channel-pane">
            <div class="channel-pane-head">
              <span class="pane-title">
                {{ activeGroupLabel }}
                <span class="pane-count">{{ playlistStore.filteredChannels.length }}</span>
              </span>
              <div class="view-switch" role="group" aria-label="频道显示方式">
                <button
                  class="view-btn"
                  :class="{ active: uiStore.channelView === 'grid' }"
                  type="button"
                  title="方块视图"
                  @click="uiStore.setChannelView('grid')"
                >
                  <LayoutGrid :size="16" />
                </button>
                <button
                  class="view-btn"
                  :class="{ active: uiStore.channelView === 'list' }"
                  type="button"
                  title="列表视图"
                  @click="uiStore.setChannelView('list')"
                >
                  <LayoutList :size="16" />
                </button>
              </div>
            </div>
            <div class="channel-list-wrap">
              <ChannelList
                :view="uiStore.channelView"
                height="100%"
                @play="playChannel"
              />
            </div>
          </section>
        </main>
      </div>
    </div>
  </div>
</template>
