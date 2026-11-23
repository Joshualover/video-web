# 部署环境变量检查清单

> 适用于「流光播放器」（flow-player）。按顺序过一遍，能避开绝大多数「本地好好的、一上线就废」的问题。
>
> 重点在第 2 节 **`VOD_HTTP_PROXY`** —— 它决定影视源和音乐源能不能出网，也是最容易配错的一项。

## 0. 一条命令跑完自检

```bash
npm run doctor                        # 自动拉起临时实例，把下面所有检查跑一遍
BASE=http://你的站:8787 npm run doctor  # 检查已经在跑的实例（线上用这个）
npm run doctor -- --json              # 机器可读输出，接 CI 用
```

它会依次检查：服务可访问 → 代理是否生效 → 启动日志 → GD音乐台音源 →
搜索 → **取流并可播放**（真去取一段音频字节）→ yt-dlp → 访问控制 → 数据目录可写。

- **有 FAIL 时退出码为 1**，可以直接卡住发布流程
- 网络类问题会区分 `FAIL`（必须修）和 `WARN`（看情况），不会静默跳过
- 每项失败都带 `→ 怎么办` 的处理建议

输出长这样：

```
✔ 服务可访问 [PASS]
✔ 出网代理 [PASS]        已启用 http://127.0.0.1:7890
✔ GD音乐台音源 [PASS]     GD音乐台 · 网易云=ok；GD音乐台 · JOOX=ok
✔ 音乐搜索 [PASS]         10 条 / 5192ms｜GD音乐台 · 网易云×2，Apple 试听×2…
✔ 取流可播放 [PASS]       GD音乐台 · 网易云「晴天」→ 320 kbps｜1634ms
! 访问控制 [WARN]         未启用 WEB_LOGIN / BASIC_AUTH…
合计：8 通过 / 1 警告 / 0 失败 / 1 跳过
```

下面几节是脚本背后每一项的完整解释，排查时对照着看。

也可以手工跑几条命令：

```bash
# 1) 服务活着
curl -s http://127.0.0.1:8787/api/health

# 2) 代理有没有被正确识别（看启动日志第一屏）
#    配好了会有一行：[net] 出网代理已启用：http://xxx
#    配错了会有一行：[net] 代理地址无效，已忽略：...（原因）
node server/index.js 2>&1 | head -10

# 3) 代理能不能真的出网（把地址换成本机的代理）
curl -x http://127.0.0.1:7892 -I https://www.google.com
```

第 2 步的日志最关键：**只有出现 `[net] 出网代理已启用` 才说明配置生效**。
没出现这行，就是「以为配了、其实没读进去」，后面所有取流都会失败。

---

## 1. 最小可用配置

只有这几项是必填的，其余按需：

```bash
PORT=8787                 # 监听端口
HOST=127.0.0.1            # 公网部署建议只监听回环，交给反向代理
VOD_HTTP_PROXY=http://127.0.0.1:7892   # 出网代理（下一节详述）
```

`.env` 文件放在项目根目录即可，启动时会自动载入（`server/env.js`）。
命令行 / PM2 / Docker 里显式传的环境变量**优先级高于** `.env` 文件。

---

## 2. `VOD_HTTP_PROXY` 怎么配（重点）

### 2.1 它到底影响哪些功能

配错这一项，下面这些**全部**只能直连、在国内基本等于不可用：

| 功能 | 依赖方式 |
| --- | --- |
| 影视源抓取（CMS 接口、配置拉取） | `agentFor()` 注入 CONNECT 隧道 |
| 影视播放代理（m3u8 / mp4 透传） | 同上 |
| 封面代理（豆瓣 / 源站海报） | 同上 |
| 音乐源 **Piped / Invidious** | 同上 |
| 音乐源 **GD音乐台**（本次新增的主音源） | 同上 |
| 音乐源 **yt-dlp** | 以 `--proxy` 参数传给子进程 |

一句话：**不配代理，音乐模块只剩「Apple 试听」和「JioSaavn」能出声**（这两个可直连）。

### 2.2 支持什么、不支持什么

`server/net.js` 是自实现的 CONNECT 隧道 Agent（Node 的 http/https 不认 `*_PROXY` 环境变量）。它有明确边界：

