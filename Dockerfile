# ───────────── build stage ─────────────
ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE} AS build

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ───────────── runtime stage ─────────────
# Layer on top of the existing akron-mt5-base (Wine + MetaTrader 5 +
# KasmVNC + nginx-front + s6-overlay init). We add Node 20 + the slot.
FROM ghcr.io/alxvarp/akron-mt5-base:mt5-preinstalled

WORKDIR /app

# Node 20 runtime — installed to /opt/node20 instead of replacing the
# base image's /usr/bin/node (v18). The KasmVNC client ships native
# modules compiled against v18's NODE_MODULE_VERSION, so swapping the
# system node breaks the desktop. We run the slot with /opt/node20
# explicitly; everything else in the image keeps using v18.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl xz-utils ca-certificates \
 && curl -fsSL https://nodejs.org/dist/v20.20.2/node-v20.20.2-linux-x64.tar.xz \
      | tar -Jx -C /opt \
 && ln -sfn /opt/node-v20.20.2-linux-x64 /opt/node20 \
 && rm -rf /var/lib/apt/lists/*

# Slot's runtime artifacts.
COPY package.json package-lock.json ./
# Build with the project's npm (Node 18) against the package's
# engines:>=20.0.0 — node-sqlite3 + drizzle-orm both have prebuilt
# binaries, so npm ci succeeds even under Node 18 with a warning.
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY --from=build /app/dist ./dist

# State DB lives here by default; mount as a volume in compose.
RUN mkdir -p /var/lib/akron-slot

ENV NODE_ENV=production \
    SLOT_STATE_DB=/var/lib/akron-slot/state.db \
    SLOT_BIND=0.0.0.0 \
    SLOT_PORT=7777
# Intentionally do NOT prepend /opt/node20/bin to PATH — the KasmVNC
# services (svc-kclient, svc-nginx) invoke `node` and depend on the
# v18 ABI of their native modules. We let the base image keep its
# /usr/bin/node (v18) untouched; the slot runs via the explicit
# absolute path /opt/node20/bin/node below.

# Slot s6 service — runs after init-os-end, init-envfile, init-services.
RUN mkdir -p /etc/s6-overlay/s6-rc.d/svc-slot && \
    printf '#!/usr/bin/with-contenv bash\nexec /opt/node20/bin/node /app/dist/server.js\n' \
      > /etc/s6-overlay/s6-rc.d/svc-slot/run && \
    chmod +x /etc/s6-overlay/s6-rc.d/svc-slot/run && \
    printf 'longrun\n' > /etc/s6-overlay/s6-rc.d/svc-slot/type && \
    mkdir -p /etc/s6-overlay/s6-rc.d/svc-slot/dependencies.d && \
    for d in init-os-end init-envfile init-services; do \
      ln -sfn /etc/s6-overlay/s6-rc.d/$d \
              /etc/s6-overlay/s6-rc.d/svc-slot/dependencies.d/$d; \
    done

EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD /opt/node20/bin/node -e "fetch('http://127.0.0.1:7777/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
