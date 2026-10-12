# 代码审核与修复记录（2026-10）

对全仓做了一次完整审核（后端 Express + 爬虫 + VOD 聚合、前端 Vue3、部署配置），并完成修复。
所有阻塞级结论都做过可复现实验证，修复后逐项回归；下面按类别列出，附对应提交。
范围：`b329108` 之后共 21 个提交（`ddf4714` → `cc8fc46`）。

## 一、阻塞项

| 问题 | 修复要点 | 提交 |
| --- | --- | --- |
| 容器启动即崩 | 运行阶段缺 `src/`，而 `server/crawler.js` 静态 `import '../src/lib/m3u.js'` → `ERR_MODULE_NOT_FOUND`。补齐该层、改非 root 运行、compose 挂载 `data/` 卷、新增 `.dockerignore` | `ddf4714` |
| SSRF 防护只覆盖 `/api/proxy` | 出口校验统一到所有出网入口：`maccms.httpGetText`（HGD/Vidhub/豆瓣/配置抓取）、hls、image、config-store，含每一次 HTTP 重定向 | `881b386` |
| 内网过滤可被绕过 | `[::ffff:127.0.0.1]` 这类 IPv4-mapped IPv6 形式原先放行；`isPrivateIp` 归一化并补 CGNAT/保留网段，校验前移到**建立连接之前**（不再是「请求已发出再丢弃响应」） | `881b386` |
| 默认值落在不安全一侧 | `ALLOW_PRIVATE_NETWORK` / `ALLOW_INSECURE_TLS` 默认改为安全侧；新增 `HOST` 与启动安全告警；compose / PM2 同步 | `881b386` |
| 上游 `Content-Type` 透传 → 同源 XSS | 代理回传类型加白名单 + `X-Content-Type-Options: nosniff` + `/api` 的 CSP；移除 `X-Powered-By` | `881b386` |
| 令牌链断裂、令牌不是授权边界 | 前端统一带 `Authorization`；`/api/vod/play` 与清单重写透传令牌（`<video>` 发不出自定义头）；原先裸奔的 `/api/vod/*`、`/api/playlists*`、`/api/site-search/status` 补鉴权；令牌比较改 `timingSafeEqual` | `881b386`、`fc61c91` |

## 二、可用性与滥用防护

| 修复 | 提交 |
| --- | --- |
| 抓取任务：`page.evaluate` 加超时（`CRAWL_EVAL_TIMEOUT_MS`）+ 协作式终止（`shouldStop` 贯穿 collectOnly/crawlAndSave/crawlItems/fetchOne） | `8539fcc` |
| 任务锁从布尔改为持有者 id + 看门狗（`CRAWL_TASK_MAX_MS`）+ 完成任务 TTL（`CRAWL_TASK_TTL_MS`）：避免一次卡死让所有人的搜片永久 409 | `8bc16e4` |
| 轻量内存限流（无第三方依赖）：普通 600/min、放大型 30/min、登录 10/min，超限 429 + `Retry-After`，`/api/health` 豁免 | `8bc16e4`、`baa46ce` |
| 上游 302 跟随（≤3 跳、每跳重新校验）：此前清单请求会把 302 空体当清单，走 CDN 跳转的源完全播不出来 | `7bcc232` |
| 源列表按配置顺序归集、失败配置不再算「新鲜缓存」、`getSources({configId})` 不再污染全局缓存 | `7bcc232` |
| 豆瓣评分不再输出字符串 `"NaN"`、年份取值修正、非 JSON 响应给出可读错误；`fetchDetail` 错误不再被误报成 404；`parsePlayUrl` 保留 `#t=10` 片段 | `7bcc232` |
| vidhub 播放器 iframe 限域；hgdju 串行队列加上限（`HGD_MAX_QUEUE`）；爬虫「重定向发现的域名」先过出网校验、域名池限量（`CRAWL_MAX_DOMAINS`） | `3341eb6` |

## 三、前端

| 修复 | 提交 |
| --- | --- |
| 播放页/详情页 `load()` 加请求序号：旧响应不再覆盖新片数据、不再把 A 片名写进 B 片历史 | `acb9e2b` |
| 搜片页卸载后不再重启轮询；目标文件分组读取加序号 | `acb9e2b` |
| 坏图标记改按 URL（不再跨播放列表串味）、不再改写 store 数据；「按源浏览」海报改走 `vodImage()`；登录 `redirect` 只接受站内路径 | `8cb3fa8` |
| 设置页：缓存占用可刷新；「清空全部数据」加二次确认并保留登录信息 | `884ccff` |
| 方块视图改虚拟滚动：2 万条列表首屏 98ms、仅 54 个卡片节点（原 20000） | `90431a9` |
| 卡片/行改用 `div[role=button]`，修掉 `button` 嵌套 `button`；补 `cursor: pointer` 与焦点环 | `357c9a8` |

## 四、安全能力（可选开关）

| 修复 | 提交 |
| --- | --- |
| 可选整站 Basic 鉴权 `BASIC_AUTH`（不依赖反向代理） | `0065790` |
| 可选服务端会话登录 `WEB_LOGIN`：HttpOnly + SameSite Cookie，`<video>`/`<img>` 自动携带；前端登录改为过服务端（未启用时回落本地校验） | `baa46ce` |
| e2e 脚本支持会话登录（`LOGIN_USER` / `LOGIN_PASS`）、内核定位复用 `findBrowser()`（跨平台开箱可用） | `cc8fc46`、本批 |

