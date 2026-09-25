import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from './stores/auth'
import HomeView from './views/HomeView.vue'
import ChannelListView from './views/ChannelListView.vue'
import PlayerView from './views/PlayerView.vue'
import FavoritesView from './views/FavoritesView.vue'
import RecentsView from './views/RecentsView.vue'
import SearchView from './views/SearchView.vue'
import SettingsView from './views/SettingsView.vue'
import LoginView from './views/LoginView.vue'
import VodHomeView from './views/VodHomeView.vue'
import VodDetailView from './views/VodDetailView.vue'
import VodPlayerView from './views/VodPlayerView.vue'
import VodFavoritesView from './views/VodFavoritesView.vue'
import VodHistoryView from './views/VodHistoryView.vue'
import VodSourcesView from './views/VodSourcesView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: VodHomeView },
    { path: '/m3u', name: 'm3u', component: HomeView },
    { path: '/channels', name: 'channels', component: ChannelListView },
    { path: '/player', name: 'player', component: PlayerView },
    { path: '/favorites', name: 'favorites', component: FavoritesView },
    { path: '/recents', name: 'recents', component: RecentsView },
    { path: '/search', name: 'search', component: SearchView },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/login', name: 'login', component: LoginView },
    { path: '/vod', redirect: '/' },
    { path: '/vod/favorites', name: 'vod-favorites', component: VodFavoritesView },
    { path: '/vod/history', name: 'vod-history', component: VodHistoryView },
    { path: '/vod/sources', name: 'vod-sources', component: VodSourcesView },
    { path: '/vod/detail/:site/:id', name: 'vod-detail', component: VodDetailView },
    { path: '/vod/play/:site/:id', name: 'vod-play', component: VodPlayerView }
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
