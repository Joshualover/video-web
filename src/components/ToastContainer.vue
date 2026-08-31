<script setup>
import { useUiStore } from '../stores/ui'

const uiStore = useUiStore()
</script>

<template>
  <div class="toast-container" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="toast in uiStore.toasts" :key="toast.id" class="toast" :class="toast.type">
        {{ toast.message }}
      </div>
    </TransitionGroup>
  </div>
</template>
