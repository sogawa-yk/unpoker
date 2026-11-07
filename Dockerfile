# unpoker: 画面（apps/web）とサーバー（apps/server）を 1 つのイメージにする
# ビルド: docker build --platform linux/arm64 -t unpoker .
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build -w @unpoker/web && npm run build -w @unpoker/server

FROM node:24-alpine
ENV NODE_ENV=production PORT=8080 WEB_ROOT=/app/web
WORKDIR /app
# NoSQL SDK は自分の package.json を実行時に読むため、バンドルせずに入れる
RUN echo '{"type":"module","private":true}' > package.json && npm install --omit=dev --no-audit --no-fund oracle-nosqldb@5.5.4 && npm cache clean --force
COPY --from=build /src/apps/server/dist/index.js ./server.js
COPY --from=build /src/apps/web/dist ./web
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
