import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { useAuthStore } from './stores/auth'
import 'video.js/dist/video-js.css'
import './styles/main.css'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)

// 部署时若启用了服务端会话（WEB_LOGIN），先问一次服务端再挂载：
// 既能让路由守卫拿到真实登录态，也避免先闪一下登录页
useAuthStore(pinia)
  .refreshSession()
  .catch(() => {})
  .finally(() => {
    app.use(router).mount('#app')
  })
