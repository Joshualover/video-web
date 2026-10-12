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
| `ytdlp` | yt-dlp | 服务端本机的 `yt-dlp` 可执行文件（Spotube 的 YouTube Engine 之一） | 搜索常可，取流需代理 |
| `piped` | Piped | YouTube 音频，`/search?filter=music_songs` + `/streams/<id>?local=true` | 需要出网代理 |
| `invidious` | Invidious | YouTube 音频，`/api/v1/search` + `/api/v1/videos/<id>?local=true` | 需要出网代理 |
| `jiosaavn` | JioSaavn | 官方 `api.php?__call=search.getResults`，播放地址 DES 解密后直连 `aac.saavncdn.com` | 可直连 |
| `itunes` | Apple 试听 | iTunes Search API 的 30 秒试听片段 | 可直连 |

**YouTube 音频有三条通路，优先用 yt-dlp。** 桌面端 Spotube 也是这么做的：
它的 `YoutubeClientEngine` 有 `youtubeExplode` / `newPipe` / `ytDlp` 三种，
其中前两种是 Dart/Kotlin 实现，Web 侧没有等价物；yt-dlp 是子进程方案，Node 可以直接用。

- **yt-dlp**：只要服务端装了可执行文件就能用，由社区持续跟进 YouTube 的反爬变化，
  是所有方案里最省心的。它与 Piped / Invidious 同属 `YouTube` 分组，
  **装了就自动参与搜索，没装则检测失败、自动被排除** —— 不会拖慢没装它的机器。
  搜索走 `youtubetab:skip=webpage`（直接用 Innertube 搜索接口，比抓搜索网页快近一倍），
  取流会依次尝试 `android_vr → android → ios` 几个 player client。
- **Piped / Invidious**：`local=true` 让实例代取 googlevideo 的地址。
  公开实例现状很差，见文末「现状」一节。

> 注意：Android/iOS 上装的 yt-dlp 无法被服务端调用 —— 本项目跑在服务端，
> 需要的是**服务端那台机器**上的 yt-dlp。
- **JioSaavn** 是 Spotube 内置过的另一条音源，检索接口可用，播放地址是 DES-ECB 加密的，
  解密后即 `aac.saavncdn.com` 上的明文 mp4（多档码率靠改文件名后缀）。
- **Apple 试听不在 Spotube 里**，是本项目补的兜底：YouTube 系音源在国内必须配出网代理，
  没有代理时总得有一条能出声的通路。它只给 30 秒片段（接口里 `preview: true`，界面上标「试听」），
  不想要可以在音源管理页直接停用。

## 装 yt-dlp

```bash
# macOS
brew install yt-dlp
# Debian / Ubuntu
sudo apt install -y yt-dlp
# 任意平台（Python 环境）
python3 -m pip install -U yt-dlp
```

