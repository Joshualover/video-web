// 源级启停偏好（存 data/vod-source-prefs.json）
//  源列表是从「配置地址」实时解析出来的，id = sha1(api) 前 12 位，所以这里只持久化被停用的 id。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../../data')
const FILE = path.join(DATA_DIR, 'vod-source-prefs.json')

let cache = null

async function load() {
  if (cache) return cache
  try {
    const text = await readFile(FILE, 'utf8')
    const data = JSON.parse(text)
    const list = Array.isArray(data?.disabled) ? data.disabled : []
    cache = new Set(list.map(String).filter(Boolean))
  } catch {
    cache = new Set()
  }
  return cache
}

async function persist(set) {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(FILE, JSON.stringify({ disabled: [...set].sort() }, null, 2), 'utf8')
}

export async function disabledSourceIds() {
  return load()
}

export async function setSourceEnabled(id, enabled) {
  const set = await load()
  const key = String(id)
  if (enabled) set.delete(key)
  else set.add(key)
  await persist(set)
  return !set.has(key)
}
