# ModelScope 创空间 / 通用容器部署：构建前端产物 + 独立 Node 服务（0.0.0.0:7860）
FROM node:20-bookworm-slim

ENV HOST=0.0.0.0 \
    PORT=7860 \
    EDGE_TTS_PYTHON=python3 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# edge-tts 用于更自然的中文播报；容器内缺少 Python 时接口会返回 503，前端自动回退浏览器 TTS。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && pip3 install --no-cache-dir --break-system-packages edge-tts \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build

ENV NODE_ENV=production

EXPOSE 7860

CMD ["npm", "start"]