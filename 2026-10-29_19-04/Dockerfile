# Clinic records app. Two stages: build the native SQLite module, then copy only what runs.
FROM node:24-slim AS build
WORKDIR /app
# better-sqlite3 is compiled here if no prebuilt binary matches. The toolchain stays in this stage only.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm rebuild better-sqlite3

FROM node:24-slim
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY views ./views
COPY public ./public
COPY migrations ./migrations
COPY scripts ./scripts
# The node image ships a non-root "node" user (uid 1000). The data folder must belong to it.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
