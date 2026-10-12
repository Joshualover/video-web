// 音乐源单元测试（离线，不访问网络）
//
// 覆盖三件最容易出错的纯逻辑：
//   1. 纯 JS 的 DES-ECB 解密（Node 自带的 OpenSSL 3 不加载 legacy provider，只能自带实现）
//   2. 各音源返回结构的归一化（字段名/单位/容器的差异都在这里吸收）
//   3. 音源选择策略（排序、按分组轮流取源）
import assert from 'node:assert/strict'
import { desEncryptBlock, desDecryptBlock, desEcbDecrypt, desDecryptBase64 } from '../server/music/des.js'
import { decryptMediaUrl, qualityVariants, normalizeSearchItem as saavnTrack } from '../server/music/jiosaavn.js'
import {
  normalizeSearchItem as pipedTrack,
  normalizeAudioStream as pipedStream
} from '../server/music/piped.js'
import {
  normalizeSearchItem as invTrack,
  normalizeAudioFormat as invFormat
} from '../server/music/invidious.js'
import { normalizeSearchItem as itunesTrack } from '../server/music/itunes.js'
import {
  parseJsonOutput as ytdlpJson,
  normalizeSearchEntry as ytdlpEntry,
  pickAudioFormats as ytdlpFormats,
  bestThumbnail as ytdlpThumb
} from '../server/music/ytdlp.js'
import { scoreMatch, publicTrack } from '../server/music/query.js'
import {
  sourceId,
  rankSources,
  spreadByGroup,
  activeSources,
  kindInfo,
  markHealth,
  sourcesWithHealth
} from '../server/music/sources.js'

const hex = (value) => value.toString(16).toUpperCase().padStart(16, '0')

// ---- 1. DES ----
// FIPS 公开测试向量，实现只要错一位就对不上
assert.equal(hex(desEncryptBlock(0x0123456789abcdefn, 0x133457799bbcdff1n)), '85E813540F0AB405')
assert.equal(hex(desEncryptBlock(0x4e6f772069732074n, 0x0123456789abcdefn)), '3FA40E8A984D4815')
assert.equal(hex(desDecryptBlock(0x85e813540f0ab405n, 0x133457799bbcdff1n)), '0123456789ABCDEF')

// 自家实现加密 → 自家实现解密，验证 PKCS#5 补/去填充是自洽的
function keyBitsOf(keyText) {
  let bits = 0n
  for (const byte of Buffer.from(keyText, 'utf8')) bits = (bits << 8n) | BigInt(byte)
  return bits
}

function desEncryptEcb(text, keyText) {
  const raw = Buffer.from(text, 'utf8')
  const pad = 8 - (raw.length % 8)
  const padded = Buffer.concat([raw, Buffer.alloc(pad, pad)])
  const bits = keyBitsOf(keyText)
  const out = Buffer.alloc(padded.length)
  for (let offset = 0; offset < padded.length; offset += 8) {
    let block = 0n
    for (let i = 0; i < 8; i += 1) block = (block << 8n) | BigInt(padded[offset + i])
    const encrypted = desEncryptBlock(block, bits)
    for (let i = 0; i < 8; i += 1) out[offset + i] = Number((encrypted >> BigInt(56 - 8 * i)) & 0xffn)
  }
  return out
}

const plainText = 'https://aac.saavncdn.com/032/abc_96.mp4'
assert.equal(desEcbDecrypt(desEncryptEcb(plainText, '38346591'), '38346591').toString('utf8'), plainText)
// 正好 8 字节整数倍时也要补一整块，否则去掉填充会吃掉正文
assert.equal(desEcbDecrypt(desEncryptEcb('12345678', '38346591'), '38346591').toString('utf8'), '12345678')
assert.equal(
  desDecryptBase64(desEncryptEcb(plainText, '38346591').toString('base64'), '38346591'),
  plainText
)

// 非 8 字节整数倍 / 非 8 字节密钥都要明确报错，而不是解出乱码
assert.throws(() => desEcbDecrypt(Buffer.alloc(7), Buffer.from('38346591')), /8 的整数倍/)
assert.throws(() => desEcbDecrypt(Buffer.alloc(8), Buffer.from('123')), /8 字节/)

// 真实 JioSaavn 载荷（固定密文，解密结果稳定）
assert.equal(
  decryptMediaUrl('ID2ieOjCrwfgWvL5sXl4B1ImC5QfbsDy4jKuP297XR8SCeVwGMMN4yeG4ffb/qhFpJwFC7JM5p5Jx4y4BKKoUBw7tS9a8Gtq'),
  'https://aac.saavncdn.com/032/11f28803f5cc3b30851102e370090c0b_96.mp4'
)
// 解出来不是 URL（长度合法但内容是垃圾）时必须报「解密失败」，而不是把垃圾地址传下去
assert.throws(() => decryptMediaUrl(Buffer.alloc(8).toString('base64')), /解密失败/)
// 长度不是 8 的整数倍同样要拦
assert.throws(() => decryptMediaUrl('bm90LWEtdXJs'), /8 的整数倍/)

