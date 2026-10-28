# 流光播放器

基于 PRD《音视频播放网站开发需求文档（PRD）.md》实现的在线音视频播放网站。支持通过 URL、本地文件或**服务器 data 目录**加载 m3u / m3u8 播放列表，在浏览器中直接播放 HLS 点播与直播流；内置**站内搜片**（搜索并抓取 m3u8，自动并入已有列表）。

## 功能

### 播放与列表
- **服务器 data 目录**：首页自动列出 `data/` 下的 m3u 文件并自动加载第一个，点击可切换加载
- URL 导入、本地文件上传（m3u / m3u8 / txt，≤5MB）、向服务器 data 目录上传（设置页）
- m3u 解析：`EXTINF` 属性、`tvg-logo`、`group-title`、`EXTGRP`、纯 URL 列表，支持「分组按序编号」的文件
- **频道页**（左分组导航 + 右列表）：方块（正方形卡片墙，大小可调）/ 列表（行式虚拟滚动）双视图切换
- 排序（默认 / 名称 A→Z / Z→A）、频道搜索、一键回到顶部、分组栏滚动
- video.js 播放器：播放/暂停、音量、进度、全屏、倍速、画中画、LIVE 标识、音频模式、**自动连播**（点播结束自动下一频道，可关）
- 播放错误区分提示、自动重试一次、断网恢复自动重试
- 键盘快捷键：空格播放/暂停、←→ 快进退 10s、↑↓ 音量、F 全屏、M 静音、N/P 上/下一个频道

### 站内搜片（两阶段）
「搜片」页输入关键词 → ① **搜索并预览结果**（标题列表，勾选/全选）→ ② **抓取所选**：
- 生成新文件到 `data/{关键词}.m3u`，或**并入 data 中已有 m3u**（如 v100.m3u）
- 并入规则：新建/追加「关键词」分组，命名 `序号+标题`，URL 自动去重
- 实时进度（第 X/N 条）、去重报告、完成后一键加载列表
- 站点壳域名失效时自动切换可用域名（无需手动配置）

