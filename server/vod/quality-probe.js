// 画质探测（带出网）：拉 m3u8 清单头部 → 解析最高档分辨率。
// 挂在 quality.js 的纯函数之上；分片级 SPS/MP4 深探为二期（单码率源将显示「未知」）。
//
// 防护与成本控制（对齐本项目 2026-10 审核已确立的边界）：
//  - 探测地址先过 resolveMediaUrl（内含 assertPublicTarget，SSRF 口径与播放一致）；
//  - 只读清单头部 64KB，读满即断；总死线 12s；
//  - 同一 host 在途 ≤3（探测风暴不能打挂弱源）；
//  - 同 URL 的并发请求合并（inflight）；结果缓存成功 30min、失败/未知 2min。
import http from 'node:http'
import https from 'node:https'
import { agentFor } from '../net.js'
import { ALLOW_INSECURE_TLS, assertPublicTarget } from '../proxy-core.js'
import { resolveMediaUrl } from './hls.js'
import {
  parseBestHeight,
  qualityLabel,
  createHostGate,
  createQualityCache,
  PLAYLIST_MAX_BYTES,
  PROBE_TIMEOUT_MS
} from './quality.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const gate = createHostGate()
const cache = createQualityCache()
const inflight = new Map() // resolvedUrl -> Promise<entry>

// 读清单头部：GET + 手动限读，够 PLAYLIST_MAX_BYTES 就断开。
// 不用 Range：不少采集 CDN 对 m3u8 的 Range 支持是坏的（给 200 全量或直接 4xx）。
function readPlaylistHead(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.get(
      url,
      {
        rejectUnauthorized: !ALLOW_INSECURE_TLS,
        agent: agentFor(url),
        headers: { 'User-Agent': UA, Accept: '*/*' },
        timeout: timeoutMs
      },
      (res) => {
        const code = res.statusCode || 0
        if (code < 200 || code >= 300) {
          const location = res.headers.location
          res.destroy()
          // 3xx 把 Location 挂在错误上，由 fetchPlaylistText 逐跳跟随（每跳重过出网校验）
          reject(Object.assign(new Error(`HTTP ${code}`), { status: code, location }))
          return
        }
        let size = 0
        const chunks = []
        res.on('data', (chunk) => {
          size += chunk.length
          chunks.push(chunk)
          if (size >= PLAYLIST_MAX_BYTES) {
            res.destroy()
            resolve(Buffer.concat(chunks, size).subarray(0, PLAYLIST_MAX_BYTES).toString('utf8'))
          }
        })
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        res.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')))
      }
    )
    req.on('timeout', () => req.destroy(new Error('探测超时')))
    req.on('error', reject)
  })
}

// 3xx 跟一跳（CDN 常见）；每跳重新过出网校验
async function fetchPlaylistText(rawUrl, deadlineAt) {
  let current = await assertPublicTarget(rawUrl)
  for (let hop = 0; hop <= 2; hop += 1) {
    const left = deadlineAt - Date.now()
    if (left <= 0) throw new Error('探测超时')
    try {
      return await readPlaylistHead(current, left)
    } catch (err) {
      const location = err?.location
      if ([301, 302, 303, 307, 308].includes(err?.status) && location) {
        current = await assertPublicTarget(new URL(location, current.toString()).toString())
        continue
      }
      throw err
    }
  }
  throw new Error('重定向次数过多')
}

// 单个探测（带缓存与 inflight 合并）。入参可以是网页播放页，先走统一解析。
export async function probePlaylistQuality(rawUrl) {
  let resolved
  try {
    resolved = await resolveMediaUrl(rawUrl)
  } catch (err) {
    return { status: 'fail', reason: err?.message || '地址非法' }
  }
  const hit = cache.get(resolved)
  if (hit) return hit
  const pending = inflight.get(resolved)
  if (pending) return pending

  const job = (async () => {
    let host
    try {
      host = new URL(resolved).hostname
    } catch {
      return { status: 'fail', reason: '地址非法' }
    }
    if (!gate.tryAcquire(host)) {
      return { status: 'fail', reason: '源站繁忙' } // 同 host 并发满了：快速失败，别排队
    }
    try {
      const deadlineAt = Date.now() + PROBE_TIMEOUT_MS
      const text = await fetchPlaylistText(resolved, deadlineAt)
      const height = parseBestHeight(text)
      const entry = height
        ? { status: 'ok', height, label: qualityLabel(height) }
        : { status: 'unknown' } // 清单到手但无分辨率信息：是「未知」，不是「探测失败」也不是「标清」
      cache.set(resolved, entry)
      return entry
    } catch (err) {
      const entry = {
        status: 'fail',
        reason: err?.status === 401 || err?.status === 403 ? '防盗链' : err?.message || '探测失败'
      }
      cache.set(resolved, entry)
      return entry
    } finally {
      gate.release(host)
      inflight.delete(resolved)
    }
  })()

  inflight.set(resolved, job)
  return job
}

// 批量探测：串行受限于 host 闸门，批量并发 ≤2；结果按入参顺序返回。
export async function probeQualityBatch(urls, { concurrency = 2 } = {}) {
  const list = Array.isArray(urls) ? urls.slice(0, 24) : []
  const results = new Array(list.length)
  let cursor = 0
  async function worker() {
    while (cursor < list.length) {
      const i = cursor
      cursor += 1
      results[i] = await probePlaylistQuality(list[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker))
  return list.map((url, i) => ({ url, ...results[i] }))
}
