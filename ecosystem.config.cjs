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
      }
    }
  ]
}
