// yt-dlp 适配器 —— Spotube 的第三种 YouTube 引擎（Settings → Playback → YouTube Engine）
//
// Spotube 的 `enum YoutubeClientEngine { ytDlp, youtubeExplode, newPipe }` 里，yt-dlp 是桌面端的
// 子进程方案。对 Node 来说它同样是**最省心的一条 YouTube 通路**：Piped / Invidious 这类公开实例
// 早就大面积失效，而 yt-dlp 由社区持续跟进 YouTube 的反爬变化，本机装一个可执行文件即可。
//
// 调用方式（全部走 execFile + 参数数组，绝不经 shell，避免命令注入）：
//   搜索  yt-dlp --flat-playlist -J "ytsearch<N>:<关键词>"
//   取流  yt-dlp -J <https://www.youtube.com/watch?v=ID>
// 两者都用 -J（--dump-single-json，隐含 --simulate），因此**只取元数据、不落盘下载**。
//
// 两个现实约束写在这里，免得后来人踩：
//   1) 国内直连 googlevideo 是被 DNS 污染 + 403 的，所以**取流同样需要 VOD_HTTP_PROXY**；
//      不过 yt-dlp 的搜索在部分网络下无需代理也能用 —— 代理配置好之后两者都通。
//   2) YouTube 的 player client 会不定期失效，所以按顺序试一组 client（可用
//      YTDLP_PLAYER_CLIENTS 覆盖）。实测 2026-10 可用的是 android_vr。
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { proxyStatus } from '../net.js'

export const kind = 'ytdlp'
// slow：一次调用要起进程 + 访问 YouTube，实测搜索 6-15 秒、取流 5-10 秒。
// 聚合搜索据此决定「要不要为了它多等一会儿」（见 query.js 的 searchAll）。
export const capabilities = { search: true, stream: true, preview: false, slow: true }

const DEFAULT_CLIENTS = ['android_vr', 'android', 'ios']
const PLAYER_CLIENTS = String(process.env.YTDLP_PLAYER_CLIENTS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

const CLIENTS = PLAYER_CLIENTS.length ? PLAYER_CLIENTS : DEFAULT_CLIENTS
// 取流时依次尝试的 client。第一项是 null = 不传 --extractor-args，交给 yt-dlp 自己挑：
// 新版 yt-dlp 的默认组合能拿到**不被限流**的直链（实测 4/4 可整段播），
// 而写死 android_vr 拿到的是只给前 1MiB 的限流地址。默认失败才退回显式列表。
const CLIENT_ATTEMPTS = [null, ...CLIENTS]
// 搜索结果上限：ytsearch 的 N 越大越慢
const MAX_LIMIT = 30
const SEARCH_TIMEOUT = 30000
const STREAM_TIMEOUT = 40000
const VERSION_TIMEOUT = 10000
const MAX_OUTPUT = 64 * 1024 * 1024
// yt-dlp 进程不轻，同时跑太多会把机器拖垮（音乐搜索是并发扇出的）
const MAX_CONCURRENCY = Math.max(Number(process.env.YTDLP_CONCURRENCY) || 2, 1)

// 取流结果缓存：直链有效期几小时，缓存半小时足够，避免重复起进程（一次 5-10 秒）
const STREAM_TTL = 30 * 60 * 1000
const MAX_STREAMS = 200
const streamCache = new Map()

let binaryCache = null // { path, version, at } | { error, at }
let running = 0
const waiting = []

function acquire() {
  if (running < MAX_CONCURRENCY) {
    running += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => waiting.push(resolve)).then(() => {
    running += 1
  })
}

function release() {
  running -= 1
  const next = waiting.shift()
  if (next) next()
}

function candidatePaths() {
  const out = ['yt-dlp']
  const home = os.homedir()
  out.push(
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    path.join(home, '.local/bin/yt-dlp'),
    path.join(home, 'Library/Python/3.9/bin/yt-dlp')
  )
  return out
}

function runFile(binary, args, { timeout, encoding = 'utf8' } = {}) {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { timeout, maxBuffer: MAX_OUTPUT, encoding, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          code: err?.code ?? 0,
          killed: Boolean(err?.killed),
          stdout: stdout ?? '',
          stderr: String(stderr ?? ''),
          spawnError: err?.code === 'ENOENT' ? 'ENOENT' : ''
        })
      }
    )
  })
}

function versionParts(text) {
  return String(text || '')
    .split(/[.\-+_]/)
    .map((part) => Number.parseInt(part, 10))
    .map((value) => (Number.isFinite(value) ? value : 0))
}

