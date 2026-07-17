# Phase A — Dockerfile for the akroncloud-slot image.
#
# In production (Phase B+), the runtime layer below provides the MT5
# terminal + ZMQ bridge, and the slot process attaches to that bridge
# via localhost ZMQ sockets.
#
# For Phase A we ship a minimal image that runs only the Node.js
# Fastify server. The MT5 base image is referenced as a build arg so
# Phase B can flip BASE_IMAGE without rewriting this file.

# ----- build stage -----
ARG BASE_IMAGE=node:20-bookworm-slim
FROM ${BASE_IMAGE} AS build

WORKDIR /app

# Install only the build-time tools needed for `better-sqlite3` native
# compilation. The runtime image below also has these so we don't need
# to share them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
RUN npm run typecheck && npm test

# ----- runtime stage -----
FROM ${BASE_IMAGE}

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# Bring only the deps + compiled output across.
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./

# State DB lives here by default; mounted as a volume in compose.
RUN mkdir -p /var/lib/akron-slot

ENV NODE_ENV=production \
    SLOT_STATE_DB=/var/lib/akron-slot/state.db \
    SLOT_BIND=127.0.0.1 \
    SLOT_PORT=7777

EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7777/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--experimental-strip-types", "src/server.ts"]
