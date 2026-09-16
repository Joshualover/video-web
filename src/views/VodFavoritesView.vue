<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Film, FolderPlus, Heart, Trash2, X } from 'lucide-vue-next'
import VodNav from '../components/VodNav.vue'
import { vodImage } from '../lib/vod'
import { useVodStore } from '../stores/vod'
import { useUiStore } from '../stores/ui'

const router = useRouter()
const vodStore = useVodStore()
const uiStore = useUiStore()

const activeGroup = ref('')
const sort = ref('recent')
const NEW_GROUP = '__new__'

const filtered = computed(() => {
  const list =
    activeGroup.value === ''
      ? [...vodStore.favorites]
      : vodStore.favorites.filter((f) => (f.group || '默认分组') === activeGroup.value)
  if (sort.value === 'name') {
    list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
  } else if (sort.value === 'year') {
    list.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0))
  } else {
    list.sort((a, b) => (b.at || 0) - (a.at || 0))
  }
  return list
})

function open(item) {
  router.push(`/vod/detail/${item.site}/${encodeURIComponent(item.id)}`)
}

function play(item) {
  router.push({
    path: `/vod/play/${item.site}/${encodeURIComponent(item.id)}`,
    query: { line: 0, index: 0 }
  })
}

function groupOf(item) {
  return item.group || '默认分组'
}

function onGroupChange(item, event) {
  const value = event.target.value
  if (value === NEW_GROUP) {
    const name = window.prompt('新分组名称', '')
    if (name && name.trim()) vodStore.setFavoriteGroup(item.site, item.id, name.trim())
    else event.target.value = groupOf(item)
    return
  }
  vodStore.setFavoriteGroup(item.site, item.id, value)
}

function dissolve(group) {
  if (group === '默认分组') return
  if (!window.confirm(`解散分组「${group}」？组内收藏会移回默认分组。`)) return
  vodStore.removeFavoriteGroup(group)
  if (activeGroup.value === group) activeGroup.value = ''
}

function clearCurrent() {
  const scope = activeGroup.value
  const label = scope ? `分组「${scope}」的` : '全部'
  if (!window.confirm(`确定清空${label}收藏？`)) return
  vodStore.clearFavorites(scope)
  uiStore.toast('已清空', 'success')
}
</script>

<template>
  <div class="vod-page">
    <VodNav />

    <div class="section-head">
      <h2><Heart :size="17" /> 我的影视收藏</h2>
      <button
        v-if="vodStore.favorites.length"
        class="btn btn-ghost btn-small"
        type="button"
        @click="clearCurrent"
      >
        <Trash2 :size="14" /> 清空
      </button>
    </div>

    <div v-if="vodStore.favorites.length" class="vod-filter-row">
      <div class="vod-cat-row">
        <button
          class="vod-chip"
          :class="{ active: activeGroup === '' }"
          type="button"
          @click="activeGroup = ''"
        >
          全部 {{ vodStore.favorites.length }}
        </button>
        <button
          v-for="g in vodStore.favoriteGroups"
          :key="g.name"
          class="vod-chip"
          :class="{ active: activeGroup === g.name }"
          type="button"
          @click="activeGroup = g.name"
        >
          {{ g.name }} {{ g.count }}
          <span
            v-if="activeGroup === g.name && g.name !== '默认分组'"
            class="vod-chip-x"
            title="解散分组"
            @click.stop="dissolve(g.name)"
          >
            <X :size="11" />
          </span>
        </button>
      </div>
      <label class="vod-sort">
        排序
        <select v-model="sort">
          <option value="recent">最近收藏</option>
          <option value="name">名称 A→Z</option>
          <option value="year">年份新→旧</option>
        </select>
      </label>
    </div>

    <div v-if="filtered.length" class="vod-grid">
      <article
        v-for="item in filtered"
        :key="`${item.site}|${item.id}`"
        class="vod-card"
        @click="open(item)"
      >
        <div class="vod-poster">
          <img v-if="item.pic" :src="vodImage(item.pic)" alt="" loading="lazy" />
          <span v-else class="vod-poster-fallback">{{ (item.name || '?').slice(0, 2) }}</span>
          <span v-if="item.remarks" class="vod-remark">{{ item.remarks }}</span>
          <button
            class="vod-card-del"
            type="button"
            title="取消收藏"
            @click.stop="vodStore.removeFavorite(item.site, item.id)"
          >
            <X :size="14" />
          </button>
        </div>
        <div class="vod-card-body">
          <strong class="vod-card-name">{{ item.name }}</strong>
          <span class="vod-card-meta">
            <span>{{ item.year || '—' }}</span>
            <span v-if="item.type">· {{ item.type }}</span>
          </span>
          <div class="vod-card-row">
            <select
              class="vod-group-select"
              :value="groupOf(item)"
              title="移动到分组"
              @click.stop
              @change="onGroupChange(item, $event)"
            >
              <option v-for="g in vodStore.favoriteGroups" :key="g.name" :value="g.name">
                {{ g.name }}
              </option>
              <option :value="NEW_GROUP">＋ 新建分组…</option>
            </select>
            <button class="vod-card-play" type="button" @click.stop="play(item)">
              <Film :size="13" /> 播放
            </button>
          </div>
        </div>
      </article>
    </div>

    <div v-else-if="vodStore.favorites.length" class="empty-block">
      <FolderPlus :size="22" /> 该分组暂无收藏
    </div>
    <div v-else class="empty-block"><Heart :size="22" /> 还没有收藏，在影片详情页点「收藏」即可加入</div>
  </div>
</template>
