// 合并 data/ 下多个 m3u 文件：合并同组、删除重复链接
// 用法: node scripts/merge-m3u.mjs data/123.m3u data/1234.m3u -o data/combined.m3u
import { readFileSync, writeFileSync } from 'node:fs'
import { parseM3u } from '../src/lib/m3u.js'

const args = process.argv.slice(2)
const oIdx = args.indexOf('-o')
const outFile = oIdx >= 0 ? args[oIdx + 1] : 'data/combined.m3u'
const inputFiles = args.filter((_, i) => i !== oIdx && i !== oIdx + 1)

if (inputFiles.length < 1) {
  console.error('用法: node scripts/merge-m3u.mjs <file1.m3u> [file2.m3u ...] -o out.m3u')
  process.exit(1)
}

const seenUrls = new Set()
const groups = [] // 有序分组
const groupIndex = new Map()
let dupCount = 0

function addChannel(channel) {
  const url = channel.url.trim()
  if (!url || seenUrls.has(url)) {
    dupCount += 1
    return false
  }
  seenUrls.add(url)
  const group = channel.group || '未分类'
  if (!groupIndex.has(group)) {
    groupIndex.set(group, groups.length)
    groups.push({ name: group, channels: [] })
  }
  groups[groupIndex.get(group)].channels.push(channel)
  return true
}

// 属性输出顺序：常用属性在前，其余按原始顺序
const PREFERRED = ['tvg-id', 'tvg-logo', 'tvg-name']

function buildExtinf(channel) {
  const attrs = []
  const written = new Set()
  for (const key of PREFERRED) {
    const val = channel.attrs[key]
    if (val) {
      attrs.push(`${key}="${val}"`)
      written.add(key)
    }
  }
  for (const [key, val] of Object.entries(channel.attrs)) {
    if (written.has(key) || !val) continue
    attrs.push(`${key}="${val}"`)
  }
  const dur = Number.isFinite(channel.duration) ? channel.duration : -1
  const attrStr = attrs.length ? ` ${attrs.join(' ')}` : ''
  return `#EXTINF:${dur}${attrStr},${channel.name}`
}

let total = 0
for (const file of inputFiles) {
  const parsed = parseM3u(readFileSync(file, 'utf8'))
  total += parsed.channels.length
  for (const channel of parsed.channels) addChannel(channel)
}

// 「未分类」组排到最后
const ordered = [...groups].sort((a, b) => {
  const aU = a.name === '未分类' ? 1 : 0
  const bU = b.name === '未分类' ? 1 : 0
  return aU - bU
})

const lines = ['#EXTM3U', `#PLAYLIST:合并列表（${total - dupCount} 频道 / ${ordered.length} 组）`, '']
for (const group of ordered) {
  if (group.name !== '未分类') lines.push(`#EXTGRP:${group.name}`)
  for (const channel of group.channels) {
    lines.push(buildExtinf(channel))
    lines.push(channel.url)
  }
  lines.push('')
}

writeFileSync(outFile, lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8')

console.log(`合并完成: ${outFile}`)
console.log(`  输入文件: ${inputFiles.join(', ')}`)
console.log(`  原始频道总数: ${total}`)
console.log(`  删除重复: ${dupCount} 条`)
console.log(`  最终频道: ${total - dupCount} 条`)
console.log(`  分组数: ${ordered.length} 组`)
console.log(`  分组: ${ordered.map((g) => `${g.name}(${g.channels.length})`).join(', ')}`)