// ---- 2. 各音源归一化 ----
const saavn = saavnTrack({
  id: 'WLrPppdR',
  title: 'Shape of You',
  image: 'https://c.saavncdn.com/032/x-150x150.jpg',
  perma_url: 'https://www.jiosaavn.com/song/shape-of-you/JyQZYQRAU2E',
  more_info: {
    album: 'Shape of You',
    duration: '194',
    music: 'Lexi Thomas',
    encrypted_media_url: 'ID2ieOjC',
    '320kbps': 'true',
    artistMap: { primary_artists: [{ name: 'Lexi Thomas' }], artists: [{ name: '别的' }] }
  }
})
assert.equal(saavn.id, 'WLrPppdR')
assert.deepEqual(saavn.artists, ['Lexi Thomas'])
assert.equal(saavn.album, 'Shape of You')
assert.equal(saavn.duration, 194)
assert.equal(saavn.pic, 'https://c.saavncdn.com/032/x-500x500.jpg')
assert.equal(saavn.has320, true)
assert.equal(saavnTrack({ title: '没有 id' }), null)

// 官方在不同 ctx 下给的形态不一样：web6dot0 嵌在 more_info 里，wap6dot0 平铺在顶层。
// 两种都要能认，否则换个 ctx 整条音源就哑了。
const saavnFlat = saavnTrack({
  id: 'x1',
  song: 'Shape of You',
  primary_artists: 'Ed Sheeran, Beyonce',
  duration: '233',
  album: 'Divide',
  image: 'https://c.saavncdn.com/032/x-150x150.jpg',
  encrypted_media_url: 'Zm9v',
  '320kbps': 'true'
})
assert.equal(saavnFlat.name, 'Shape of You')
assert.deepEqual(saavnFlat.artists, ['Ed Sheeran', 'Beyonce'])
assert.equal(saavnFlat.album, 'Divide')
assert.equal(saavnFlat.duration, 233)
assert.equal(saavnFlat.has320, true)

// 码率档位：320 不是每首都有
assert.deepEqual(
  qualityVariants('https://aac.saavncdn.com/032/abc_96.mp4', true).map((s) => s.bitrate),
  [320000, 160000, 96000, 48000]
)
assert.deepEqual(
  qualityVariants('https://aac.saavncdn.com/032/abc_96.mp4', false).map((s) => s.bitrate),
  [160000, 96000, 48000]
)
assert.equal(
  qualityVariants('https://aac.saavncdn.com/032/abc_96.mp4', true)[0].url,
  'https://aac.saavncdn.com/032/abc_320.mp4'
)