| 写法 | 是否支持 | 说明 |
| --- | --- | --- |
| `http://127.0.0.1:7890` | ✅ | 最常用 |
| `http://user:pass@host:7890` | ✅ | 支持 Basic 认证 |
| `https://host:443` | ✅ | 代理本身走 TLS |
| `127.0.0.1:7890`（不带协议） | ✅ | 自动补 `http://` |
| `socks5://127.0.0.1:1080` | ❌ | **不支持**，会被忽略并在日志里报警 |

> ⚠️ **Clash / V2Ray 默认给的是 SOCKS5 端口**（7891、1080 之类）。
> 必须换成它们的 **HTTP 端口**（Clash 一般是 `7890`），否则日志会打
> `[net] 代理地址无效，已忽略：socks5://...（仅支持 http/https 代理）`，
> 然后静默按直连跑 —— 表现就是「配了代理但完全没用」。

### 2.3 三种部署场景的具体配法

#### A. 直接跑在宿主机（PM2 / systemd / nohup）

代理也在同一台机器上：

```bash
VOD_HTTP_PROXY=http://127.0.0.1:7890
```

用 systemd 时注意：`EnvironmentFile` 里**不要**给值加引号（除非值本身含空格），
否则引号会被当成值的一部分。

#### B. Docker（**最容易踩坑的一种**）

关键点：**容器里的 `127.0.0.1` 是容器自己，不是宿主机。**
所以 `http://127.0.0.1:7890` 在容器里必然连不上。

按你的代理跑在哪里，二选一：

**方式一：代理也放进容器网络里（推荐，最省事）**

`docker-compose.yml` 里加一个代理服务（示例用 mihomo/clash，换成你自己的镜像），
然后让应用走服务名：

```yaml
services:
  flow-player:
    build: .
    environment:
      PORT: 8787
      # 用服务名，不是 127.0.0.1
      VOD_HTTP_PROXY: "http://proxy:7890"
    depends_on:
      - proxy

  proxy:
    image: metacubex/mihomo:latest   # 换成你自己的代理镜像
    # 你的配置挂载 / 端口等
```

**方式二：复用宿主机上的代理**

Linux 上用 `host-gateway`（Docker 20.10+）：

```yaml
services:
  flow-player:
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      VOD_HTTP_PROXY: "http://host.docker.internal:7890"
```

Docker Desktop（macOS / Windows）自带 `host.docker.internal`，可直接用。

> ⚠️ 宿主机代理必须监听 `0.0.0.0` 或 Docker 网桥地址（而非只监听 `127.0.0.1`），
> 否则容器仍然连不上 —— 这是「配了却连不通」的常见原因。

另外注意：容器的 `localhost` / `127.0.0.1` / 内网段会被 `isBypassed()` **自动直连**，
所以就算你写了 `http://127.0.0.1:7890`，reflective 的目标也不会走代理 ——
但连代理本身会失败，所以还是得按上面改。

#### C. 服务器上自建代理（无 GUI）

```bash
VOD_HTTP_PROXY=http://127.0.0.1:7890
```

用 `systemd` 管代理时，确认代理在应用之前就绪（`Requires=` / `After=`），
否则应用启动瞬间代理没起来，健康检测会把所有源标成失败（30 分钟退避后才恢复）。

### 2.4 带认证的代理

```bash
VOD_HTTP_PROXY=http://user:p%40ssword@10.0.0.8:3128
```

密码里的特殊字符要做 **URL 编码**（`@` → `%40`，`:` → `%3A`，`#` → `%23`）。

两点说明：

- 隧道代理（CONNECT）用的是 Basic 认证；如果你的代理只支持 Digest，本项目连不上。
- **密码不会泄露给前端**：`proxyStatus()` 下发给界面的是脱敏地址 `http://host:port`，
  只有 yt-dlp 子进程通过 `proxyForTools()` 拿到带凭据的完整地址。
  这条边界有回归测试守着（`scripts/test-env.mjs`），别改回去。

### 2.5 哪些请求会绕过代理

`isBypassed()` 会**自动直连**下面这些，不用额外配置：

