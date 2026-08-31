# 流光播放器

基于 PRD《音视频播放网站开发需求文档（PRD）.md》实现的在线音视频播放网站。支持通过 URL 或本地文件加载 m3u / m3u8 播放列表，在浏览器中直接播放 HLS 点播与直播流。

## 功能

- URL 导入与本地文件上传（m3u / m3u8 / txt，单文件 ≤ 5MB）
- m3u 扩展标签解析：`EXTINF` 属性、`tvg-logo`、`group-title`、`EXTGRP`、纯 URL 列表
- 分组导航、分组搜索、频道搜索、大列表虚拟滚动（>200 频道自动窗口化）
- video.js 播放器：播放/暂停、音量、进度、全屏、倍速、画中画、LIVE 标识、音频模式
- 播放错误区分处理、自动重试一次、断网恢复自动重试
- 最近播放（20 条）、收藏（100 个）、多播放列表管理（10 个），全部存于 localStorage
- 响应式布局：桌面侧栏、平板抽屉、移动端分组 Tab + 下方频道列表
- 键盘快捷键：空格播放/暂停、左右快进退 10s、上下音量、F 全屏、M 静音、N 下一个频道
- Express CORS 代理（10s 超时、10MB 上限、支持任意端口与内网资源）

内网访问默认开启。如需恢复 SSRF 防护（拒绝 localhost / 内网 IP），启动时设置环境变量：

```bash
ALLOW_PRIVATE_NETWORK=false npm start
```

内网 HTTPS 服务常使用自签名证书，默认已跳过证书校验（`ALLOW_INSECURE_TLS=true`）。如需强制校验证书：

```bash
ALLOW_INSECURE_TLS=false npm start
```

公网部署时建议为代理接口设置访问令牌（否则任何网站都能借用该代理转发请求）：

```bash
PROXY_TOKEN=your-secret-token npm start
# 前端构建时注入同名令牌（可选，设置了才能通过代理加载）
VITE_PROXY_TOKEN=your-secret-token npm run build
```

## 本地开发

```bash
npm install
npm run dev
```

- 前端：http://localhost:5173
- 代理接口：http://localhost:8787/api/proxy?url=...

Vite 开发服务器会把 `/api` 转发到 Express 代理服务。

## 生产运行

```bash
npm run build
npm start
```

Express 会同时托管 `dist` 静态文件与 `/api/proxy` 接口，访问 http://localhost:8787 即可。

## Vercel 一键部署

项目已内置 `vercel.json` 与 `api/` 下的 Serverless Function，可直接部署到 Vercel：

1. 点击下方按钮（需登录 Vercel 并授权 GitHub 仓库）：

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FJoshualover%2Fvideo-web)

2. 或在 Vercel 控制台 Import 该仓库：框架选 **Other**，构建命令 `npm run build`，输出目录 `dist`（`vercel.json` 已配置，通常无需手动改）。

3. 需要时在项目 Settings → Environment Variables 中配置：
   - `ALLOW_PRIVATE_NETWORK=false` — 公网部署建议开启 SSRF 防护（拒绝内网地址）
   - `ALLOW_INSECURE_TLS=true` — 跳过自签名证书校验（默认已开启）
   - `PROXY_TOKEN=your-secret` — 为代理接口设置访问令牌，防止被他人借用
   - `VITE_PROXY_TOKEN=your-secret` — 构建时注入，前端通过代理加载时会自动携带令牌（需与 `PROXY_TOKEN` 一致）

> 部署后前端为 Vercel CDN 静态托管，`/api/proxy` 由 Serverless Function 提供，无需自建服务器。

## 1Panel 部署（自有服务器）

项目后端为纯 Node.js（Express），**使用 1Panel 的 Node.js 运行环境即可**，无需 Docker、无需数据库。

### 方式一：Node.js 运行环境（推荐）

**1. 安装 Node 环境**

1Panel → 运行环境 → Node.js → 安装 Node 20（18+ 均可）。

**2. 获取源码并构建**

服务器终端执行：

```bash
cd /opt
git clone https://github.com/Joshualover/video-web.git
cd video-web
npm install
npm run build   # 生成 dist 静态资源（server 会自动托管）
```

**3. 创建 Node 项目**

1Panel → 网站 → Node 项目 → 创建：

| 配置项 | 值 |
| --- | --- |
| 项目名称 | video-web |
| 源码目录 | /opt/video-web |
| 启动文件 | server/index.js |
| Node 版本 | 20（已安装的版本） |
| 端口 | 8787 |
| 环境变量 | `PORT=8787`、`ALLOW_PRIVATE_NETWORK=true`、`ALLOW_INSECURE_TLS=true`（公网建议加 `PROXY_TOKEN=xxx`，并将 `ALLOW_PRIVATE_NETWORK` 改为 `false`） |

**4. 绑定域名与 HTTPS**

- 网站列表 → video-web → 域名：添加域名，1Panel 会自动反向代理到 `127.0.0.1:8787`
- 证书：申请 Let's Encrypt 证书或导入自有证书，开启 HTTPS

**5. 访问** `https://你的域名` 即可。升级时在服务器执行 `git pull && npm install && npm run build`，再到 1Panel 重启项目。

> 进程守护：1Panel 自带守护，无需额外配置；若习惯 PM2，可引用仓库根目录的 `ecosystem.config.cjs`。

### 方式二：Docker（可选）

仓库已提供 `Dockerfile` 与 `docker-compose.yml`：

1. 1Panel → 容器 → 编排 → 创建，选择 Git 仓库或上传源码目录（含 Dockerfile）
2. 或服务器终端：`cd /opt/video-web && docker compose up -d --build`
3. 端口映射 `8787:8787`，环境变量在 compose 中按需修改

## 目录结构

```text
server/index.js        Express CORS 代理（含 SSRF 防护），本地生产运行
server/proxy-core.js   代理核心逻辑（Express 与 Vercel Serverless 共用）
api/proxy.js           Vercel Serverless 代理接口
api/health.js          Vercel 健康检查接口
vercel.json            Vercel 构建与路由配置
ecosystem.config.cjs   PM2 进程守护配置（可选）
Dockerfile / docker-compose.yml   Docker 部署（可选）
src/lib/m3u.js         m3u / m3u8 解析器
src/lib/fetch.js       远程加载与代理降级
src/lib/storage.js     localStorage 封装
src/stores/            播放列表、播放器、收藏/最近/已保存列表
src/components/        分组、频道列表、播放器、顶部导航
src/views/             首页、播放页、收藏页、设置页
```

## 免责声明

本项目仅提供播放工具，不存储、不转码、不传播任何音视频内容。播放可用性取决于第三方源站。
