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
- **分组轮询取源**：聚合搜索与选路按**分组轮流**挑选源，避免某一个多仓订阅（动辄 20+ 源）把搜索名额占满，导致其它分组的源永远搜不到
- **详情/地址兼容**：详情接口先试苹果 CMS V10 的 `ac=detail`，再回退 `ac=videolist&ids`；播放地址自动处理整体 URL 编码（`https%3A%2F%2F…`）与 `url|||播放器参数` 两种写法
- **源健康检测**：一键检测各源可用性，自动切到可用源，源缓存 6 小时
- **配置定时自动刷新**：默认每 6 小时重新抓取配置并做健康检测（`VOD_AUTO_REFRESH_HOURS=0` 可关闭）
- **源级启停**：源管理页列出解析出的每个源，可单独**启用/停用**（停用的源不参与聚合搜索与选路）、可单源测速；偏好存 `data/vod-source-prefs.json`，与配置地址无关，重新抓取配置也不丢
- **出网代理**：设置 `VOD_HTTP_PROXY` 后，抓取配置/CMS 接口/播放代理都走代理，源站被墙时也能用（回环与内网地址自动直连；`VOD_NO_PROXY` 可追加直连域名）
- **豆瓣热门榜单**（参考 MoonTV / LunaTV 的发现页）：电影 / 剧集 / 综艺 × 分类（热门·最新·豆瓣高分·冷门佳片 / 地区·类型）× 分页，卡片带评分；点封面会自动用「片名＋年份」跨源找片并进详情，找不到会提示换源
- **全源聚合搜索 + 同片多源合并**：默认并发搜所有可用源（`VOD_SEARCH_SOURCES` 可调，默认 30），每个源最多取 8 条避免一个「什么都搜得到」的源占满结果；同名同年的片合并成一张卡并显示「N 个源」
- **分类浏览 + 分页**、**详情 / 线路 / 剧集列表**
- **收藏**独立页：支持**分组**（移动/解散/新建）与**排序**（最近收藏 / 名称 / 年份）
- **播放历史**独立页：支持「**按片聚合** / 全部记录」两种视图，记录播放进度可续播
- **多源同片自动选最快线路**：搜索同片 → 并发测速 → 按可用性与延迟排序；结果**本地缓存 6 小时**（重开秒出，可手动重新测速）；当前线路播放失败时自动切到最快可用线路
- **播放地址解析**：部分源给的是「网页播放页」（如 `/share/xxx`、`/play/xxx`），服务端会解析出真实 m3u8
- **跳过片头片尾**：播放页可开关并设置「片头从第 N 秒开始 / 片尾剩 N 秒跳下一集」，支持「用当前时间」一键记录，按「源＋片」本地记忆
- **首页两个标签页**：「豆瓣热门」与「按源浏览」可切换（记住上次选择）；**最近观看**一行展示带进度的卡片，点击直接续播
- **海报图片代理**：源站海报常有防盗链、或 http 图片在 https 页面被浏览器拦掉，统一走 `/api/vod/image` 取图并长缓存
- **选路的标题兜底**：采集源对「庆余年 第一季」这类带季数的长标题支持很差，选路时会自动再用去掉季数的短标题搜一遍
- **HLS 代理**：m3u8 清单重写 + 分片透传，解决 Referer 校验与跨域（`/api/vod/hls`）

> 影视数据来自第三方采集接口，本项目不存储、不转码、不传播任何内容；可用性取决于对应源站。仅供本地学习使用。

### 其他
- 登录保护：默认账号 `admin` / 密码 `admin123`（设置页可修改、退出）
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

说明：
- 也兼容标准的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（以及小写形式）
- `localhost`、回环和 `192.168.x.x` / `10.x.x.x` / `172.16-31.x.x` 等内网地址**自动直连**，不受影响
- 只支持 http/https 代理（socks5 会提示忽略）；不支持 Vercel Serverless 环境
- 不配置时行为与以前完全一致（全部直连）
- 源管理页会显示当前代理状态

## 代理环境变量

内网访问默认开启。如需恢复 SSRF 防护（拒绝 localhost / 内网 IP）：

```bash
ALLOW_PRIVATE_NETWORK=false npm start
```

内网 HTTPS 服务常使用自签名证书，默认已跳过证书校验（`ALLOW_INSECURE_TLS=true`）。如需强制校验证书：

```bash
ALLOW_INSECURE_TLS=false npm start
```

公网部署建议为接口设置访问令牌（否则任何网站都能借用代理，且搜索/上传接口可被他人调用）：

```bash
PROXY_TOKEN=your-secret-token npm start
# 前端构建时注入同名令牌（可选）
VITE_PROXY_TOKEN=your-secret-token npm run build
```

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

## Vercel 一键部署

内置 `vercel.json` 与 `api/` Serverless Function，可直接部署（仅静态托管 + `/api/proxy`，**不含搜片**，搜片需自有服务器）：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FJoshualover%2Fvideo-web)

环境变量：`ALLOW_PRIVATE_NETWORK=false`、`PROXY_TOKEN`、`VITE_PROXY_TOKEN`。

## 1Panel 部署（自有服务器，推荐）

后端为 Node.js（Express），使用 1Panel 的 **Node.js 运行环境**即可：

1. 1Panel → 运行环境 → Node.js → 安装 Node 20
2. 服务器：`git clone https://github.com/Joshualover/video-web.git && cd video-web && npm install && npm run build`
3. 1Panel → 网站 → Node 项目 → 创建：源码目录 /opt/video-web、启动文件 `server/index.js`、端口 8787、Node 版本 20
4. 环境变量：`PORT=8787`、`ALLOW_PRIVATE_NETWORK=true`、`ALLOW_INSECURE_TLS=true`；搜片需 `BROWSER_PATH`（见上）
5. 绑定域名 + HTTPS（Let's Encrypt 自动反代到 127.0.0.1:8787）

Docker 方式：仓库含 `Dockerfile` / `docker-compose.yml`（构建阶段需含浏览器：请参考 Dockerfile 注释自行添加 chromium 安装层）。

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
data/                  m3u 播放列表目录（不入 git，需手动同步）
api/                   Vercel Serverless（仅 /api/proxy、/api/health）
vercel.json            Vercel 构建与路由配置
ecosystem.config.cjs   PM2 配置（可选）
Dockerfile / docker-compose.yml    Docker 部署（可选）
src/lib/m3u.js         m3u / m3u8 解析器（分组/属性/EXTGRP）
src/lib/fetch.js       远程加载与代理降级
src/lib/storage.js     localStorage 封装
src/lib/vod.js         影视接口客户端
src/stores/            播放列表 / 播放器 / 收藏最近 / UI / 登录 / 影视(源/收藏/历史/配置)
src/components/VodNav.vue  影视子导航
src/views/             首页 / 频道列表 / 播放 / 收藏 / 最近 / 搜片 / 设置 / 登录 / 影视(发现/详情/播放/收藏/历史/源管理)
scripts/test-m3u.mjs   m3u 解析器单元测试
scripts/e2e-vod.mjs            影视流程端到端测试（需本机 Edge/Chrome）
scripts/e2e-vod-features.mjs   收藏/历史/源管理/选路 端到端测试
scripts/e2e-vod-features2.mjs  收藏分组/历史聚合/选路缓存 端到端测试
```

## 免责声明

本项目仅提供播放工具，不存储、不转码、不传播任何音视频内容；播放可用性取决于第三方源站。
