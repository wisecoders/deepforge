# ===========================================================================
# Stage 1: Build
# ===========================================================================
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./

# Full install — better-sqlite3 needs native compilation
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
COPY wasm/ wasm/

RUN npm run build
RUN npm prune --production

# ===========================================================================
# Stage 2: Runtime
# ===========================================================================
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/wasm/ wasm/
COPY package.json ./

ENV NODE_ENV=production
ENV DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8080 8081

# Default: run the controller API
CMD ["node", "dist/controller/server.js"]