export function compareVersions(a, b) {
  const left = versionParts(a)
  const right = versionParts(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

// 同一个机器上常常同时存在好几个 yt-dlp（pip 装的旧版、brew 装的新版……），
// 而旧版在 YouTube 改版后会拿到被限流的直链。所以这里不是「取第一个能找到的」，
// 而是把能跑的都问一遍 --version，挑版本号最大的 —— 这个场景里「新」基本等于「能用」。
export function pickNewest(list) {
  return (Array.isArray(list) ? list : []).reduce(
    (best, item) => (!best || compareVersions(item.version, best.version) > 0 ? item : best),
    null
  )
}

// 找可执行文件：YTDLP_PATH（显式指定，以它为准）> PATH 与常见安装位置里版本最高的那个。
// 成功结果常驻缓存，失败只缓存 1 分钟（用户装完 yt-dlp 不必重启服务）。
export async function resolveBinary() {
  if (binaryCache) {
    const ttl = binaryCache.path ? Number.POSITIVE_INFINITY : 60 * 1000
    if (Date.now() - binaryCache.at < ttl) {
      if (binaryCache.path) return binaryCache
      throw new Error(binaryCache.error)
    }
  }
  const explicit = String(process.env.YTDLP_PATH || '').trim()
  const candidates = explicit ? [explicit] : candidatePaths()
  const probed = []
  for (const candidate of candidates) {
    if (candidate.includes('/') && !existsSync(candidate)) continue
    const result = await runFile(candidate, ['--version'], { timeout: VERSION_TIMEOUT })
    if (!result.code && result.stdout.trim()) {
      probed.push({ path: candidate, version: result.stdout.trim().split('\n')[0] })
    }
  }
  const best = explicit ? probed[0] : pickNewest(probed)
  if (best) {
    if (probed.length > 1) {
      console.log(`[music] yt-dlp 有 ${probed.length} 个，选用版本最高的：${best.path} (${best.version})`)
    }
    binaryCache = { ...best, at: Date.now() }
    return binaryCache
  }
  binaryCache = {
    error: '未安装 yt-dlp（安装后在音源管理页重新检测；也可用 YTDLP_PATH 指定可执行文件路径）',
    at: Date.now()
  }
  throw new Error(binaryCache.error)
}

// 有代理就交给 yt-dlp（它自己会走 --proxy），否则它用直连
function commonArgs() {
  const args = ['--no-warnings', '--no-playlist', '--socket-timeout', '15', '--retries', '1']
  const proxy = proxyStatus()
  if (proxy.enabled && proxy.url) args.push('--proxy', proxy.url)
  return args
}

// yt-dlp 正常只往 stdout 写 JSON，但配置里若加了别的输出可能混入杂行；
// 这里退化成「截取第一个 { 到最后一个 }」再解析。
export function parseJsonOutput(text) {
  const raw = String(text || '').trim()
  if (!raw) throw new Error('yt-dlp 没有输出')
  try {
    return JSON.parse(raw)
  } catch {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1))
      } catch {
        // 落到下面统一报错
      }
    }
    throw new Error('yt-dlp 输出不是合法 JSON')
  }
}

function absoluteThumb(url) {
  const raw = String(url || '').trim()
  return /^https?:\/\//i.test(raw) ? raw : ''
}

export function bestThumbnail(list) {
  if (!Array.isArray(list) || !list.length) return ''
  const sorted = [...list].sort((a, b) => Number(b?.width || 0) - Number(a?.width || 0))
  return absoluteThumb(sorted[0]?.url)
}

// flat-playlist 的条目：字段名在版本间略有出入，能取到就取
export function normalizeSearchEntry(entry) {
  const id = String(entry?.id || '').trim()
  if (!id || !/^[\w-]{6,20}$/.test(id)) return null
  const duration = Math.max(Math.round(Number(entry?.duration) || 0), 0)
  const channel = String(entry?.channel || entry?.uploader || entry?.uploader_id || '').trim()
  return {
    id,
    name: String(entry?.title || '').trim() || id,
    artists: channel ? [channel] : [],
    album: '',
    duration,
    pic: bestThumbnail(entry?.thumbnails) || absoluteThumb(entry?.thumbnail),
    externalUri: `https://www.youtube.com/watch?v=${id}`,
    preview: false
  }
}