const piped = pipedTrack(
  {
    url: '/watch?v=dQw4w9WgXcQ',
    type: 'stream',
    title: 'Never Gonna Give You Up',
    uploaderName: 'Rick Astley',
    duration: 213,
    thumbnail: '/proxy/pic.jpg'
  },
  'https://pipedapi.kavin.rocks'
)
assert.equal(piped.id, 'dQw4w9WgXcQ')
assert.deepEqual(piped.artists, ['Rick Astley'])
assert.equal(piped.duration, 213)
assert.equal(piped.pic, 'https://pipedapi.kavin.rocks/proxy/pic.jpg')
assert.equal(piped.externalUri, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
// 有些实例直接给 videoId，不给 url
assert.equal(pipedTrack({ videoId: 'abc123', title: 'x' }, 'https://a.b').id, 'abc123')
assert.equal(pipedTrack({ title: '没有 id' }, 'https://a.b'), null)

// Piped 的 bitrate 单位是 kbps，内部一律用 bps
const m4a = pipedStream(
  { url: '/videoplayback?id=1', mimeType: 'audio/mp4', codec: 'mp4a.40.2', bitrate: 128, quality: '128 kbps' },
  'https://pipedapi.kavin.rocks'
)
assert.equal(m4a.bitrate, 128000)
assert.equal(m4a.container, 'mp4')
assert.equal(m4a.url, 'https://pipedapi.kavin.rocks/videoplayback?id=1')
assert.equal(
  pipedStream({ url: 'https://x/y', mimeType: 'audio/webm', codec: 'opus', bitrate: 160 }, 'https://a.b').container,
  'webm'
)
// 没有 url 的流要丢掉，不能把空地址传下去
assert.equal(pipedStream({ mimeType: 'audio/mp4' }, 'https://a.b'), null)

const inv = invTrack(
  {
    type: 'video',
    videoId: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    author: 'Rick Astley',
    lengthSeconds: 213,
    videoThumbnails: [
      { quality: 'low', url: '/vi/low.jpg', width: 320 },
      { quality: 'maxres', url: '/vi/max.jpg', width: 1280 }
    ]
  },
  'https://inv.nadeko.net'
)
assert.equal(inv.id, 'dQw4w9WgXcQ')
assert.deepEqual(inv.artists, ['Rick Astley'])
assert.equal(inv.pic, 'https://inv.nadeko.net/vi/max.jpg')

const invAudio = invFormat(
  { url: '/latest_version?id=1&itag=140', type: 'audio/mp4; codecs="mp4a.40.2"', container: 'm4a', bitrate: '128000', encoding: 'aac' },
  'https://inv.nadeko.net'
)
assert.equal(invAudio.bitrate, 128000)
assert.equal(invAudio.container, 'mp4')
assert.equal(invAudio.codec, 'aac')
assert.equal(invFormat({ type: 'audio/webm', container: 'webm', bitrate: '160000', url: 'https://x/y' }, 'https://a.b').container, 'webm')

const apple = itunesTrack({
  trackId: 1158763996,
  trackName: '後來的我們',
  artistName: 'Mayday',
  collectionName: '自傳',
  trackTimeMillis: 346000,
  artworkUrl100: 'https://is1.mzstatic.com/image/thumb/x/dj.abc.jpg/100x100bb.jpg',
  previewUrl: 'https://audio-ssl.itunes.apple.com/preview.m4a',
  trackViewUrl: 'https://music.apple.com/album/x?i=1'
})
assert.equal(apple.id, '1158763996')
assert.equal(apple.duration, 346)
assert.equal(apple.preview, true)
assert.equal(apple.pic, 'https://is1.mzstatic.com/image/thumb/x/dj.abc.jpg/600x600bb.jpg')
// 没有试听片段的曲目直接不收（收了也播不了）
assert.equal(itunesTrack({ trackId: 1, trackName: 'x', previewUrl: '' }), null)

// ---- 2b. yt-dlp 适配器的纯逻辑 ----
// yt-dlp 正常只往 stdout 写 JSON，但用户 ~/.config/yt-dlp/config 里若加了别的输出就会混入杂行
assert.deepEqual(ytdlpJson('{"a":1}'), { a: 1 })
assert.deepEqual(ytdlpJson('\n{"a":1}\n'), { a: 1 })
assert.deepEqual(ytdlpJson('WARNING: something\n{"a":1}\ntrailing'), { a: 1 })
assert.throws(() => ytdlpJson(''), /没有输出/)
assert.throws(() => ytdlpJson('not json at all'), /不是合法 JSON/)

const ytEntry = ytdlpEntry({
  id: 'JGwWNGJdvx8',
  title: 'Ed Sheeran - Shape of You (Official Music Video)',
  duration: 264.0,
  channel: 'Ed Sheeran',
  thumbnails: [
    { url: 'https://i.ytimg.com/vi/x/hqdefault.jpg', width: 480 },
    { url: 'https://i.ytimg.com/vi/x/maxresdefault.jpg', width: 1280 }
  ]
})
assert.equal(ytEntry.id, 'JGwWNGJdvx8')
assert.deepEqual(ytEntry.artists, ['Ed Sheeran'])
assert.equal(ytEntry.duration, 264)
assert.equal(ytEntry.pic, 'https://i.ytimg.com/vi/x/maxresdefault.jpg')
assert.equal(ytEntry.externalUri, 'https://www.youtube.com/watch?v=JGwWNGJdvx8')
// id 会拼进 watch?v=，必须先验形状，不能让它长得像命令行参数
assert.equal(ytdlpEntry({ id: 'short', title: 'x' }), null)
assert.equal(ytdlpEntry({ id: '--exec=rm -rf /', title: 'x' }), null)
assert.equal(ytdlpEntry({ title: '没有 id' }), null)
assert.equal(ytdlpThumb([{ url: 'ftp://x/a.jpg', width: 99 }]), '')

const ytFormats = ytdlpFormats([
  { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', abr: 129.496, url: 'https://rr1---x.googlevideo.com/a' },
  { format_id: '251', ext: 'webm', acodec: 'opus', vcodec: 'none', abr: 126.413, url: 'https://rr1---x.googlevideo.com/b' },
  { format_id: '249', ext: 'webm', acodec: 'opus', vcodec: 'none', abr: 48.817, url: 'https://rr1---x.googlevideo.com/c' },
  // 带视频的不是我们想要的
  { format_id: '18', ext: 'mp4', acodec: 'mp4a.40.2', vcodec: 'avc1.42001E', abr: 96, url: 'https://rr1---x.googlevideo.com/d' },
  // 没有直链（走 m3u8 的条目）要丢掉，否则会把空地址传给播放器
  { format_id: '233', ext: 'mp4', acodec: 'none', vcodec: 'none', abr: 0, url: '' }
])
assert.deepEqual(ytFormats.map((s) => s.bitrate), [129496, 126413, 48817])
assert.equal(ytFormats[0].container, 'mp4')
assert.equal(ytFormats[0].codec, 'mp4a')
assert.equal(ytFormats[0].quality, '129 kbps')
assert.equal(ytFormats[1].container, 'webm')
assert.equal(ytFormats[1].codec, 'opus')

// ---- 3. 匹配打分 ----
assert.equal(scoreMatch({ name: '夜曲', artists: ['周杰伦'], duration: 227 }, { title: '夜曲', artists: ['周杰伦'], duration: 227 }), 8)
assert.equal(scoreMatch({ name: '夜曲 (Live)', artists: ['周杰伦'] }, { title: '夜曲' }), 5)
assert.equal(scoreMatch({ name: '完全不一样的歌' }, { title: '夜曲' }), 0)
assert.equal(scoreMatch({ name: 'Shape of You', artists: ['Ed Sheeran'] }, { title: 'shape of you' }), 5)
// 括号里的「官方版/MV」这类噪声不影响判断
assert.equal(scoreMatch({ name: '夜曲 官方MV' }, { title: '夜曲' }), 5)

// publicTrack 不能把适配器的内部字段（加密地址）漏给前端
const exposed = publicTrack(
  { id: 'x', name: 'n', artists: [], album: '', duration: 1, pic: '', externalUri: '', preview: false, encryptedMediaUrl: '秘密' },
  { id: 'jiosaavn:www.jiosaavn.com', name: 'JioSaavn', kind: 'jiosaavn' }
)
assert.equal(exposed.key, 'jiosaavn:www.jiosaavn.com:x')
assert.equal(Object.hasOwn(exposed, 'encryptedMediaUrl'), false)

// ---- 4. 音源选择策略 ----
assert.equal(sourceId('piped', 'https://pipedapi.kavin.rocks/'), 'piped:pipedapi.kavin.rocks')
assert.equal(sourceId('invidious', 'https://inv.nadeko.net/api/v1'), 'invidious:inv.nadeko.net')
assert.equal(kindInfo('itunes').group, '试听')
assert.equal(kindInfo('不存在').group, '其它')

const ranked = rankSources([
  { id: 'c', status: 'fail', latency: 10 },
  { id: 'a', status: 'ok', latency: 300 },
  { id: 'b', status: 'ok', latency: 100 },
  { id: 'd', status: 'unknown', latency: 0 }
])
assert.deepEqual(ranked.map((s) => s.id), ['b', 'a', 'd', 'c'])
assert.deepEqual(activeSources([{ id: 'a', enabled: true }, { id: 'b', enabled: false }]).map((s) => s.id), ['a'])

// 按分组轮流取源：8 个 YouTube 实例不该把搜索名额吃光
const spread = spreadByGroup(
  [
    ...Array.from({ length: 8 }, (_v, i) => ({ id: 'yt' + i, group: 'YouTube' })),
    { id: 'saavn', group: 'JioSaavn' },
    { id: 'apple', group: '试听' }
  ],
  6
)
assert.deepEqual(spread.map((s) => s.id), ['yt0', 'saavn', 'apple', 'yt1', 'yt2', 'yt3'])

// 健康状态：搜索成功不能把检测测出来的延迟冲成 0
markHealth('t:probe', true, { latency: 173, version: 'v1' })
markHealth('t:probe', true)
let health = sourcesWithHealth([{ id: 't:probe', kind: 'ytdlp' }])
assert.equal(health[0].status, 'ok')
assert.equal(health[0].latency, 173)
assert.equal(health[0].version, 'v1')

// 退避时长分两档：主动检测失败 30 分钟，用着用着失败（transient）只 2 分钟。
// 把时钟往前拨 3 分钟来验证差别，免得靠等真实时间。
markHealth('t:probe', false, { error: '检测失败' })
markHealth('t:runtime', false, { error: '请求超时', transient: true })
const realNow = Date.now
Date.now = () => realNow() + 3 * 60 * 1000
health = sourcesWithHealth([{ id: 't:probe', kind: 'piped' }, { id: 't:runtime', kind: 'piped' }])
Date.now = realNow
assert.deepEqual(health.map((item) => item.status), ['fail', 'unknown'])
assert.equal(health[0].error, '检测失败')

console.log('music source tests passed')
