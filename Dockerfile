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

# Node 20 runtime. The base image has Node 18 but better-sqlite3 11
# requires >= 20, so we replace it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Slot's runtime artifacts.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY --from=build /app/dist ./dist

# State DB lives here by default; mount as a volume in compose.
RUN mkdir -p /var/lib/akron-slot

ENV NODE_ENV=production \
    SLOT_STATE_DB=/var/lib/akron-slot/state.db \
    SLOT_BIND=0.0.0.0 \
    SLOT_PORT=7777

# Slot s6 service — runs after init-os-end, init-envfile, init-services.
RUN mkdir -p /etc/s6-overlay/s6-rc.d/svc-slot && \
    printf '#!/usr/bin/with-contenv bash\nexec node /app/dist/server.js\n' \
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
  CMD node -e "fetch('http://127.0.0.1:7777/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
