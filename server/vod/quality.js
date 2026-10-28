// 画质探测（服务端）：从 m3u8 清单解析最高档位分辨率 → 画质档位。
// 思路参考 LibreTV 的 quality-probe「两级策略」中的第一级（master playlist 文本解析），
// 按其语义重写（AGPL 不复制代码）。分片级 SPS/MP4 深探为二期，不在本文件。
//
// 为什么值得探测：画质不在 CMS 搜索接口里，只写在 m3u8 内部
// （#EXT-X-STREAM-INF 的 RESOLUTION）。要在换源/选路阶段告诉用户「哪条线是 1080P」，
// 只能真实拉一次播放列表——文本头部很小，成本可控。
//
// 保守原则（探不出就承认探不出，绝不猜）：
//  - 只认 master playlist（含 #EXT-X-STREAM-INF）；单码率媒体清单返回 undefined → UI 显示「未知」；
//  - 分辨率取**短边** min(w,h)：采集站把宽高写反很常见，长边会虚高一档；
//  - 只有 BANDWIDTH 没有 RESOLUTION 时按转码参数表反推，且只给下限档（15% 容差进档）。

/** 清单读取上限：master playlist 通常 <1KB，媒体列表几百 KB，只读够解析的头部就断开 */
export const PLAYLIST_MAX_BYTES = 64 * 1024

/** 单条探测总死线（机房到国内源站 RTT 高，8s 经常不够） */
export const PROBE_TIMEOUT_MS = 12000

/** 同一 host 的在途探测上限：探测流量不能把弱源打挂 */
export const HOST_GATE_LIMIT = 3

// ---- 清单解析（纯函数） ----

// BANDWIDTH → 高度 的保守反推表（bps）。取各档位典型码率的中位偏下，
// 只有明显够到某档才敢标某档：介于两档之间时归低档。
const BW_TIERS = [
  { minBps: 8_000_000, height: 2160 },
  { minBps: 4_000_000, height: 1440 },
  { minBps: 2_200_000, height: 1080 },
  { minBps: 1_000_000, height: 720 },
  { minBps: 400_000, height: 480 }
]

function parseStreamInf(line) {
  // RESOLUTION=1920x1080 / BANDWIDTH=2000000（十进制 bps，HLS 规范）
  const res = line.match(/RESOLUTION=(\d+)x(\d+)/i)
  const bw = line.match(/BANDWIDTH=(\d+)/i)
  return {
    width: res ? Number(res[1]) : undefined,
    height: res ? Number(res[2]) : undefined,
    bandwidth: bw ? Number(bw[1]) : undefined
  }
}

// 从 master playlist 文本解析最高档的短边高度。
// 返回 undefined = 不是 master playlist / 解析不出（视为「未知」，不是「标清」）。
export function parseBestHeight(text) {
  const src = String(text || '')
  if (!src.includes('#EXT-X-STREAM-INF')) return undefined
  let best
  let pending
  const lines = src.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue
    const info = parseStreamInf(line)
    // 变体 URI 是下一个非注释行；没有下一行 = 残缺清单，忽略该档
    let uri = ''
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j].trim()
      if (!t) continue
      if (t.startsWith('#')) break
      uri = t
      break
    }
    if (!uri) continue
    pending = info
    let height = undefined
    if (pending.width && pending.height) {
      height = Math.min(pending.width, pending.height) // 短边：防采集站宽高写反
    } else if (pending.bandwidth) {
      for (const tier of BW_TIERS) {
        if (pending.bandwidth >= tier.minBps) {
          height = tier.height
          break
        }
      }
    }
    if (height && (!best || height > best)) best = height
  }
  return best
}

// ---- 档位与徽标（纯函数，前端徽标共用同一语义） ----

// 入参是短边高度；相邻档取中位数分界：1080 不会掉到 720P，1440（2K）不虚标 4K
export function qualityLabel(height) {
  if (!Number.isFinite(height) || height <= 0) return ''
  if (height >= 1728) return '4K' // (1440+2160)/2
  if (height >= 900) return '1080P' // (720+1080)/2
  if (height >= 600) return '720P' // (480+720)/2
  if (height >= 420) return '480P' // (360+480)/2
  return '标清'
}

export function describeQualityBadge(entry) {
  if (!entry) return { kind: 'loading' }
  if (entry.status === 'ok' && entry.height) return { kind: 'value', label: qualityLabel(entry.height) }
  if (entry.status === 'unknown') return { kind: 'unknown' }
  if (entry.status === 'fail') return { kind: 'failed', reason: entry.reason || '' }
  return { kind: 'loading' }
}

// ---- per-host 闸门（防探测风暴） ----

export function createHostGate(limit = HOST_GATE_LIMIT) {
  const inflight = new Map() // host -> count
  return {
    tryAcquire(host) {
      const count = inflight.get(host) || 0
      if (count >= limit) return false
      inflight.set(host, count + 1)
      return true
    },
    release(host) {
      const count = (inflight.get(host) || 1) - 1
      if (count <= 0) inflight.delete(host)
      else inflight.set(host, count)
    },
    active(host) {
      return inflight.get(host) || 0
    }
  }
}

// ---- 探测缓存（成功 30min / 失败与未知 2min；LRU 上限 400） ----

const OK_TTL = 30 * 60 * 1000
const FAIL_TTL = 2 * 60 * 1000
const CACHE_MAX = 400

export function createQualityCache() {
  const map = new Map() // key -> { entry, at }
  return {
    get(key) {
      const hit = map.get(key)
      if (!hit) return undefined
      const ttl = hit.entry.status === 'ok' ? OK_TTL : FAIL_TTL
      if (Date.now() - hit.at > ttl) {
        map.delete(key)
        return undefined
      }
      // 简易 LRU：读到即前移
      map.delete(key)
      map.set(key, hit)
      return hit.entry
    },
    set(key, entry) {
      map.set(key, { entry, at: Date.now() })
      if (map.size > CACHE_MAX) {
        const oldest = map.keys().next().value
        map.delete(oldest)
      }
    },
    clear() {
      map.clear()
    }
  }
}