服务端会把 `YTDLP_PATH`（显式指定则只用它）与 `PATH` / 常见安装位置
（`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`~/.local/bin`、`~/Library/Python/3.9/bin`）
里的候选**都问一遍 `--version`，选用版本最高的那个** —— 一台机器上同时装着 pip 的旧版和
brew 的新版很常见，而旧版会拿到被限流的直链。装完后**不必重启服务**，在音源管理页点一次
「测试」即可（失败结果只缓存 1 分钟）。

关于 `PATH`：适配器会把「yt-dlp 自己所在的目录」和几个常见位置**补进子进程的 `PATH`**。
yt-dlp 是按 `PATH` 找 JS runtime（deno）的，而 PM2 / systemd / launchd 起的服务 `PATH`
往往只有 `/usr/bin:/bin` —— 这是「终端里好使、服务里不好使」的经典来源。
deno 装在别处时，在启动配置里显式补：`PATH=/your/deno/bin:$PATH`。

Docker 部署默认不含 yt-dlp（镜像会大一百多 MB）。要装的话，
[README](../README.md#部署要求音乐-youtube-音源) 里有一段可直接粘贴的 Dockerfile 片段。

## 出网代理

YouTube 的媒体地址（googlevideo）在国内被 DNS 污染 + 403，取流需要给**服务端**配代理；
yt-dlp 会自动带上这个代理（`--proxy`）：

```bash
VOD_HTTP_PROXY=http://127.0.0.1:7890   # 与影视源共用同一个代理配置
VOD_NO_PROXY=aac.saavncdn.com          # 需要直连的域名（逗号分隔）
```

也可以写进仓库根目录的 `.env`（`.gitignore` 已排除，`.env.example` 是模板），省得每次手打：

```bash
cp .env.example .env
echo 'VOD_HTTP_PROXY=http://127.0.0.1:7892' >> .env
npm start
```

已存在的真实环境变量优先，不会被 `.env` 覆盖。
代理只影响服务端出网；浏览器始终只跟本站说话（音频也走 `/api/music/proxy`）。

### 播放代理的 Range 兜底（只动开放区间）

有些 CDN 只认「有界 Range」，而浏览器 `<audio>/<video>` 的首发请求恰好是开放区间
`bytes=0-`。播放代理在拿到 4xx 时会先把开放区间收成 1 MiB 的有界区间重试一次，
再退回原来的「换路由」。

**这条兜底只处理开放区间**，不带 Range 与已经是闭区间的一律不动：

| 客户端的请求 | 是否替换 | 原因 |
| --- | --- | --- |
| `bytes=N-`（开放） | 替换成 `bytes=N-(N+1MiB-1)` | 返回更短的 206 是合法的，播放器会接着要下一段 |
| 不带 Range | 不替换 | 客户端要的是整个资源；HLS 的 `.ts` 分片就是这样，给前缀 = 截断的 TS，解码器直接报 DEMUXER_ERROR |
| `bytes=N-M`（闭） | 不替换 | 客户端点名了字节范围（hls.js 的 byte-range 请求），少给会被当成「这一段就这么多」 |

后两种情况宁可明确报 502，也不给坏数据。单元测试见 `scripts/test-hls.mjs`；
端到端（起一台只认有界 Range 的假 CDN）见 `scripts/e2e-hls-range.mjs`。

### yt-dlp 的版本决定 YouTube 能不能整首播完

这是**最容易误判成「代码有 bug」**的一处，把实测过程记在这里。

**症状**：能搜到、能开始播，一小段（约 1 分钟）之后就停，服务端返回 502。
直接量一下就知道是上游在拒绝：

| 请求同一条直链 | 旧版 yt-dlp (2025.10.14) | 新版 yt-dlp (2026.08.19) |
| --- | --- | --- |
| `Range: bytes=0-1048575` | 206 | 206 |
| `Range: bytes=1048576-2097151` | **403** | 206 |
| 换一条全新解出的直链，直接从 1 MiB 处取 | 仍然 403 | 206 |

403 来自 `server: gvs 1.0`（YouTube 的媒体服务器），换 URL、换路由、换请求头都没用；
连 yt-dlp 自己下载也只能拿到 ~500KB。**根因是旧版 yt-dlp 拿到的直链被 YouTube 限流**
（新版客户端 / PO token 流程变了），升级之后就正常了。

新版实测：连续 5 个 1 MiB 分片把 4.91 MB 整首拉完、0 次失败；浏览器里播 318 秒的曲子，
seek 到 150 秒仍然正常播放，代理响应全是 206。

所以：

- **装一个较新的 yt-dlp**（`brew install yt-dlp` 或官方 release 二进制）。本项目的适配器会
  把候选可执行文件都问一遍 `--version`，**自动选用版本最高的那个**，不需要手工指定 ——
  但 `.env` 里的 `YTDLP_PATH` 若显式设了，就以它为准。
- 新版默认就会去找 `deno`（`brew install yt-dlp` 会顺带把它装上）。**不要手工传 `--js-runtimes`**：
  实测默认配置 4/4 都能整段播，显式指定反而偶发限流。
  ⚠️ 但要保证**运行服务的那个进程**能在 `PATH` 里找到 `deno`（Homebrew 装在 `/opt/homebrew/bin`）——
  PM2 / systemd / launchd 起服务时 `PATH` 往往很窄，必要时在启动配置里补上。
- 取流时先不指定 player client（交给 yt-dlp 自己挑），失败才退回 `YTDLP_PLAYER_CLIENTS` 列表。

仍旧建议保留 `VOD_HTTP_PROXY`：不配代理时 googlevideo 直接不可达。
JioSaavn 与 Apple 试听两条直连音源与这些无关，始终可用。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `YTDLP_PATH` | 自动查找 | yt-dlp 可执行文件路径 |
| `YTDLP_PLAYER_CLIENTS` | `android_vr,android,ios` | 默认 client 失败后依次尝试的 player client（YouTube 反爬变化时先调这里） |
| `YTDLP_CONCURRENCY` | `2` | 同时运行的 yt-dlp 进程数上限 |
| `MUSIC_SEARCH_SOURCES` | `6` | 一次聚合搜索最多并搜几个音源（1-20） |
| `MUSIC_SEARCH_DEADLINE` | `15000` | 单次聚合搜索的硬截止（毫秒，2-40 秒） |
| `MUSIC_SEARCH_SOFT_DEADLINE` | `3500` | 已拿到结果就先返回的软截止（毫秒） |
| `MUSIC_MATCH_SOURCES` | `4` | 「换源播放」最多依次尝试几个音源 |
| `MUSIC_WARMUP` | `1` | 启动后异步检测一遍音源；`0` 关闭 |

## 为什么搜索要设两个截止时间

没配代理时，一批 Piped/Invidious 实例都是「连不上、等超时」。如果一定要等所有源结束，
搜索框要转 9 秒。所以聚合搜索有两条线：

1. **软截止（3.5 秒）**：只要已经有源出了结果，就先把结果返回；剩下的源继续在后台跑完，
   并把成功/失败写进健康状态 —— 下一次搜索会自动把慢源排到后面。
2. **硬截止（15 秒）**：一个结果都没有时会等到这里；仍未返回的源这次不参与结果，
   但会作为「失败」记录（响应里的 `errors`）。

**例外：目标里有 yt-dlp 时软截止不生效，直接按硬截止等。**
yt-dlp 一次搜索要 6-15 秒（起进程 + 访问 YouTube），提早返回等于把它的结果静默丢掉。
所以 `/api/music/search` 缺省就是「一次搜完、给全」，硬截止也因此从 9 秒抬到 15 秒。

但界面上不该让搜索框干等十几秒，所以前端把它拆成**两趟**：

| 趟次 | 请求 | 典型耗时 | 结果 |
| --- | --- | --- | --- |
| 第一趟 | `?slow=exclude` | ~1 秒 | JioSaavn / Apple 试听（快源） |
| 第二趟 | `?slow=only` | 6-15 秒 | yt-dlp 的 YouTube 结果，回来后去重并入 |

第二趟期间结果区显示「正在搜索 yt-dlp（本机）…」，不阻塞第一趟的结果。
`slow` 缺省（不传）时仍是单趟搜完，直接调接口的人只发一个请求就能拿全。
不想要这个等待，就在音源管理页停用 yt-dlp。

健康状态的退避也分两档：**主动检测失败**退避 30 分钟（证据强），
**搜索/取流途中的偶发失败**只退避 2 分钟（一次超时不代表源坏了）。

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
| GET | `/api/music/search` | `?wd=&source=&limit=&perSource=&slow=` 聚合搜索；`slow=exclude` 只要快源、`slow=only` 只要慢源、缺省搜全部 |
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
| 音源管理里 yt-dlp 显示「未安装」 | 服务端那台机器上没有 yt-dlp；装完点一次「测试」即可（见上文） |
| yt-dlp 报 `The page needs to be reloaded` | 该 player client 被 YouTube 挡了，调 `YTDLP_PLAYER_CLIENTS` 换一组 |
| yt-dlp 报 `HTTP Error 403` | 拿到了地址但媒体域不可达（国内直连 googlevideo 的典型表现）：配 `VOD_HTTP_PROXY` |
| 能搜到、能开始播，**播一小段就停**（约 1 分钟） | 旧版 yt-dlp 拿到的直链被 YouTube 限流，见上文：升级 yt-dlp（适配器会自动选版本最高的那个） |
| Piped 报 `SignInConfirmNotBotException` | 该实例的 IP 被 YouTube 判为机器人；换实例或改用 yt-dlp |
| 搜索要 10 秒以上 | 目标是等 yt-dlp（它本来就是秒级到十几秒）；不需要 YouTube 结果就停用它 |
| 播放报错 / 一直转圈 | 音源的直链有效期有限（YouTube 系通常几小时），重新点一次播放即可；仍不行就换一个音源 |
| Piped 报「没有返回音频流」 | 该实例被 YouTube 限流，换一个 Piped 实例 |
| JioSaavn 报「解密失败」 | 官方改了加密方式；此时其它音源不受影响 |

## 关于 Piped / Invidious 的现状（2026-10）

要说清楚一件事：**Spotube 5.x 已经移除了 Piped 与 Invidious**。它现在的内置音频源插件只有
`spotube-plugin-youtube-audio`（走桌面端的 YouTubeEngine：YouTubeExplode / NewPipe / yt-dlp），
Piped / Invidious 只存在于 4.x 及更早版本的 `enum AudioSource { youtube, piped, jiosaavn, invidious }`。

这里仍然保留两者，是因为它们属于 Spotube 4.x 的音源集合，且不需要在服务器上装额外程序。
但公开实例的实际状态很差 —— 官方实例 `pipedapi.kavin.rocks` 与常用实例大多已下线或被限流，
Piped 项目本身也基本停更。**要 YouTube 音频，优先装 yt-dlp**；Piped / Invidious 当作补充：

- 两者默认参与搜索，但**启动预热与每次搜索都会更新健康状态**，不可用的实例会被自动排除；
- 想继续用它们的话，更现实的做法是**自建一个实例**再在音源管理页加进来（内置实例可以全部停用）；
- 6 个内置实例全部标记失败时，搜索只会落在 yt-dlp / JioSaavn / Apple 试听上，速度不受影响。

`Piped` / `Invidious` 实例均非本项目所有，仅作为公开接口调用，可用性由对方决定。
