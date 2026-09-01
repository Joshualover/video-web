<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Clapperboard, Lock, LogIn, User } from 'lucide-vue-next'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()

const username = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

function submit() {
  if (loading.value) return
  error.value = ''
  if (!username.value.trim() || !password.value) {
    error.value = '请输入账号和密码'
    return
  }
  loading.value = true
  // 本地校验，同步完成
  const ok = authStore.login(username.value.trim(), password.value)
  loading.value = false
  if (ok) {
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
    router.replace(redirect)
  } else {
    error.value = '账号或密码错误'
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-brand">
        <span class="brand-mark"><Clapperboard :size="24" /></span>
        <h1>流光播放器</h1>
        <p>m3u / m3u8 在线播放</p>
      </div>

      <form class="login-form" @submit.prevent="submit">
        <label class="login-field">
          <User :size="16" />
          <input
            v-model="username"
            type="text"
            placeholder="账号"
            autocomplete="username"
            aria-label="账号"
            autofocus
          />
        </label>
        <label class="login-field">
          <Lock :size="16" />
          <input
            v-model="password"
            type="password"
            placeholder="密码"
            autocomplete="current-password"
            aria-label="密码"
            @keydown.enter="submit"
          />
        </label>
        <p v-if="error" class="login-error">{{ error }}</p>
        <button class="btn btn-primary login-submit" type="submit" :disabled="loading">
          <LogIn :size="17" /> {{ loading ? '登录中...' : '登 录' }}
        </button>
      </form>

      <p class="login-hint">默认账号 admin，默认密码 admin123（可在设置页修改）</p>
    </div>
  </div>
</template>
