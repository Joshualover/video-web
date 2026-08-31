import { createRouter, createWebHistory } from 'vue-router'
import HomeView from './views/HomeView.vue'
import PlayerView from './views/PlayerView.vue'
import FavoritesView from './views/FavoritesView.vue'
import SettingsView from './views/SettingsView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/player', name: 'player', component: PlayerView },
    { path: '/favorites', name: 'favorites', component: FavoritesView },
    { path: '/settings', name: 'settings', component: SettingsView }
  ],
  scrollBehavior() {
    return { top: 0 }
  }
})

export default router
