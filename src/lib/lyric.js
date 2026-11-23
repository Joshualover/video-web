// LRC 歌词解析
//
// 音源（GD音乐台）回的是标准 LRC 文本：
//   [00:12.34]歌词内容
//   [00:12.34][01:20.00]重复的副歌
// 也见过 [ar:歌手] / [ti:歌名] 这类头部元信息标签，必须跳过，否则会被当成时间轴上的怪行。
//
// 这里只做纯函数解析，不碰网络与 DOM，方便单测。

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const META_TAG = /^\[(ar|ti|al|by|offset|length|re|ve):/i
// 逐字时间轴（[00:12.34]<00:12.50>字…）里的内嵌标记，展示前要清掉
const INLINE_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g

function parseTimeTag(match) {
  const minutes = Number(match[1]) || 0
  const seconds = Number(match[2]) || 0
  const fractionRaw = match[3] || ''
  // 两位是百分秒（.34 = 340ms），三位是毫秒
  const fraction = fractionRaw
    ? Number(fractionRaw) / (fractionRaw.length === 2 ? 100 : fractionRaw.length === 1 ? 10 : 1000)
    : 0
  return minutes * 60 + seconds + fraction
}

function cleanText(text) {
  return String(text || '')
    .replace(INLINE_TAG, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// 返回按时间升序的 [{ time, text }]，空行会被保留为占位（用于段落呼吸感）
export function parseLrc(input) {
  const raw = String(input || '')
  if (!raw.trim()) return []
  const lines = raw.split(/\r?\n/)
  const out = []

  for (const line of lines) {
    const text = line.trim()
    if (!text) continue
    if (META_TAG.test(text)) continue

    TIME_TAG.lastIndex = 0
    const tags = []
    let match
    while ((match = TIME_TAG.exec(text)) !== null) {
      tags.push(parseTimeTag(match))
    }
    if (!tags.length) continue

    // 一行可能有多个时间标签（副歌重复），歌词正文是最后一个标签之后的内容
    const content = cleanText(text.replace(TIME_TAG, ''))
    if (!content) continue
    for (const time of tags) out.push({ time, text: content })
  }

  out.sort((a, b) => a.time - b.time)
  return out
}

// 当前播放时间落在第几行：返回索引，找不到返回 -1
export function activeLyricIndex(lines, currentTime) {
  if (!Array.isArray(lines) || !lines.length) return -1
  const time = Number(currentTime) || 0
  // 二分：歌词行数不多，但每帧都要算，别用循环
  let low = 0
  let high = lines.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (lines[mid].time <= time + 0.12) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

// 纯音乐 / 无歌词时的占位
export const NO_LYRIC_TEXT = '暂无歌词'
