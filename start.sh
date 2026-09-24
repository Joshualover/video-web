#!/usr/bin/env bash
# flow-player 启动脚本
# 自动加载 .env（本机私有配置，如 VOD_HTTP_PROXY 代理），再启动服务。
# 用法：./start.sh              前台运行（Ctrl+C 停止）
#       nohup ./start.sh > flow-player.log 2>&1 &   后台运行
set -e
cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

echo "[flow-player] 启动服务 ..."
exec node server/index.js
