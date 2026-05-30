# ===========================================================================
# Stage 1: Build the CLI
# ===========================================================================
FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
COPY wasm/ wasm/

RUN npm run build
RUN npm prune --production --ignore-scripts

# ===========================================================================
# Stage 2: Runtime
# ===========================================================================
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production node_modules (includes openai, @anthropic-ai/sdk)
COPY --from=builder /app/node_modules/ node_modules/

# Built CLI
COPY --from=builder /app/dist/ dist/

# Tree-sitter WASM grammars
COPY --from=builder /app/wasm/ wasm/

COPY package.json ./

# Controller source (runs via tsx at startup)
COPY src/controller/ src/controller/

# Install tsx for running the controller TS files directly
RUN npm install --no-save tsx

ENV NODE_ENV=production
ENV DATA_DIR=/data

VOLUME ["/data"]

EXPOSE 8080 8081

# Default: run the controller API + wiki server
CMD ["node", "--import", "tsx", "src/controller/server.ts"]
