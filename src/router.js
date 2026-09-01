import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from './stores/auth'
import HomeView from './views/HomeView.vue'
import PlayerView from './views/PlayerView.vue'
import FavoritesView from './views/FavoritesView.vue'
import RecentsView from './views/RecentsView.vue'
import SettingsView from './views/SettingsView.vue'
import LoginView from './views/LoginView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/player', name: 'player', component: PlayerView },
    { path: '/favorites', name: 'favorites', component: FavoritesView },
    { path: '/recents', name: 'recents', component: RecentsView },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/login', name: 'login', component: LoginView }
  ],
  scrollBehavior() {
    return { top: 0 }
  }
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  if (to.path !== '/login' && !auth.authenticated) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }
  if (to.path === '/login' && auth.authenticated) {
    return { path: '/' }
  }
  return true
})

export default router