### 影视聚合（影视）
基于 [awesome-zhuiju-free](https://github.com/laoma2053/awesome-zhuiju-free) 收录的 **TVBox / 影视仓配置地址**，解析出其中的「苹果 CMS」采集接口，聚合成一个可直接点播的影视站：
- **数据源**：配置地址可在「源管理」页增删改、按配置**分组**、启停；自动解析配置里的 `type=1` 苹果 CMS 接口，以及 `type=4` 中 `api` 直接给 http 接口的（部分多仓订阅平台把 CMS 源统一标成 4）；`csp_`/`js:` 这类蜘蛛源依赖 TVBox 内核，Web 端用不了，自动跳过；内置 16 个兜底源
- **内置影视站「Vidhub 影视」（vidhub.tv）**：苹果 CMS 模板站但采集接口已关闭，走专用适配器（`server/vod/vidhub.js`）——**搜索走站点 ajax 联想接口**（`/index.php/ajax/suggest`，绕开带图形验证码的搜索页），列表走 `/vodshow`（72 条/页），播放时解析播放页里的播放器 iframe（`/player/?u=…` → `var config` → 明文 m3u8，无时效参数可长缓存）。站点与媒体 CDN **必须直连**（代理 IP 会被 Cloudflare challenge），适配器已自动登记直连
- **内置短剧源「黄瓜短剧」（hgdju.com）**：非苹果 CMS，走专用适配器（`server/vod/hgdju.js`）——列表 / 详情 / 搜索直接解析站点页面，播放时再实时解析播放页里的 `window.HG_PLAY`（m3u8 带约 7 天有效期的 `auth_key`，所以**不做长期缓存**）；AES-128 加密的清单走本站 HLS 代理（密钥一环也会被重写）。站点域名国内常被墙，需要给服务端配 `VOD_HTTP_PROXY`；对站点做了全局限速（350ms/次）避免被风控
- **分组轮询取源**：聚合搜索与选路按**分组轮流**挑选源，避免某一个多仓订阅（动辄 20+ 源）把搜索名额占满，导致其它分组的源永远搜不到
- **详情/地址兼容**：详情接口先试苹果 CMS V10 的 `ac=detail`，再回退 `ac=videolist&ids`；播放地址自动处理整体 URL 编码（`https%3A%2F%2F…`）与 `url|||播放器参数` 两种写法
- **源健康检测**：一键检测各源可用性，自动切到可用源，源缓存 6 小时
- **配置定时自动刷新**：默认每 6 小时重新抓取配置并做健康检测（`VOD_AUTO_REFRESH_HOURS=0` 可关闭）
- **源级启停**：源管理页列出解析出的每个源，可单独**启用/停用**（停用的源不参与聚合搜索与选路）、可单源测速；偏好存 `data/vod-source-prefs.json`，与配置地址无关，重新抓取配置也不丢
- **出网代理**：设置 `VOD_HTTP_PROXY` 后，抓取配置/CMS 接口/播放代理都走代理，源站被墙时也能用（回环与内网地址自动直连；`VOD_NO_PROXY` 可追加直连域名；`VOD_DIRECT_HOSTS` 可强制某些域名直连）
- **媒体路由自适应**：有的 CDN 必须直连（代理 IP 会被拒），有的偏偏只能走代理。HLS 代理取上游失败时会自动换另一条路由重试，并把成功的路由记住（启动日志/源管理页可见），不用手工维护名单
- **豆瓣热门榜单**（参考 MoonTV / LunaTV 的发现页）：电影 / 剧集 / 综艺 × 分类（热门·最新·豆瓣高分·冷门佳片 / 地区·类型）× 分页，卡片带评分；点封面会自动用「片名＋年份」跨源找片并进详情，找不到会提示换源
- **全源聚合搜索 + 同片多源合并**：默认并发搜所有可用源（`VOD_SEARCH_SOURCES` 可调，默认 30），每个源最多取 8 条避免一个「什么都搜得到」的源占满结果；同名同年的片合并成一张卡并显示「N 个源」
- **分类浏览 + 分页**、**详情 / 线路 / 剧集列表**
- **收藏**独立页：支持**分组**（移动/解散/新建）与**排序**（最近收藏 / 名称 / 年份）
- **播放历史**独立页：支持「**按片聚合** / 全部记录」两种视图，记录播放进度可续播
- **多源同片自动选最快线路**：搜索同片 → 并发测速 → 按可用性与延迟排序；结果**本地缓存 6 小时**（重开秒出，可手动重新测速）；当前线路播放失败时自动切到最快可用线路
- **播放地址解析**：部分源给的是「网页播放页」（如 `/share/xxx`、`/play/xxx`），服务端会解析出真实 m3u8
- **跳过片头片尾**：播放页可开关并设置「片头从第 N 秒开始 / 片尾剩 N 秒跳下一集」，支持「用当前时间」一键记录，按「源＋片」本地记忆
- **首页两个标签页**：「豆瓣热门」与「按源浏览」可切换（记住上次选择）；**最近观看**一行展示带进度的卡片，点击直接续播
- **海报图片代理**：源站海报常有防盗链、或 http 图片在 https 页面被浏览器拦掉，统一走 `/api/vod/image` 取图并长缓存；防盗链策略按「自身域名 → 豆瓣第三方 Referer → 不带 Referer」顺序自动试，成功过的策略按域名记住
- **选路的标题兜底**：采集源对「庆余年 第一季」这类带季数的长标题支持很差，选路时会自动再用去掉季数的短标题搜一遍
- **HLS 代理**：m3u8 清单重写 + 分片透传，解决 Referer 校验与跨域（`/api/vod/hls`）

> 影视数据来自第三方采集接口，本项目不存储、不转码、不传播任何内容；可用性取决于对应源站。仅供本地学习使用。

### 第三方接口（LibreTV 风格顶层 API）

按 [LibreTV](https://github.com/LibreSpark/LibreTV) 的接口契约实现了一层顶层别名（语义重写），第三方 LibreTV 客户端 / TVBox 壳可不改配置直连本站（同样受 `PROXY_TOKEN` / `BASIC_AUTH` / `WEB_LOGIN` 与限流约束）：

| 端点 | 契约 |
| --- | --- |
| `POST /api/search` | `{ wd, sources: [{key,name,url}], filterAdult? }` → `{ list, failures }`；扇出并发 6，源地址逐条过出网校验，成人分类默认过滤，精确命中优先 |
| `GET /api/detail?id=&source={json}` | → `{ episodes: [m3u8…], videoInfo }`（episodes 取首选 m3u8 线路） |
| `GET /api/status` | `{ passwordRequired, verified, version, defaultSources… }`，供客户端 bootstrap |
| `GET /api/hot-list?id=<榜单>` | 豆瓣五个周榜 + 百度热播剧（经 60s API 免 key，主实例失败自动回退官方实例；缓存 1 小时） |
| `GET /api/bangumi/calendar` | Bangumi 每日追番日历，按星期 1-7 分组（缓存 30 分钟） |
| `GET /api/source-list?url=<订阅>` | 订阅三格式自动识别：TVBox 配置 / LibreTV-SourceList / 接口目录；`csp_`/XML/txt 等 Web 端用不了的条目跳过并计入 `stats`（混用 `baseUrl` 与 `url` 明确报错，绝不静默丢一半） |

### 音乐（Spotube 音源）
按 [Spotube](https://github.com/team-spotube/spotube) 的音源模型新增的「音乐」板块：搜索曲目 → 在线播放 → 管理音源。
Spotube 把「曲目元数据」和「音频来源」拆成两个可插拔角色，音频源插件只实现
`supportedPresets` / `matches(track)` / `streams(match)` 三件事；本项目把后两件落成
`/api/music/match` 与 `/api/music/stream`，只是省掉了 Spotify 那一步（搜索直接打在音源上，**不需要任何密钥**）。

- **内置音源**（五种，见 [docs/music-sources.md](docs/music-sources.md)）：
  - **yt-dlp**（推荐）：走服务端本机的 `yt-dlp` 可执行文件，对应 Spotube 的
    `YoutubeClientEngine.ytDlp`。桌面端那套 Dart/Kotlin 内核（youtubeExplode / newPipe）
    在 Web 侧没有等价物，yt-dlp 是子进程方案、Node 直接可用，也最跟得上 YouTube 的反爬变化。
    **装了就参与搜索，没装则检测失败自动排除**，不拖慢没装它的机器。
    它一次搜索要 6-15 秒，所以前端把搜索拆成**两趟**：快源先出结果，YouTube 结果回来后再并入
  - **Piped** / **Invidious**：Spotube 4.x 音源在 Web 侧的等价实现，走公开的 YouTube 前端 API 实例，
    `local=true` 让实例代取 googlevideo 地址。公开实例如今大面积失效，**要 YouTube 音频优先装 yt-dlp**
  - **JioSaavn**：Spotube 内置过的另一条音源，可直连；播放地址是 DES-ECB 加密的，
    服务端自带一份纯 JS 解密（Node 18+ 的 OpenSSL 3 默认不加载 legacy provider，`des-ecb` 用不了）
  - **Apple 试听**：兜底音源（不在 Spotube 里），iTunes 30 秒片段，没配代理时也能出声，界面上标「试听」
- **取流要代理**：YouTube 的媒体域（googlevideo）在国内被 DNS 污染，取流需要给服务端配
  `VOD_HTTP_PROXY`（yt-dlp 会自动带上）；JioSaavn 与 Apple 试听可直连。
  **另外要用较新的 yt-dlp**：实测旧版（2025.10）拿到的直链会被 YouTube 限流成「只给前 1MiB」，
  表现为播一小段就停；新版（2026.08）正常整首播完。适配器会自动选用版本最高的那份可执行文件，
  详见 [docs/music-sources.md](docs/music-sources.md)
- **聚合搜索**：一次并搜多个音源，结果按源轮流交错返回，每个源最多取 10 条，避免某个源占满名单；
  失败的源单独列在 `errors` 里（例如「出网代理没配」），不影响其它源出结果
- **两趟搜索**（前端）：第一趟 `slow=exclude` 只问快源，通常 1 秒内铺出结果；
  第二趟 `slow=only` 单独问 yt-dlp，回来了再去重并入，期间结果区显示「正在搜索 yt-dlp…」。
  不这么拆的话，开着 yt-dlp 的搜索框每次都要干等十几秒
- **两个截止时间**（单次聚合搜索内部）：软截止 3.5 秒（已拿到结果就先返回，慢源继续在后台跑完
  并更新健康状态）、硬截止 15 秒。没配代理时一批实例都在等超时，没有软截止搜索框要转很久。
  目标里有慢音源（yt-dlp）时软截止不生效 —— 直接调接口的人应当拿到完整结果，
  而不是被静默丢掉一部分
- **按分组轮流取源**：内置 6 个 YouTube 实例，若不轮流取，它们会把搜索名额吃光，
  JioSaavn 与 Apple 试听永远轮不到
- **音源健康检测 + 排序**：启动异步预热，可用源优先；主动检测失败退避 30 分钟，
  搜索/取流途中的偶发失败只退避 2 分钟（一次超时不代表源坏了）；音源管理页可逐个「测试」
- **音源级启停 / 自定义实例**：偏好存 `data/music-source-prefs.json`；自定义 Piped / Invidious 实例存
  `data/music-sources.json`，新增时先过出网校验（防 SSRF），只允许删自己加的
- **换源播放**：只知道曲名/艺术家时（收藏、历史恢复），逐源找最像的一首并直接返回可播流
- **播放器**：原生 `<audio>`，播放队列、上一首/下一首、进度拖拽、音量、记忆音量；封面走 `/api/music/image`，
  音频走 `/api/music/proxy`（Range 透传，m3u8 会被重写）
- **收藏 / 历史**：本地保存，可点击直接播放

环境变量：

```bash
YTDLP_PATH=/usr/local/bin/yt-dlp  # yt-dlp 路径（默认自动查找 PATH 与常见安装位置）
YTDLP_PLAYER_CLIENTS=android_vr,android,ios   # 依次尝试的 player client
YTDLP_CONCURRENCY=2               # 同时运行的 yt-dlp 进程数上限
MUSIC_SEARCH_SOURCES=6            # 一次聚合搜索最多并搜几个音源（1-20）
MUSIC_SEARCH_DEADLINE=15000       # 硬截止（毫秒）
MUSIC_SEARCH_SOFT_DEADLINE=3500   # 软截止（毫秒，已拿到结果就先返回）
MUSIC_MATCH_SOURCES=4             # 换源播放最多依次试几个音源
MUSIC_WARMUP=1                    # 启动后异步检测一遍音源，0 关闭
```

> 音频来自第三方公开接口（yt-dlp 拉取的 YouTube / JioSaavn / iTunes），本项目不存储、不转码、不传播内容；
> Piped / Invidious 实例均非本项目所有，可用性由对方决定。仅供本地学习使用。

### 其他
- 登录保护：默认账号 `admin` / 密码 `admin123`（设置页可修改、退出）。**注意这只是本地 UI 门槛**：口令与登录态都只存在浏览器 localStorage，服务端不校验它，不能当作访问控制
- 白天/夜晚主题切换（顶部太阳/月亮按钮，跟随系统默认，记住选择）
- 收藏、最近播放独立页面（各存 localStorage，可导出/导入 JSON 备份跨设备迁移）
- 多播放列表管理（保存常用 URL，10 个）
- 响应式：桌面固定布局、平板抽屉、移动端分组 Tab + 频道列表

## 服务器 data 目录

`data/` 目录放置 m3u/m3u8 文件即出现在首页「服务器目录」。注意：
- **`data/` 在 .gitignore 中，不随 git 推送**——服务器部署需手动同步该目录，或用网页「上传 m3u」功能
- 服务器启动时自动创建 `data/`（不存在时）
- 首页自动加载文件按文件名排序的第一个

## 影视源环境变量

本机无法直连某些源站（域名被污染/封锁）时，给服务端配一个 HTTP 代理即可，抓取配置、CMS 接口、播放代理（m3u8 / 分片）都会走它：

```bash
# 启动服务时带上（http:// 与 https:// 代理都支持，可带账号密码）
VOD_HTTP_PROXY=http://127.0.0.1:7890 npm start

# 多个直连白名单
VOD_HTTP_PROXY=http://127.0.0.1:7890 VOD_NO_PROXY=.example.com,10.0.0.5 npm start
```

嫌每次手打环境变量麻烦的话，复制 `.env.example` 为 `.env` 即可（`.env` 在 `.gitignore` 中，不进版本库）：

```bash
cp .env.example .env
# 编辑 .env：VOD_HTTP_PROXY=http://127.0.0.1:7890
npm start
```

`.env` 的解析刻意做得很简单：`KEY=value`、`#` 注释、值可用单双引号包起来，不支持变量展开；
**命令行 / PM2 / Docker 上显式传的环境变量优先**，不会被 `.env` 覆盖。

说明：
- 也兼容标准的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（以及小写形式）
- `localhost`、回环和 `192.168.x.x` / `10.x.x.x` / `172.16-31.x.x` 等内网地址**自动直连**，不受影响
- 只支持 http/https 代理（socks5 会提示忽略）；不支持 Vercel Serverless 环境
- 不配置时行为与以前完全一致（全部直连）
- 源管理页会显示当前代理状态
- 音乐源共用同一份代理配置：Piped / Invidious（YouTube 音频）与影视源一样需要它，JioSaavn 与 Apple 试听可直连

## 代理与安全环境变量

### 出网校验（SSRF 防护）

服务端**所有**出网请求都会先校验目标地址：`/api/proxy`、播放地址解析 `/api/vod/play`、HLS 代理 `/api/vod/hls`、图片代理 `/api/vod/image`、影视源配置抓取、站内搜片，以及每一次 HTTP 重定向。

- 默认拒绝：`localhost`、回环、内网网段（含 `169.254.169.254` 云元数据、`100.64.0.0/10`、`198.18.0.0/15`、IPv4-mapped IPv6 等）与非 http/https 协议
- 校验发生在**建立连接之前**（DNS 解析后立即判断），不是「请求发出去再丢弃响应」

局域网/IPTV 这类**确实需要服务端直连内网**的场景，显式打开开关（开启后上述内网限制全部放行）：

```bash
ALLOW_PRIVATE_NETWORK=true npm start
```

上游证书默认校验；只有源站使用自签名证书时才降级（会降低安全性，尽量只对受信任源使用）：

```bash
ALLOW_INSECURE_TLS=true npm start
```

### 访问令牌（PROXY_TOKEN）

用于挡住随机扫描器：设置后所有 `/api` 接口都要求 `Authorization: Bearer <token>`（或 `?token=`）：

```bash
PROXY_TOKEN=your-secret-token npm start
# 前端构建时注入同名令牌，页面才能访问接口（可选）
VITE_PROXY_TOKEN=your-secret-token npm run build
```

> ⚠️ **令牌不是授权边界**：`VITE_PROXY_TOKEN` 会被编译进前端产物，任何访客都能从 JS 里读出来；
> 前端「登录」（默认 `admin` / `admin123`）也只是本地 UI 门槛。公网部署请用反向代理
> （Nginx/Caddy/1Panel 的 Basic Auth、OAuth 等）保护整个站点。

### 跨域（CORS）

默认只服务同源页面（前端由本服务托管时天然同源）。需要让其它站点/设备跨源调用接口时显式放行：

```bash
CORS_ORIGIN="*"                                          # 放行所有来源（不推荐）
CORS_ORIGIN="https://a.example,http://192.168.1.9:5173"  # 白名单
```

### 监听地址（HOST）

默认监听 `0.0.0.0`，局域网设备可直接访问。公网部署建议只监听回环、交给反向代理：

```bash
HOST=127.0.0.1 npm start
```

未设置 `PROXY_TOKEN` 且监听非回环地址时，启动日志会打印安全提示。

### 整站鉴权（BASIC_AUTH，可选）

前端的「登录」只是本地 UI 门槛（口令与登录态都存在浏览器 localStorage 里，**服务端不校验它**）。要真正挡住未授权访问，两种做法：

```bash
# 1) 交给反向代理（Nginx / Caddy / 1Panel 的 Basic Auth、OAuth 等）——推荐
# 2) 让本服务自己把关：整站（页面 + /api）都要 Basic 认证
BASIC_AUTH="user:pass" npm start
```

`/api/health` 例外（便于探活）；已配置 `PROXY_TOKEN` 时，带有效 Bearer 令牌的请求同样放行。

### 服务端会话登录（WEB_LOGIN，可选）

前端的「登录」默认只是本地 UI 门槛。设置 `WEB_LOGIN="user:pass"` 后改为**服务端会话**：
登录成功下发 `HttpOnly` + `SameSite=Lax` 的签名 Cookie，`/api` 全部需要它
（`/api/health` 与登录、登出、会话探测例外）。Cookie 对同源请求自动生效，
所以 `<video>` / `<img>` 这类发不出自定义头的请求也能正常工作——这是它比 `PROXY_TOKEN` 更适合浏览器场景的地方。

```bash
WEB_LOGIN="admin:换成你的口令" npm start
COOKIE_SECURE=1        # 走 HTTPS 时加上，让 Cookie 只经 https 传输
SESSION_SECRET=随机长串 # 可选：不设则用口令派生（改口令即让所有会话失效）
```

与 `PROXY_TOKEN` / `BASIC_AUTH` 可共存：任一方式认证通过，都不会再被令牌挡。

### 限流与抓取任务护栏

- **按 IP 限流**：普通接口默认 600 次/分钟；「放大型」接口（全源搜索、选路、全量刷新、源检测、站内抓取）
  默认 30 次/分钟；登录接口默认 10 次/分钟（防爆破）。超限返回 `429` 与 `Retry-After`。
  可用 `RATE_LIMIT_PER_MIN` / `RATE_LIMIT_HEAVY_PER_MIN` / `RATE_LIMIT_LOGIN_PER_MIN`
  调整，设 `0` 关闭。部署在反向代理后面、需要真实客户端 IP 时设 `TRUST_PROXY=1`
  （仅在反代会覆盖 `X-Forwarded-For` 时才安全）。
- **站内搜片是单任务**：同一时刻只允许一个搜索/抓取任务，重复提交返回 `409`。单任务默认 20 分钟上限
  （`CRAWL_TASK_MAX_MS`），到点会协作式终止并释放任务锁，避免一次卡死让搜片对所有人不可用；
  已完成任务默认保留 30 分钟（`CRAWL_TASK_TTL_MS`）。单个详情页脚本执行默认 20 秒超时
  （`CRAWL_EVAL_TIMEOUT_MS`）。

## 本地开发

```bash
npm install
npm run dev
```

- 前端：http://localhost:5173（`/api` 代理到 8787）
- 完整服务：http://localhost:8787（生产模式 `npm run build && npm start`）

## 部署要求（搜片功能）

「站内搜片」需要**真实浏览器内核**（站点反爬校验 TLS 指纹，curl 会被拒）：
- Windows：自动使用本机 Edge/Chrome，无需配置
- Linux 服务器：任选其一

```bash
# 方式一（推荐）：用 playwright 安装 chromium，crawler 会自动找到，无需设路径
cd /opt/video-web
npm i playwright-core
npx playwright-core install chromium --with-deps   # --with-deps 自动装系统依赖（需 root）

# 方式二：系统包安装后设置 BROWSER_PATH
# Debian/Ubuntu: apt install -y chromium && BROWSER_PATH=/usr/bin/chromium
```

验证是否可用：
```bash
node -e "import('./server/crawler.js').then(m=>console.log('浏览器:', m.findBrowser()))"
```

> `playwright-core` 与系统包二选一即可；crawler 会依次探测 `BROWSER_PATH` → 系统 Chrome/Chromium → playwright 缓存目录。

## 部署要求（音乐 YouTube 音源）

「音乐」板块里 Piped / Invidious 是纯 HTTP 调用，装不装东西都能跑；**yt-dlp 需要服务端有可执行文件**，
而且要**足够新**（旧版会被 YouTube 限流成「只给前 1MiB」，表现为播一小段就停）：

```bash
# 方式一：Homebrew（macOS，会顺带装上 deno）
brew install yt-dlp

# 方式二：Debian / Ubuntu
sudo apt install -y yt-dlp

# 方式三：任意平台（也会带上 deno 作为 JS runtime）
python3 -m pip install -U yt-dlp
```

验证是否可用（适配器会**自动选用版本最高的那个**，可从版本号确认）：

```bash
curl -sS http://127.0.0.1:8787/api/music/sources/ytdlp/check -X POST
# 期望：{"ok":true,"status":"ok","version":"yt-dlp 2026.08.19", ...}
```

⚠️ **服务进程的 `PATH` 要能找到 `deno`**。yt-dlp 是按 `PATH` 找 JS runtime 的，
而 PM2 / systemd / launchd 起的服务 `PATH` 往往只有 `/usr/bin:/bin` ——
同一个 yt-dlp 在终端里好使、在服务里就不好使。适配器已经会把「yt-dlp 自己所在的目录」
和 `/opt/homebrew/bin`、`/usr/local/bin` 等常见位置补进子进程的 `PATH`；
若 deno 装在别处，在启动配置里显式补上：

```js
// ecosystem.config.cjs
env: { PATH: `/opt/homebrew/bin:${process.env.PATH}` }
```

Docker 部署默认**不含** yt-dlp（镜像会大一百多 MB），需要时在运行阶段加：

```dockerfile
# 在 Dockerfile 的运行阶段追加（Alpine 用 musl 版静态二进制）
RUN apk add --no-cache curl xz \
 && curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_musllinux \
 && chmod +x /usr/local/bin/yt-dlp \
 && curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
 && unzip -o /tmp/deno.zip -d /usr/local/bin && chmod +x /usr/local/bin/deno && rm /tmp/deno.zip \
 && apk del curl xz
```

> 以上 Dockerfile 片段未经本机验证（开发机没有 Docker），只是把上面几条安装命令翻译成
> 容器里的写法；镜像架构不是 x86_64 时记得换成对应的 deno 包名。

## Vercel 一键部署

内置 `vercel.json` 与 `api/` Serverless Function，可直接部署（仅静态托管 + `/api/proxy`，**不含搜片**，搜片需自有服务器）：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FJoshualover%2Fvideo-web)

环境变量：`ALLOW_PRIVATE_NETWORK=false`、`ALLOW_INSECURE_TLS=false`、`PROXY_TOKEN`、`VITE_PROXY_TOKEN`（`ALLOW_PRIVATE_NETWORK`/`ALLOW_INSECURE_TLS` 现在已是默认值，显式写上只为便于审阅）。

## 1Panel 部署（自有服务器，推荐）

后端为 Node.js（Express），使用 1Panel 的 **Node.js 运行环境**即可：

1. 1Panel → 运行环境 → Node.js → 安装 Node 20
2. 服务器：`git clone https://github.com/Joshualover/video-web.git && cd video-web && npm install && npm run build`
3. 1Panel → 网站 → Node 项目 → 创建：源码目录 /opt/video-web、启动文件 `server/index.js`、端口 8787、Node 版本 20
4. 环境变量：`PORT=8787`、`HOST=127.0.0.1`（反代在本机，公网只需暴露 443）；搜片需 `BROWSER_PATH`（见上）。如果媒体地址在内网（局域网 IPTV 等）再加 `ALLOW_PRIVATE_NETWORK=true`；源站自签名证书再加 `ALLOW_INSECURE_TLS=true`
5. 绑定域名 + HTTPS（Let's Encrypt 自动反代到 127.0.0.1:8787）

Docker 方式：仓库含 `Dockerfile` / `docker-compose.yml`（`data/` 已声明为挂载卷，容器重建不丢数据）。镜像内**不含** Chromium，所以容器里的「站内搜片」不可用；需要时在运行阶段镜像里自行安装 chromium 并设置 `BROWSER_PATH`（参考上面「部署要求（搜片功能）」）。

## 目录结构

```text
server/index.js        Express：静态托管 + 代理 + data 播放列表 + 搜片任务接口
server/proxy-core.js   代理核心逻辑（Express 与 Vercel Serverless 共用）
server/crawler.js      站内搜片爬虫（搜索/抓取/并入 m3u，壳域名自动切换）
server/vod/sources.js            影视源管理（解析 TVBox 配置 + 健康检测 + 缓存）
server/vod/config-store.js       配置地址持久化（data/vod-configs.json）
server/vod/maccms.js             苹果 CMS 采集接口封装
server/vod/hls.js                播放地址解析 + HLS 代理（清单重写/分片透传/测速）
server/vod/best.js               多源同片选路（搜索 + 测速排序）
server/vod/default-configs.json  默认配置地址
server/vod/fallback-sources.json 内置兜底影视源
server/music/routes.js          /api/music/* 路由（搜索 / 取流 / 匹配 / 音源管理）
server/music/sources.js         音乐源注册表（内置 + 自定义实例、启停、健康检测、分来源轮询）
server/music/query.js           音乐查询入口（聚合搜索、换源匹配、曲目字段归一化）
server/music/ytdlp.js           yt-dlp 适配器（YouTube 音频，走服务端本机可执行文件）
server/music/piped.js           Piped 适配器（YouTube 音频，Spotube 4.x 音源）
server/music/invidious.js       Invidious 适配器（YouTube 音频）
server/music/jiosaavn.js        JioSaavn 适配器（播放地址 DES 解密 + 多档码率）
server/music/itunes.js          iTunes 试听适配器（30 秒片段，兜底音源）
server/music/des.js             纯 JS 的 DES-ECB 解密（Node 的 OpenSSL 3 不带 legacy provider）
server/music/http.js            音乐源出网封装（复用影视源的出口校验 + 代理）
server/music/default-sources.json 内置音乐源实例清单
server/env.js                   读取根目录 .env（真实环境变量优先，不引入 dotenv）
.env.example                    环境变量模板（复制成 .env 使用，.env 不进版本库）
data/                  m3u 播放列表目录（不入 git，需手动同步）
api/                   Vercel Serverless（仅 /api/proxy、/api/health）
vercel.json            Vercel 构建与路由配置
ecosystem.config.cjs   PM2 配置（可选）
Dockerfile / docker-compose.yml    Docker 部署（可选）
src/lib/m3u.js         m3u / m3u8 解析器（分组/属性/EXTGRP）
src/lib/fetch.js       远程加载与代理降级
src/lib/storage.js     localStorage 封装
src/lib/vod.js         影视接口客户端
src/lib/music.js       音乐接口客户端
src/stores/            播放列表 / 播放器 / 收藏最近 / UI / 登录 / 影视(源/收藏/历史/配置) / 音乐(源/队列/收藏/历史)
src/components/VodNav.vue  影视子导航
src/components/MusicNav.vue 音乐子导航
src/components/MusicPlayer.vue 音乐播放条 + 播放队列
src/views/             首页 / 频道列表 / 播放 / 收藏 / 最近 / 搜片 / 设置 / 登录 / 影视(发现/详情/播放/收藏/历史/源管理) / 音乐(搜索 / 音源管理)
scripts/test-m3u.mjs   m3u 解析器单元测试
scripts/test-music.mjs 音乐源单元测试（DES 测试向量 / 各音源字段归一化 / 选源策略）
scripts/test-hls.mjs  播放代理的 Range 处理测试（开放区间收成有界区间）
scripts/test-env.mjs  .env 解析测试
scripts/e2e-hgd.mjs            内置短剧源（黄瓜短剧）端到端测试
scripts/e2e-vidhub.mjs         内置影视站（Vidhub）端到端测试
scripts/e2e-vod.mjs            影视流程端到端测试（需本机 Edge/Chrome）
scripts/e2e-vod-features.mjs   收藏/历史/源管理/选路 端到端测试
scripts/e2e-vod-features2.mjs  收藏分组/历史聚合/选路缓存 端到端测试
scripts/e2e-music.mjs          音乐源端到端测试（API 层，自己拉实例，不需要浏览器）
scripts/e2e-hls-range.mjs      播放代理 Range 兜底端到端测试（起一台「只认有界 Range」的假 CDN）
docs/code-review-2026-10.md    本轮安全加固与修复记录（问题清单 / 环境变量速查 / 上线检查清单）
docs/music-sources.md          音乐源模型 / 内置音源 / 出网代理 / 环境变量 / 接口 / 排障
```

> e2e 脚本会自动探测本机 Edge/Chrome（也可用 `EDGE_PATH` / `CHROME_PATH` 指定）；
> 部署启用了 `WEB_LOGIN` 时需要额外提供 `LOGIN_USER` / `LOGIN_PASS`。

## 免责声明

本项目仅提供播放工具，不存储、不转码、不传播任何音视频内容；播放可用性取决于第三方源站。

## 变更记录

本轮安全加固与修复的完整记录（问题清单与对应提交、环境变量速查、上线检查清单、已知取舍）见
[docs/code-review-2026-10.md](docs/code-review-2026-10.md)。