// 只要纯音频：vcodec 为 none，且有直链与码率
export function pickAudioFormats(formats) {
  const list = Array.isArray(formats) ? formats : []
  return list
    .filter((format) => {
      const hasVideo = format?.vcodec && format.vcodec !== 'none'
      const hasAudio = format?.acodec && format.acodec !== 'none'
      return !hasVideo && hasAudio && format?.url
    })
    .map((format) => {
      const ext = String(format.ext || '').toLowerCase()
      const isWebm = ext === 'webm' || /opus|vorbis/i.test(String(format.acodec || ''))
      const bitrate = Math.round(Number(format.abr) * 1000) || 0
      return {
        url: String(format.url),
        container: isWebm ? 'webm' : 'mp4',
        codec: String(format.acodec || (isWebm ? 'opus' : 'aac')).split('.')[0],
        bitrate,
        lossless: false,
        quality: bitrate ? `${Math.round(bitrate / 1000)} kbps` : String(format.format_note || '')
      }
    })
    .sort((a, b) => b.bitrate - a.bitrate)
}

export async function fetchSearch(api, { wd, limit = 20 } = {}) {
  const keyword = String(wd || '').trim().slice(0, 200)
  if (!keyword) throw new Error('缺少搜索关键词')
  const size = Math.min(Math.max(limit, 1), MAX_LIMIT)
  const binary = await resolveBinary()
  await acquire()
  let result
  try {
    result = await runFile(
      binary.path,
      [
        ...commonArgs(),
        // youtubetab:skip=webpage 让搜索直接走 Innertube，不必先抓一遍搜索网页（实测快近一倍）
        '--extractor-args',
        'youtubetab:skip=webpage',
        '--flat-playlist',
        '-J',
        `ytsearch${size}:${keyword}`
      ],
      { timeout: SEARCH_TIMEOUT }
    )
  } finally {
    release()
  }
  if (result.code) throw new Error(describeFailure(result, 'yt-dlp 搜索失败'))
  const data = parseJsonOutput(result.stdout)
  const entries = Array.isArray(data?.entries) ? data.entries : []
  return entries.map(normalizeSearchEntry).filter(Boolean)
}

function describeFailure(result, fallback) {
  const lines = String(result.stderr || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('ERROR'))
  const detail = (lines[lines.length - 1] || '').replace(/^ERROR:\s*/, '')
  if (result.killed) return `${fallback}：超时`
  return detail ? `${fallback}：${detail}` : fallback
}

function cacheSet(id, value) {
  streamCache.set(id, { at: Date.now(), value })
  if (streamCache.size > MAX_STREAMS) {
    const oldest = [...streamCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 50)
    for (const [key] of oldest) streamCache.delete(key)
  }
}

export async function fetchStreams(api, { id } = {}) {
  const videoId = String(id || '').trim()
  // 拼 URL 前先验 id：既挡掉非法输入，也保证整个参数不会长得像命令行选项
  if (!/^[\w-]{6,20}$/.test(videoId)) throw new Error('曲目 id 非法')
  const cached = streamCache.get(videoId)
  if (cached && Date.now() - cached.at < STREAM_TTL) return cached.value

  const binary = await resolveBinary()
  const url = `https://www.youtube.com/watch?v=${videoId}`
  let lastError = ''
  for (const client of CLIENT_ATTEMPTS) {
    const label = client ? `client=${client}` : '默认 client'
    await acquire()
    let result
    try {
      const args = [...commonArgs()]
      if (client) args.push('--extractor-args', `youtube:player_client=${client}`)
      args.push('-J', url)
      result = await runFile(binary.path, args, { timeout: STREAM_TIMEOUT })
    } finally {
      release()
    }
    if (result.code) {
      lastError = describeFailure(result, `yt-dlp 取流失败（${label}）`)
      continue
    }
    let data
    try {
      data = parseJsonOutput(result.stdout)
    } catch (err) {
      lastError = err.message
      continue
    }
    const streams = pickAudioFormats(data?.formats)
    if (!streams.length) {
      lastError = `yt-dlp 没有返回纯音频流（${label}）`
      continue
    }
    const value = {
      title: String(data?.title || '').trim(),
      duration: Math.round(Number(data?.duration) || 0),
      pic: bestThumbnail(data?.thumbnails),
      streams
    }
    cacheSet(videoId, value)
    return value
  }
  throw new Error(lastError || 'yt-dlp 取流失败')
}

export async function check() {
  const binary = await resolveBinary()
  return `yt-dlp ${binary.version}`
}
