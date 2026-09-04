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
- Windows：自动使用本机 Edge/Chrome
- Linux 服务器：安装浏览器并设置路径：

```bash
# 任选其一：
# 1) 系统安装 Chromium 并指定
BROWSER_PATH=/usr/bin/chromium npm start
# 2) 使用 playwright 自带内核
npm i -D playwright-core && npx playwright-core install chromium
```

首次使用搜片前请确认浏览器可用（`node -e "import('./server/crawler.js').then(m=>console.log(m.findBrowser()))"`）。

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
data/                  m3u 播放列表目录（不入 git，需手动同步）
api/                   Vercel Serverless（仅 /api/proxy、/api/health）
vercel.json            Vercel 构建与路由配置
ecosystem.config.cjs   PM2 配置（可选）
Dockerfile / docker-compose.yml    Docker 部署（可选）
src/lib/m3u.js         m3u / m3u8 解析器（分组/属性/EXTGRP）
src/lib/fetch.js       远程加载与代理降级
src/lib/storage.js     localStorage 封装
src/stores/            播放列表 / 播放器 / 收藏最近 / UI / 登录
src/views/             首页 / 频道列表 / 播放 / 收藏 / 最近 / 搜片 / 设置 / 登录
scripts/test-m3u.mjs   m3u 解析器单元测试
```

## 免责声明

本项目仅提供播放工具，不存储、不转码、不传播任何音视频内容；播放可用性取决于第三方源站。
