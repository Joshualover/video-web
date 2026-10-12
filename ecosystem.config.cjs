// PM2 进程守护配置（可选）：1Panel Node 项目如需 PM2 托管可引用此文件
module.exports = {
  apps: [
    {
      name: 'flow-player',
      script: 'server/index.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 8787,
        // 默认关闭内网直连（SSRF 防护）；局域网/IPTV 直连需显式改为 'true'
        ALLOW_PRIVATE_NETWORK: 'false',
        // 默认校验证书；遇到自签名源站再改为 'true'
        ALLOW_INSECURE_TLS: 'false'
        // HOST: '0.0.0.0',                 // 默认监听所有网卡；公网部署建议 '127.0.0.1' 交给反代
        // PROXY_TOKEN: 'your-secret-token' // 可选令牌；注意它不是授权边界，公网请用反向代理鉴权
        // VOD_HTTP_PROXY: 'http://127.0.0.1:7890' // 出网代理：影视源与 YouTube 音源都走它
        // PATH: `/opt/homebrew/bin:${process.env.PATH}`
        //   ↑ yt-dlp 按 PATH 找 deno（用来解 YouTube 的 JS 挑战）。PM2 默认给的是
        //     /usr/bin:/bin 这种很窄的 PATH，deno 装在 /opt/homebrew/bin 就找不到，
        //     表现为「能搜到、能开始播，一小段就停」。适配器已会自动补几个常见位置，
        //     deno 装在别处时用这行显式补上。
      }
    }
  ]
}
