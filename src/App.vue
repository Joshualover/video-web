<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import TopBar from './components/TopBar.vue'
import ToastContainer from './components/ToastContainer.vue'
import { usePlayerStore } from './stores/player'
import { useUiStore } from './stores/ui'

const route = useRoute()
const playerStore = usePlayerStore()
const uiStore = useUiStore()

const isLoginPage = computed(() => route.path === '/login')

function handleOffline() {
  playerStore.setNetwork(true)
  uiStore.toast('网络已断开，恢复后将自动重试', 'warning')
}

function handleOnline() {
  playerStore.setNetwork(false)
}

onMounted(() => {
  uiStore.initTheme()
  window.addEventListener('offline', handleOffline)
  window.addEventListener('online', handleOnline)
})

onBeforeUnmount(() => {
  window.removeEventListener('offline', handleOffline)
  window.removeEventListener('online', handleOnline)
})
</script>

<template>
  <div class="app-shell">
    <TopBar v-if="!isLoginPage" />
    <main class="app-main" :class="{ 'app-main-login': isLoginPage }">
      <router-view />
    </main>
    <ToastContainer />
  </div>
</template>
