// server/vod/bangumi.js + hot-list.js 纯函数部分的单元测试（不触网）
import assert from 'node:assert/strict'
import { normalizeWeekday, subjectToItem, groupCalendarByWeekday } from '../server/vod/bangumi.js'
import { isHotListId, doubanWeeklyToItem, baiduTeleplayToItem, HOT_LIST_IDS } from '../server/vod/hot-list.js'

// ---- Bangumi ----
assert.equal(normalizeWeekday(1), 1)
assert.equal(normalizeWeekday(7), 7)
assert.equal(normalizeWeekday(8), undefined) // 非法星期丢弃
assert.equal(normalizeWeekday(0), undefined)

{
  const item = subjectToItem({
    id: 123,
    name: 'Somt Title',
    name_cn: '中文标题',
    images: { large: 'https://x/l.jpg' },
    rating: { score: 8.5 }
  })
  assert.equal(item.title, '中文标题') // name_cn 优先
  assert.equal(item.cover, 'https://x/l.jpg')
  assert.equal(item.rating, '8.5')
  assert.equal(item.isTv, true)
}
// 缺封面/标题 → 脏数据丢弃
assert.equal(subjectToItem({ id: 1, name: 'x' }), undefined)
assert.equal(subjectToItem({ id: 1, name_cn: 'x', images: {} }), undefined)
// 无评分不填 rating
assert.equal(subjectToItem({ id: 1, name: 'n', images: { medium: 'm' } }).rating, undefined)

{
  const days = groupCalendarByWeekday([
    { weekday: { id: 3 }, items: [{ id: 1, name: 'a', images: { large: 'x' } }] },
    { weekday: { id: 99 }, items: [] }, // 非法星期丢弃
    { weekday: { id: 5 }, items: [{ id: 2, name: 'b', images: { large: 'y' } }, { id: 0 }] } // 后者脏数据丢
  ])
  assert.deepEqual(Object.keys(days).map(Number), [3, 5])
  assert.equal(days[3].length, 1)
  assert.equal(days[5].length, 1)
}

// ---- Hot list ----
assert.equal(isHotListId('douban_movie_weekly'), true)
assert.equal(isHotListId('baidu_teleplay'), true)
assert.equal(isHotListId('不存在的榜'), false)
assert.equal(HOT_LIST_IDS.length, 6)

{
  const item = doubanWeeklyToItem({ id: 9, title: 'T', cover: 'https://img3.doubanio.com/a.jpg', rating: 7.2 }, false)
  assert.equal(item.id, '9')
  assert.equal(item.isTv, false)
  assert.equal(item.rating, '7.2')
}
// 优先原生 cover，缺省才用 cover_proxy
assert.equal(doubanWeeklyToItem({ id: 1, title: 'T', cover: 'native', cover_proxy: 'proxy' }).cover, 'native')
assert.equal(doubanWeeklyToItem({ id: 1, title: 'T', cover_proxy: 'proxy' }).cover, 'proxy')
assert.equal(doubanWeeklyToItem({ id: 1, title: 'T' }), undefined) // 无封面丢弃

// 百度榜：序号造 key，无海报丢弃
assert.equal(baiduTeleplayToItem({ title: 'A', cover: 'c' }, 2).id, 'baidu_2')
assert.equal(baiduTeleplayToItem({ title: 'A', cover: null }, 0), undefined)
assert.equal(baiduTeleplayToItem({ title: '', cover: 'c' }, 0), undefined)

console.log('bangumi + hot-list: all assertions passed')
