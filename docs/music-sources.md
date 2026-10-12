# 音乐源

「音乐」板块的播放通路对齐 [Spotube](https://github.com/team-spotube/spotube) 的音源模型。
Spotube 把「曲目元数据」与「音频来源」拆成两个可插拔的角色，音频源插件只实现三个方法：

| Spotube 插件契约 | 本项目对应 |
| --- | --- |
| `supportedPresets`（支持的容器/音质档位） | 每个适配器返回的 `streams[].container / bitrate / quality` |
| `matches(track)`（按曲目找候选） | `GET /api/music/match`：拿「曲名 + 艺术家」逐源找最像的一首 |
| `streams(match)`（给出可播放地址） | `GET /api/music/stream`：解析出可播放流，并换成走本站的代理地址 |

差别只有一处：Spotube 用 Spotify（需要自备 Client ID）取元数据、再拿元数据去音源里找；
本项目的搜索直接打在音源上，省掉 Spotify 这一环 —— 因此**不需要任何密钥**。

## 内置音源

| kind | 名称 | 取流方式 | 国内可直连 |
| --- | --- | --- | --- |
| `piped` | Piped | YouTube 音频，`/search?filter=music_songs` + `/streams/<id>?local=true` | 需要出网代理 |
| `invidious` | Invidious | YouTube 音频，`/api/v1/search` + `/api/v1/videos/<id>?local=true` | 需要出网代理 |
| `jiosaavn` | JioSaavn | 官方 `api.php?__call=search.getResults`，播放地址 DES 解密后直连 `aac.saavncdn.com` | 可直连 |
| `itunes` | Apple 试听 | iTunes Search API 的 30 秒试听片段 | 可直连 |

- **Piped / Invidious 就是 Spotube 默认音源（YouTube 音频）在 Web 侧的等价实现。**
  桌面端 Spotube 用 Dart 的 YouTubeEngine（youtube_explode / newpipe / yt-dlp）直连 YouTube，
  浏览器 + Node 跑不了那套内核，所以改走公开的 YouTube 前端 API 实例。
  `local=true` 让实例代取 googlevideo 的地址（国内直连 googlevideo 不通）。
- **JioSaavn** 是 Spotube 内置过的另一条音源，检索接口可用，播放地址是 DES-ECB 加密的，
  解密后即 `aac.saavncdn.com` 上的明文 mp4（多档码率靠改文件名后缀）。
- **Apple 试听不在 Spotube 里**，是本项目补的兜底：YouTube 系音源在国内必须配出网代理，
  没有代理时总得有一条能出声的通路。它只给 30 秒片段（接口里 `preview: true`，界面上标「试听」），
  不想要可以在音源管理页直接停用。

## 出网代理

Piped / Invidious 实例与 YouTube 一样在国内网络不可达，需要给**服务端**配代理：

```bash
VOD_HTTP_PROXY=http://127.0.0.1:7890   # 与影视源共用同一个代理配置
VOD_NO_PROXY=aac.saavncdn.com          # 需要直连的域名（逗号分隔）
```

代理只影响服务端出网；浏览器始终只跟本站说话（音频也走 `/api/music/proxy`）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MUSIC_SEARCH_SOURCES` | `6` | 一次聚合搜索最多并搜几个音源（1-20） |
| `MUSIC_SEARCH_DEADLINE` | `9000` | 单次聚合搜索的硬截止（毫秒，2-20 秒） |
| `MUSIC_SEARCH_SOFT_DEADLINE` | `3500` | 已拿到结果就先返回的软截止（毫秒） |
| `MUSIC_MATCH_SOURCES` | `4` | 「换源播放」最多依次尝试几个音源 |
| `MUSIC_WARMUP` | `1` | 启动后异步检测一遍音源；`0` 关闭 |

## 为什么搜索要设两个截止时间

没配代理时，一批 Piped/Invidious 实例都是「连不上、等超时」。如果一定要等所有源结束，
搜索框要转 9 秒。所以聚合搜索有两条线：

1. **软截止（3.5 秒）**：只要已经有源出了结果，就先把结果返回；剩下的源继续在后台跑完，
   并把成功/失败写进健康状态 —— 下一次搜索会自动把慢源排到后面。
2. **硬截止（9 秒）**：一个结果都没有时会等到这里；仍未返回的源这次不参与结果，
   但会作为「失败」记录（响应里的 `errors`）。

注意软截止只影响「要不要等」，不影响正确性：`errors` 里只会出现**已经失败**的源，
还在后台跑的源既不算成功也不算失败。

## 音源选择策略

- **排序**：可用（`ok`）优先 → 未检测（`unknown`）次之 → 已知失败（`fail`）最后；同档按延迟升序。
- **按分组轮流取源**：Piped / Invidious 都是 `YouTube` 分组，内置了 9 个实例；
  JioSaavn 与 Apple 试听各自独占一个分组。若不轮流取，9 个 YouTube 实例会把
  `MUSIC_SEARCH_SOURCES` 的名额吃光，另外两条音源永远轮不到搜索。
- **健康状态**：启动预热 + 每次搜索/播放的结果都会更新，失败源退避 30 分钟、成功源 10 分钟。
- **启停**：音源管理页可逐个停用，偏好存 `data/music-source-prefs.json`，与内置清单无关，升级不丢。

## 自定义实例

自定义实例存 `data/music-sources.json`，只允许新增 `piped` / `invidious`
（JioSaavn 与 Apple 试听是固定的官方接口）。新增时：

- 地址必须通过出网校验（默认拒绝内网/云元数据地址，防 SSRF）；
- 同主机下不允许出现第二个实例；
- 音源 id 形如 `piped:pipedapi.example.com`，由 `kind` + 主机名组成。

Piped / Invidious 的公开实例可用性波动很大（下线、被 YouTube 限流、被墙都常见），
内置清单只是「常见实例」，建议在音源管理页用「测试」挑出可用的那几个，把其余停用。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/music/sources` | 音源列表（含启停、健康状态；`?check=1` 顺带检测一遍） |
| POST | `/api/music/sources` | 新增自定义实例 `{kind, api, name?}` |
| PUT | `/api/music/sources/:id` | 启用/停用 `{enabled}` |
| POST | `/api/music/sources/:id/check` | 单源健康检测 |
| DELETE | `/api/music/sources/:id` | 删除自定义实例 |
| GET | `/api/music/search` | `?wd=&source=&limit=&perSource=` 聚合搜索 |
| GET | `/api/music/stream` | `?source=&id=` 解析可播放流 |
| GET | `/api/music/match` | `?title=&artists=&duration=` 换源匹配（对应 Spotube 的 matches） |
| GET | `/api/music/image` | `?url=` 封面代理 |
| GET | `/api/music/proxy` | `?url=` 音频透传（支持 Range；m3u8 会被重写） |

`/api/music/search` 的响应里，`results[].key` 是 `<音源 id>:<曲目 id>`，
`errors[]` 逐个列出失败音源与原因，`searched[]` 是本次实际参与的音源。

## 排障

| 现象 | 原因与处理 |
| --- | --- |
| 搜索能出结果但只有「Apple 试听」 | YouTube 系音源不可达：给服务端配 `VOD_HTTP_PROXY`，再到音源管理页「测试」确认 |
| 搜索 9 秒才返回 | 全部音源都不通；配好代理，或停用不可用实例 |
| 播放报错 / 一直转圈 | 音源的直链有效期有限（YouTube 系通常几小时），重新点一次播放即可；仍不行就换一个音源 |
| Piped 报「没有返回音频流」 | 该实例被 YouTube 限流，换一个 Piped 实例 |
| JioSaavn 报「解密失败」 | 官方改了加密方式；此时其它音源不受影响 |

## 关于 Piped / Invidious 的现状（2026-10）

要说清楚一件事：**Spotube 5.x 已经移除了 Piped 与 Invidious**。它现在的内置音频源插件只有
`spotube-plugin-youtube-audio`（走桌面端的 YouTubeEngine：YouTubeExplode / NewPipe / yt-dlp），
Piped / Invidious 只存在于 4.x 及更早版本的 `enum AudioSource { youtube, piped, jiosaavn, invidious }`。

这里仍然保留两者，是因为它们是「Web 侧不依赖子进程就能取到 YouTube 音频」的唯一通路：
Spotube 用的那套内核要么是 Dart 实现，要么得在服务器上装 `yt-dlp` 可执行文件。
但公开实例的实际状态很差 —— 官方实例 `pipedapi.kavin.rocks` 与常用实例大多已下线或被限流，
Piped 项目本身也基本停更。因此：

- 两者默认参与搜索，但**启动预热与每次搜索都会更新健康状态**，不可用的实例会自动退到最后并被排除；
- 想让 YouTube 音源真正可用，更现实的做法是**自建一个 Piped / Invidious 实例**，
  再在音源管理页把它加进来（内置实例可以全部停用）；
- 只想「有声音」而不折腾 YouTube 的话，JioSaavn 与 Apple 试听两条直连音源就够了。

`Piped` / `Invidious` 实例均非本项目所有，仅作为公开接口调用，可用性由对方决定。