- `localhost`、`127.0.0.1`、`::1`
- 内网段：`10.*`、`172.16-31.*`、`192.168.*`、`169.254.*`
- 以及反向代理 / 本机服务

另外两个可选项：

```bash
# 额外直连的域名（不走代理）；子域自动包含
VOD_NO_PROXY=.example.com,10.0.0.5

# 强制直连的域名：某些源站/CDN 反而不能走代理
# （代理 IP 会被 Cloudflare challenge，或直接取不到资源）
VOD_DIRECT_HOSTS=vidhub.tv,vidhub3.top
```

> 运行期还会「学习」路由：某个域名在代理下失败、直连成功，就会被记成以后直连
> （日志：`[net] xxx 以后走直连`）。这是自动的，重启后重新学。

### 2.6 怎么确认配对了

```bash
# 1) 日志里有这一行
#    [net] 出网代理已启用：http://127.0.0.1:7890

# 2) 用同样的地址测通出网
curl -x http://127.0.0.1:7890 -I https://www.google.com
#    期望 HTTP/2 200 或 301

# 3) 界面里看：设置 → 音源管理，顶部会显示当前代理状态
#    也可以直接问接口：
curl -s http://127.0.0.1:8787/api/music/sources | grep -o '"proxy":{[^}]*}'

# 4) 端到端：搜一首歌，能取到流就说明整条链路通了
curl -s "http://127.0.0.1:8787/api/music/search?wd=%E6%99%B4%E5%A4%A9&limit=5"
```

第 4 步如果 `errors` 里有 GD音乐台且报 `ECONNRESET`，基本就是代理没生效（见下一节）。

---

## 3. 按功能分组的其它变量

### 3.1 音乐

```bash
MUSIC_SEARCH_SOURCES=6              # 一次聚合搜索并搜几个源（1-20）
MUSIC_SEARCH_DEADLINE=15000         # 硬截止 ms
MUSIC_SEARCH_SOFT_DEADLINE=3500     # 软截止 ms（已出结果就先返回）
MUSIC_MATCH_SOURCES=4               # 换源播放最多试几个源
MUSIC_QUALITY=320                   # 默认音质：128 / 320 / 740(=无损 FLAC)
MUSIC_WARMUP=1                      # 启动后异步检测音源；0 关闭
```

关于 `MUSIC_QUALITY`：默认 `320`。设成 `740` 是**无损 FLAC**，
但单曲约 **21MB**（320k 约 4.5MB），流量约为 4-5 倍 —— 移动端用户多的话谨慎开。

关于 `MUSIC_WARMUP`：保持 `1`。关掉后首次搜索/播放要自己等健康检测。

### 3.2 yt-dlp（可选，YouTube 音源）

```bash
YTDLP_PATH=/usr/local/bin/yt-dlp     # 不填则自动找 PATH 与常见安装位置
YTDLP_PLAYER_CLIENTS=android_vr,android,ios
YTDLP_CONCURRENCY=2
```

不装也能跑 —— 检测失败会自动排除，只是少一路 YouTube 音源。
装了的话**用较新的版本**（旧版拿到的直链会被 YouTube 限流成「只给前 1MiB」，播一小段就停）。
Docker 镜像里**没有** yt-dlp，需要自己在 Dockerfile 里装或挂载。

### 3.3 访问控制（公网必配）

```bash
WEB_LOGIN=admin:你的密码      # 服务端会话登录（推荐）
BASIC_AUTH=user:pass          # 整站 Basic 鉴权
PROXY_TOKEN=随机串            # 接口令牌
```

> ⚠️ 注意默认的 `admin/admin123` 只是**前端本地门槛**（口令存在浏览器 localStorage，
> 服务端不校验），不能当作访问控制。公网部署**必须**配 `WEB_LOGIN` 或 `BASIC_AUTH`。
>
> `PROXY_TOKEN` 会随前端产物公开，不是授权边界，只算「顺手挡一下」。

### 3.4 安全相关（默认值通常不要动）

```bash
ALLOW_PRIVATE_NETWORK=false    # 默认禁止服务端访问内网（SSRF 防护）
                               # 只有要直连局域网 IPTV / 内网源时才设 true
ALLOW_INSECURE_TLS=false       # 默认校验证书；遇到自签名源站再开
```

