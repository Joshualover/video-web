<script setup>
import { onBeforeUnmount, onMounted } from 'vue'
import TopBar from './components/TopBar.vue'
import ToastContainer from './components/ToastContainer.vue'
import { usePlayerStore } from './stores/player'
import { useUiStore } from './stores/ui'

const playerStore = usePlayerStore()
const uiStore = useUiStore()

function handleOffline() {
  playerStore.setNetwork(true)
  uiStore.toast('网络已断开，恢复后将自动重试', 'warning')
}

function handleOnline() {
  playerStore.setNetwork(false)
}

onMounted(() => {
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
    <TopBar />
    <main class="app-main">
      <router-view />
    </main>
    <ToastContainer />
  </div>
</template>
