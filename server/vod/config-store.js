// TVBox / 影视仓 配置地址的持久化管理（存到 data/vod-configs.json）
import crypto from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../../data')
const FILE = path.join(DATA_DIR, 'vod-configs.json')
const DEFAULTS_FILE = path.join(__dirname, 'default-configs.json')

let cache = null

function newId(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 12)
}

function normalize(raw) {
  const url = String(raw?.url || '').trim()
  let group = String(raw?.group || '').trim().slice(0, 30)
  if (!group) group = '默认配置'
  return {
    id: raw?.id || newId(url),
    name: String(raw?.name || '').trim().slice(0, 30) || url,
    url,
    group,
    enabled: raw?.enabled !== false,
    custom: Boolean(raw?.custom)
  }
}

async function loadDefaults() {
  try {
    const text = await readFile(DEFAULTS_FILE, 'utf8')
    const arr = JSON.parse(text)
    return Array.isArray(arr) ? arr.map((item) => normalize({ ...item, custom: false })) : []
  } catch {
    return []
  }
}

async function persist(list) {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(FILE, JSON.stringify(list, null, 2), 'utf8')
}

export async function listConfigs() {
  if (cache) return cache
  try {
    const text = await readFile(FILE, 'utf8')
    const arr = JSON.parse(text)
    cache = Array.isArray(arr) ? arr.map(normalize) : []
  } catch {
    cache = await loadDefaults()
    await persist(cache)
  }
  return cache
}

export async function addConfig({ name, url, group }) {
  const cleanUrl = String(url || '').trim()
  if (!/^https?:\/\//i.test(cleanUrl)) throw new Error('配置地址需以 http/https 开头')
  const list = await listConfigs()
  if (list.some((c) => c.url === cleanUrl)) throw new Error('该配置地址已存在')
  const item = normalize({ name, url: cleanUrl, group, enabled: true, custom: true })
  list.push(item)
  await persist(list)
  cache = list
  return item
}

export async function updateConfig(id, patch = {}) {
  const list = await listConfigs()
  const item = list.find((c) => c.id === id)
  if (!item) throw new Error('配置不存在')
  if (patch.name !== undefined) item.name = String(patch.name).trim().slice(0, 30) || item.name
  if (patch.group !== undefined) item.group = String(patch.group).trim().slice(0, 30) || '默认配置'
  if (patch.enabled !== undefined) item.enabled = Boolean(patch.enabled)
  if (patch.url !== undefined) {
    const cleanUrl = String(patch.url).trim()
    if (!/^https?:\/\//i.test(cleanUrl)) throw new Error('配置地址需以 http/https 开头')
    item.url = cleanUrl
  }
  await persist(list)
  cache = list
  return item
}

export async function removeConfig(id) {
  const list = await listConfigs()
  const next = list.filter((c) => c.id !== id)
  if (next.length === list.length) throw new Error('配置不存在')
  await persist(next)
  cache = next
  return true
}