> 这两个是 SSRF 防线。设成 `true` 等于允许服务端替你请求任意内网地址，
> 公网部署时**务必保持 false**。

### 3.5 其它

```bash
VOD_AUTO_REFRESH_HOURS=6            # 影视源配置自动刷新间隔，0 关闭
SIXTY_API_BASE=https://60s.viki.moe # 热榜接口的 60s API 实例
```

---

## 4. 上线前逐项打勾

- [ ] **`npm run doctor` 跑过，且没有 FAIL**（这条覆盖了下面大部分，先跑它）
- [ ] `VOD_HTTP_PROXY` 用的是 **HTTP** 端口（不是 socks5），且日志出现 `[net] 出网代理已启用`
- [ ] Docker 部署时代理地址用的是 **服务名 / `host.docker.internal`**，不是 `127.0.0.1`
- [ ] 代理本身在 `0.0.0.0` 上有监听（容器才能连到）
- [ ] `curl -x <代理> https://www.google.com` 能通
- [ ] 配了 `WEB_LOGIN` 或 `BASIC_AUTH`（公网）
- [ ] `ALLOW_PRIVATE_NETWORK` 保持 `false`
- [ ] `data/` 已挂载到持久卷（`docker-compose.yml` 已配 `./data:/app/data`）
- [ ] `/api/health` 返回 `{"ok":true}`
- [ ] 随手搜一首歌，能播
- [ ] `MUSIC_QUALITY` 想清楚（默认 320；无损吃流量）

---

## 5. 常见现象对照表

| 现象 | 多半是 | 处理 |
| --- | --- | --- |
| 日志没有 `[net] 出网代理已启用` | 变量没读进去 | 确认写在哪（`.env` / compose / systemd），以及拼写 |
| 日志有 `代理地址无效，已忽略：socks5://...` | 用了 SOCKS5 端口 | 换 HTTP 端口（Clash 通常 7890） |
| 影视源全挂、音乐只剩 Apple 试听 | 代理没生效 | 按第 2.6 节逐项测 |
| Docker 里报 `ECONNREFUSED 127.0.0.1:7890` | 容器里的 loopback 不是宿主机 | 用 `host.docker.internal` 或服务名 |
| GD音乐台报 `ECONNRESET` | 直连被重置（没走代理） | 同上，重点查代理是否生效 |
| GD音乐台偶发 `HTTP 503` | 上游限流 | 适配器已自动重试 + 降质，持续报错才需换源 |
| 能搜到但播不了（YouTube） | 媒体域被污染 | 确认 `VOD_HTTP_PROXY` 对 yt-dlp 也生效 |
| yt-dlp 报 `407` | 代理要认证但没带凭据 | 用 `http://user:pass@host:port` 形式 |
| 播放代理 502 / 超时 | 代理节点本身不稳 | `curl -x` 复测，换节点 |
| 改了环境变量没变化 | 没重启 | 环境变量只在启动时读一次 |

---

## 6. 备注：为什么不用 Node 原生的代理支持

Node 的 `http` / `https` 模块**不读** `HTTP_PROXY` / `HTTPS_PROXY` 环境变量
（那是 `curl`、`wget`、`pip` 这些 CLI 工具的约定）。所以本项目在 `server/net.js` 里
自己实现了一个 CONNECT 隧道 Agent，并沿用了 CLI 的变量名。

按这个优先级取**第一个非空值**：

```
VOD_HTTP_PROXY → HTTPS_PROXY → https_proxy → HTTP_PROXY → http_proxy → ALL_PROXY → all_proxy
```

**副作用（实测确认）**：很多公司/机房/CI 环境会全局导出 `HTTP_PROXY`，本服务会跟着走它。
而且 `VOD_HTTP_PROXY=`（设为空）**并不能关掉代理** —— 空值会被跳过，继续去看 `HTTP_PROXY`。
想彻底走直连，只能把环境里所有候选都清空：

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
  node server/index.js
```

先确认环境里到底有什么：

```bash
env | grep -iE 'proxy'     # 有输出就说明环境已经带了代理
```

> 排查「明明没配代理，却在走代理」时，先查这一项。
