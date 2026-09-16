// 豆瓣热门榜单（发现页数据源）
//  - 不依赖任何采集源/配置地址，直接取豆瓣 m 站 rexxar 接口的「近期热门」
//  - 综艺在豆瓣挂在 tv 下（category=show），所以 kind 与豆瓣 kind 不一定相同
//  - 结果做进程内缓存（默认 1 小时），避免频繁打扰豆瓣
import { httpGetText } from './maccms.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
const DOUBAN_REFERER = 'https://movie.douban.com/'
const TTL = 60 * 60 * 1000
const MAX_ENTRIES = 120

const cache = new Map()

export const DOUBAN_OPTIONS = [
  {
    kind: 'movie',
    doubanKind: 'movie',
    label: '电影',
    categories: [
      { label: '热门', value: '热门' },
      { label: '最新', value: '最新' },
      { label: '豆瓣高分', value: '豆瓣高分' },
      { label: '冷门佳片', value: '冷门佳片' }
    ],
    types: [
      { label: '全部', value: '全部' },
      { label: '华语', value: '华语' },
      { label: '欧美', value: '欧美' },
      { label: '韩国', value: '韩国' },
      { label: '日本', value: '日本' }
    ]
  },
  {
    kind: 'tv',
    doubanKind: 'tv',
    label: '剧集',
    categories: [{ label: '最近热门', value: '最近热门' }],
    types: [
      { label: '全部', value: 'tv' },
      { label: '国产', value: 'tv_domestic' },
      { label: '欧美', value: 'tv_american' },
      { label: '日本', value: 'tv_japanese' },
      { label: '韩国', value: 'tv_korean' },
      { label: '动漫', value: 'tv_animation' },
      { label: '纪录片', value: 'tv_documentary' }
    ]
  },
  {
    kind: 'show',
    doubanKind: 'tv',
    label: '综艺',
    categories: [{ label: '最近热门', value: 'show' }],
    types: [
      { label: '全部', value: 'show' },
      { label: '国内', value: 'show_domestic' },
      { label: '国外', value: 'show_foreign' }
    ]
  }
]

export function doubanOptions() {
  return DOUBAN_OPTIONS
}

function pickValue(list, value, fallbackValue) {
  const hit = list.find((item) => item.value === value)
  if (hit) return hit.value
  return fallbackValue ?? list[0]?.value ?? ''
}

function normalizeItem(item) {
  const subtitle = String(item?.card_subtitle || '').trim()
  return {
    id: String(item?.id || ''),
    name: String(item?.title || '').trim(),
    poster: String(item?.pic?.large || item?.pic?.normal || ''),
    score: item?.rating?.value ? Number(item.rating.value).toFixed(1) : '',
    year: subtitle.match(/(\d{4})/)?.[1] || '',
    subtitle: subtitle.replace(/^\d{4}\s*\/\s*/, '').slice(0, 40)
  }
}

// 取「近期热门」榜单；kind=电影/剧集/综艺，category/type 取自 DOUBAN_OPTIONS
export async function fetchDoubanHot({ kind = 'movie', category = '', type = '', page = 1, limit = 24 } = {}) {
  const def = DOUBAN_OPTIONS.find((item) => item.kind === kind) || DOUBAN_OPTIONS[0]
  const cat = pickValue(def.categories, category)
  const typ = pickValue(def.types, type)
  const size = Math.min(Math.max(Number(limit) || 24, 1), 50)
  const current = Math.max(Number(page) || 1, 1)
  const url =
    `https://m.douban.com/rexxar/api/v2/subject/recent_hot/${def.doubanKind}` +
    `?start=${(current - 1) * size}&limit=${size}` +
    `&category=${encodeURIComponent(cat)}&type=${encodeURIComponent(typ)}`

  const cached = cache.get(url)
  if (cached && Date.now() - cached.at < TTL) {
    return { ...cached.data, cached: true }
  }

  const text = await httpGetText(url, {
    timeout: 12000,
    headers: {
      'User-Agent': UA,
      Referer: DOUBAN_REFERER,
      Origin: 'https://movie.douban.com',
      Accept: 'application/json, text/plain, */*'
    }
  })
  const data = JSON.parse(text)
  const total = Number(data?.total) || 0
  const list = (Array.isArray(data?.items) ? data.items : [])
    .map(normalizeItem)
    .filter((item) => item.id && item.name)

  const result = {
    kind: def.kind,
    label: def.label,
    category: cat,
    type: typ,
    page: current,
    pageSize: size,
    total,
    pageCount: Math.max(Math.ceil(total / size), 1),
    list
  }
  cache.set(url, { at: Date.now(), data: result })
  if (cache.size > MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 40)
    for (const [key] of oldest) cache.delete(key)
  }
  return result
}
