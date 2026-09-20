// 源查询统一入口：按 source.kind 分派到「苹果 CMS」或「短剧适配器」
//  这样 index.js / best.js / sources.js 都不用再各自 if (kind === 'hgdju')
import { fetchCategories, fetchList, fetchDetail } from './maccms.js'
import * as hgd from './hgdju.js'
import * as vidhub from './vidhub.js'

export function isHgdSource(source) {
  return source?.kind === 'hgdju'
}

export function isVidhubSource(source) {
  return source?.kind === 'vidhub'
}

// 分类（短剧/影视站源同时用作健康检测）
export async function loadCategories(source, opts = {}) {
  if (isHgdSource(source)) return hgd.fetchCategories()
  if (isVidhubSource(source)) return vidhub.fetchCategories()
  return fetchCategories(source.api, opts)
}

// 列表：给了 wd 就是搜索（短剧源没有苹果 CMS 的 wd 参数，走站点搜索页）
export async function loadList(source, { typeId = '', page = 1, wd = '', hours } = {}, opts = {}) {
  if (isHgdSource(source)) {
    return wd ? hgd.fetchSearch(wd) : hgd.fetchList({ typeId, page })
  }
  if (isVidhubSource(source)) {
    return wd ? vidhub.fetchSearch(wd) : vidhub.fetchList({ typeId, page })
  }
  return fetchList(source.api, { typeId, page, wd, hours }, opts)
}

// 详情（含剧集；短剧源的剧集地址是站点播放页，真正 m3u8 在播放时解析）
export async function loadDetail(source, id, opts = {}) {
  if (isHgdSource(source)) return hgd.fetchDetail(id)
  if (isVidhubSource(source)) return vidhub.fetchDetail(id)
  return fetchDetail(source.api, id, opts)
}
