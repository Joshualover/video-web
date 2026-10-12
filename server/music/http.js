// 音乐源的出网封装
//
// 复用影视源那套「先过出口校验（SSRF 防护）、再按需走 VOD_HTTP_PROXY」的取文本实现，
// 避免音乐源另起一套出网/代理逻辑。音乐源（尤其 YouTube 系）在国内需要代理才能访问。
import { httpGetText, parseJsonLoose } from '../vod/maccms.js'

const JSON_HEADERS = { Accept: 'application/json, text/plain, */*' }

export async function getJson(url, { timeout = 12000, headers } = {}) {
  const text = await httpGetText(url, {
    timeout,
    headers: { ...JSON_HEADERS, ...(headers || {}) }
  })
  return parseJsonLoose(text)
}

export { httpGetText, parseJsonLoose }

export function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}
