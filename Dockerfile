# ───────────── build stage ─────────────
ARG BASE_IMAGE=node:20-bookworm-slim
FROM ${BASE_IMAGE} AS build

WORKDIR /app

# Build-time tools for `better-sqlite3` native compilation.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests

# Typecheck + tests + emit dist/. Errors here fail the build.
RUN npm run typecheck && npm test && npm run build

# ───────────── runtime stage ─────────────
FROM ${BASE_IMAGE}

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# Production deps only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Compiled output + the minimum needed at runtime.
COPY --from=build /app/dist ./dist

# State DB lives here by default; mount as a volume in compose.
RUN mkdir -p /var/lib/akron-slot

ENV NODE_ENV=production \
    SLOT_STATE_DB=/var/lib/akron-slot/state.db \
    SLOT_BIND=127.0.0.1 \
    SLOT_PORT=7777

EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7777/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