## 五、依赖与工具

| 修复 | 提交 |
| --- | --- |
| `npm audit --omit=dev` 归零：`proxy-addr` 2.0.7→2.0.8（critical）、`source-map-js` 1.2.1→1.2.2（high）；只改 `package-lock.json` | `e8720d8` |
| m3u 解析器：`#EXTINF` 分隔符改为「第一个引号外的逗号」（标题含逗号不再被截断）+ 4 组回归用例 | `3cd4e30` |
| `.gitignore` 补 `.env.*` / `!.env.example` / `.vercel` | `d29d3af` |
| `merge-m3u` 校验 `-o` 缺值、改为先写 `.tmp` 再改名 | `1d3e487` |

## 六、环境变量速查

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `ALLOW_PRIVATE_NETWORK` | `false` | `true` 时允许服务端直连内网（局域网 IPTV 等场景需要） |
| `ALLOW_INSECURE_TLS` | `false` | `true` 时跳过上游证书校验（自签名源站） |
| `PROXY_TOKEN` | 空 | 接口令牌；**注意它不是授权边界**（会随前端产物公开） |
| `BASIC_AUTH` | 空 | `user:pass`：整站 Basic 鉴权 |
| `WEB_LOGIN` | 空 | `user:pass`：服务端会话登录（HttpOnly Cookie） |
| `COOKIE_SECURE` | 空 | `1` 时会话 Cookie 加 `Secure`（HTTPS 部署建议开） |
| `SESSION_SECRET` | 由口令派生 | 会话签名密钥；改了它 / 改了 `WEB_LOGIN` 即失效所有会话 |
| `CORS_ORIGIN` | 空 | 空=仅同源；`*` 或逗号分隔白名单 |
| `HOST` | `0.0.0.0` | 监听地址；公网部署建议 `127.0.0.1` 交给反向代理 |
| `TRUST_PROXY` | 空 | `1` 时信任反代传来的客户端 IP（限流按真实 IP 生效） |
| `RATE_LIMIT_PER_MIN` | `600` | 普通接口限流 |
| `RATE_LIMIT_HEAVY_PER_MIN` | `30` | 放大型接口限流（搜索/选路/全量刷新/源检测/站内抓取） |
| `RATE_LIMIT_LOGIN_PER_MIN` | `10` | 登录接口限流（防爆破） |
| `CRAWL_TASK_MAX_MS` | 20 分钟 | 单次搜索/抓取任务上限，到点终止并释放锁 |
| `CRAWL_TASK_TTL_MS` | 30 分钟 | 已完成任务保留时长 |
| `CRAWL_EVAL_TIMEOUT_MS` | 20 秒 | 单个详情页脚本执行超时 |
| `CRAWL_MAX_DOMAINS` | 20 | 自动发现的壳域名保留上限 |
| `HGD_MAX_QUEUE` | 40 | 黄瓜短剧源的串行队列上限 |

## 七、上线检查清单

- [ ] 公网部署：`HOST=127.0.0.1` + 反向代理，或设置 `BASIC_AUTH` / `WEB_LOGIN`
- [ ] 媒体或源站在局域网（IPTV 等）：`ALLOW_PRIVATE_NETWORK=true`
- [ ] 源站使用自签名证书：`ALLOW_INSECURE_TLS=true`
- [ ] 反向代理后面：`TRUST_PROXY=1`（否则限流按 127.0.0.1 汇总计算）
- [ ] HTTPS + 会话登录：`COOKIE_SECURE=1`，并设置 `SESSION_SECRET`
- [ ] 需要被其它站点/设备跨源调用：`CORS_ORIGIN`
- [ ] 依赖自检：`npm audit --omit=dev` 应为 0

## 八、已知取舍与未做项

- 前端「登录」**默认仍是本地 UI 门槛**（口令存浏览器、服务端不校验它）；只有设置 `WEB_LOGIN` 才是真正的服务端会话。
- `express` 仍在 4.x：原先那个 critical 已通过 `proxy-addr 2.0.8` 修掉，所以未做 4→5 主版本升级。
- `crawlTasks` 中已完成任务（含搜索结果）保留 30 分钟：内存有界（最多约 30 个任务），未额外裁剪。
- 启用 `WEB_LOGIN` 的部署上，e2e 脚本需要提供 `LOGIN_USER` / `LOGIN_PASS`。
- 更细的既有问题（`crawl-domains.json` 只能是可解析域名、`vidhub` 线路名与 sid 的映射依赖页面 tab 顺序等）未改。

## 九、如何验证

```bash
npm test                 # m3u 解析器单测（含本次新增的 4 组回归用例）
npm run build            # 前端构建
npm audit --omit=dev     # 应为 0 漏洞
node server/index.js     # 启动；日志会提示「未设令牌且监听非回环」等安全信息
```

关键冒烟点（默认配置）：

- 内网地址应被拒绝：`curl -i 'localhost:8787/api/proxy?url=http%3A%2F%2F127.0.0.1%3A8787%2F'` → `403`
- 探活放行：`curl -i localhost:8787/api/health` → `200`
- 未匹配的 API 返回 JSON 404，且响应带 `X-Content-Type-Options: nosniff`
- 设置 `PROXY_TOKEN` 后，未带令牌的 `/api` 请求 → `401`
