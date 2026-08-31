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
        ALLOW_PRIVATE_NETWORK: 'true',
        ALLOW_INSECURE_TLS: 'true'
      }
    }
  ]
}
