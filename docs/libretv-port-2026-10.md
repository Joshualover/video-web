# LibreTV 参考移植记录（2026-10 下旬）

依据 <https://github.com/LibreSpark/LibreTV>（Next.js 重构版，AGPL-3.0）对本项目做了五个方向的优化。
LibreTV 是 AGPL 许可，**全部为语义重写**：只移植其规则、阈值与状态机设计（这些结论来自它对真实采集站的长期踩坑），不复制源码文本。
范围：`1861b4d` 之后共 5 个提交（`752fa87` → `2dca9b6`）。

## 一、本轮移植项

| 优化 | 借鉴的 LibreTV 模块 | 落地要点 | 提交 |
| --- | --- | --- | --- |
| 搜索片名匹配升级 | `lib/cms-parser.ts`（normalizeTitle / parseSeasonSuffix / filterRelevantResults / aggregateOutcomes） | 新增 `server/vod/title-match.js`：归一化去全部 Unicode 标点；多词查询每词必中；「庆余年2 ↔ 庆余年 第二季」季数别名（中文数字、数字完整命中防 2 匹配 12）；`/api/vod/search` 按源过滤不相关结果 + 精确命中优先排序；best.js 同名判定同语义复用 | `752fa87` |
| 详情选线与简介兜底 | `lib/cms-parser.ts`（parseDetail / extractEpisodesFromPlayUrl / extractM3u8FromText） | 新增 `preferredLine`：多线路默认选含 m3u8 的那条；`vod_play_url` 为空时从简介 `vod_content` 兜底提取 m3u8；best 探测剧集跟随 preferredLine；前端详情/播放/换源三处接线 | `ef4e05a` |
| 跳过片头片尾按剧名记忆 | `lib/skip-marks.ts`（skipMarkKey / resolveSegments / findCrossedEnding） | 新增 `src/lib/skip-marks.js`：键改 `t:归一化剧名`（换源/换集共享标记，旧 `site\|id` 数据向后兼容）；读取侧按本集时长裁剪越界边界；**修掉拖动进度条到片尾区被立刻切下一集的缺陷**（片尾自动结束只认连续小步越过，>10s 跳变不触发） | `c0c7223` |
| 播放失败分级恢复 | `lib/playback-recovery.ts`（RecoveryDecision / markHealthy 静默窗 / 指数退避） | 新增 `src/lib/playback-recovery.js` 纯决策器：video.js `error().code`+message 分类（网络/媒体/硬失败/abort）；网络 3 次指数退避 800ms→8s、媒体 2 次；3s 静默窗防成功噪声抹掉计数；第 2 次重试自动切代理↔直连路由；预算耗尽才走换源；播放中途 waiting 卡死 20s 也纳入监控（原只管起播前） | `62e93da` |
| 选路面板画质徽标 | `lib/quality-probe.ts` 第一级 + `quality.ts`（短边、BANDWIDTH 反推、host 闸门、缓存分档 TTL） | 新增 `server/vod/quality.js`（纯函数：parseBestHeight 取短边、档位中位分界）与 `server/vod/quality-probe.js`（清单头部 64KB、死线 12s、同 host 在途 ≤3、成功 30min/失败 2min 缓存、inflight 合并）；`POST /api/vod/quality` 归入放大型限流；详情页/播放页选路行整批异步探画质，显示 4K/1080P/720P/未知，失败静默 | `2dca9b6` |

新增测试全部挂入 `npm test`（沿用 node:assert 裸脚本风格）：
`test-title-match.mjs` / `test-detail-line.mjs` / `test-skip-marks.mjs` / `test-playback-recovery.mjs` / `test-quality-parse.mjs`。

## 二、明确未移植的部分（与原因）

- **分片级画质深探**（TS 的 H.264 SPS 位流 / MP4 box 解析 / AES 前缀解密）：体量大，作为二期；当前单码率源显示「未知」而非猜档。
- **HLS 清单广告过滤**（片头 DISCONTINUITY 段剔除等）：误杀正片风险高，需要真实源样本先建 fixtures，未与本轮混提交。
- **搜索逐源 NDJSON 流式 + 源级硬死线**：改动面横跨鉴权/压缩/限流中间件与前端取数层，建议独立立项。
- **起播/跟播预取（分段缓存）**：依赖 hls.js loader 替换，video.js + VHS 架构下无对应挂点；服务端分片缓存放大有界性风险，未做。
- **SSRF / host-gate 的 DNS 侧**：本项目 `assertPublicTarget` 已覆盖且 2026-10 审核修过 IPv4-mapped 绕过，不重复。

## 三、如何验证

```bash
npm test            # 9 组断言脚本全过（含本轮新增 5 组）
npm run build       # 前端构建
node server/index.js
```

关键冒烟点：

- 内网画质探测被拒：`curl -s -X POST localhost:8787/api/vod/quality -H 'Content-Type: application/json' -d '{"urls":["http://127.0.0.1/x.m3u8"]}'` → `{"results":[{"status":"fail","reason":"该地址指向内网资源…"}]}`
- 搜索相关性：搜「庆余年2」应能命中标题写成「庆余年 第二季」的源，且不相关凑数结果被过滤
- 播放页把进度条拖到片尾区：不应被自动切下一集；正常播到片尾起点才切
- 起播失败：观察是否先「退避重试→换路由」再「自动换源」，而非一次失败就跳线
