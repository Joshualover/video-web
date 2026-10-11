# 构建阶段
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# 运行阶段
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server
# server/crawler.js 静态 import '../src/lib/m3u.js'，缺这一层会导致启动即 ERR_MODULE_NOT_FOUND
COPY --from=builder /app/src ./src
COPY --from=builder /app/dist ./dist
# data/ 需可写（播放列表上传、影视配置、源启停偏好），容器内不以 root 运行
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8787
CMD ["node", "server/index.js"]
