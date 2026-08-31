export const SAMPLE_PLAYLIST = {
  name: '公开示例列表',
  url: '',
  content: [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="bbb" group-title="点播测试",Big Buck Bunny 4K',
    'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    '#EXTINF:-1 tvg-id="tos" group-title="点播测试",Tears of Steel',
    'https://test-streams.mux.dev/tos_ismc/main.m3u8',
    '#EXTINF:-1 tvg-id="audio-1" group-title="音频测试",SoundHelix 示例音频',
    'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'
  ].join('\n')
}
