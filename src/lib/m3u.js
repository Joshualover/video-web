const HTTP_URL_RE = /^https?:\/\//i

export function isValidStreamUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function urlBasename(url) {
  try {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').filter(Boolean).pop()
    if (!last) return parsed.hostname
    try {
      return decodeURIComponent(last)
    } catch {
      return last
    }
  } catch {
    return url
  }
}

function splitExtinfRest(rest) {
  let inQuotes = false
  let lastComma = -1
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i]
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === ',' && !inQuotes) lastComma = i
  }
  if (lastComma === -1) {
    return { attrs: rest.trim(), name: '' }
  }
  return {
    attrs: rest.slice(0, lastComma).trim(),
    name: rest.slice(lastComma + 1).trim()
  }
}

function parseAttributes(str) {
  const attrs = {}
  const quoted = str.matchAll(/([A-Za-z0-9_-]+)="([^"]*)"/g)
  for (const match of quoted) attrs[match[1].toLowerCase()] = match[2].trim()
  const unquoted = str.matchAll(/([A-Za-z0-9_-]+)=([^\s"',]+)/g)
  for (const match of unquoted) {
    const key = match[1].toLowerCase()
    if (!(key in attrs)) attrs[key] = match[2].trim()
  }
  return attrs
}

function cleanName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseM3u(content) {
  const lines = String(content || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const channels = []
  let pending = null
  let pendingGroup = null
  let sawHeader = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith('#')) {
      if (/^#EXTM3U\b/i.test(trimmed)) {
        sawHeader = true
        continue
      }
      if (/^#EXTGRP:/i.test(trimmed)) {
        pendingGroup = trimmed.slice(8).trim()
        continue
      }
      if (/^#EXTVLCOPT:/i.test(trimmed) || /^#EXTHTTP:/i.test(trimmed)) {
        continue
      }
      const extinfMatch = /^#EXTINF:/i.test(trimmed)
      if (extinfMatch) {
        const rest = trimmed.slice(trimmed.indexOf(':') + 1)
        const { attrs, name } = splitExtinfRest(rest)
        const firstToken = attrs.split(/\s+/)[0] || ''
        const duration = Number.parseFloat(firstToken)
        const attrMap = parseAttributes(attrs)
        const displayName = cleanName(name || attrMap['tvg-name'] || attrMap.name)
        pending = {
          duration: Number.isFinite(duration) ? duration : -1,
          name: displayName,
          group: cleanName(attrMap['group-title'] || pendingGroup) || '未分类',
          tvgId: attrMap['tvg-id'] || '',
          logo: attrMap['tvg-logo'] || '',
          attrs: attrMap
        }
        continue
      }
      continue
    }

    if (!HTTP_URL_RE.test(trimmed)) continue
    const url = trimmed
    const valid = isValidStreamUrl(url)
    const name = cleanName(
      pending?.name || urlBasename(url) || urlBasename(url.replace(/\/+$/, ''))
    )
    channels.push({
      id: '',
      name: name || '未命名频道',
      url,
      logo: pending?.logo || '',
      group: pending?.group || pendingGroup || '未分类',
      tvgId: pending?.tvgId || '',
      duration: pending?.duration ?? -1,
      attrs: pending?.attrs || {},
      valid,
      status: 'idle'
    })
    pending = null
    pendingGroup = null
  }

  channels.forEach((channel, index) => {
    channel.id = `ch-${index}`
    if (!channel.valid) channel.status = 'invalid'
  })

  const seen = new Set()
  const groups = []
  for (const channel of channels) {
    const group = channel.group || '未分类'
    if (!seen.has(group)) {
      seen.add(group)
      groups.push(group)
    }
  }
  const unclassified = groups.filter((group) => group === '未分类')
  const others = groups.filter((group) => group !== '未分类')
  const orderedGroups = unclassified.length ? [...others, ...unclassified] : others

  return {
    channels,
    groups: orderedGroups,
    count: channels.length,
    rawContent: String(content || ''),
    sawHeader
  }
}
