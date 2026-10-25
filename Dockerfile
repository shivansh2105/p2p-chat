# P2P Chat headless server
#   docker build -t p2p-chat-server .
#   docker run -d --name p2p-chat --restart unless-stopped \
#     -p 4001:4001 -p 4002:4002 -v p2p-data:/data \
#     -e P2P_PUBLIC_IP=203.0.113.10 p2p-chat-server
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY stubs ./stubs
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src ./src
RUN mkdir -p /data && chown node:node /data
ENV P2P_DATA=/data P2P_HTTP=8080 P2P_HTTP_HOST=0.0.0.0
VOLUME /data
EXPOSE 4001 4002
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s CMD node -e "require('http').get('http://127.0.0.1:8080/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "src/server/index.js"]
