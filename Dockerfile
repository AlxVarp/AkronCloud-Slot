# ───────────── build stage ─────────────
# Run npm ci + tsc here. Build tools + Node 20 are present, so the
# better-sqlite3 native module gets compiled against Node 20's ABI.
# Copy the result into the runtime stage so the runtime stage doesn't
# need make/g++/python3 at all.
ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE} AS build

WORKDIR /app

# Build-time tools for `better-sqlite3` native compilation + for
# compiling the MQL5 service (xvfb + X libs so metaeditor64 can
# open its dummy UI in a fake X server during the build step).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates xvfb libxinerama1 libxcursor1 \
      libxrandr2 libxi6 libxext6 libxrender1 libfontconfig1 \
 && rm -rf /var/lib/apt/lists/*

# Install ALL dependencies (dev + prod) so better-sqlite3 compiles
# against Node 20's NODE_MODULE_VERSION 115. Then prune dev deps for
# the runtime image.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

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

# Slot's runtime artifacts. node_modules shipped pre-built by the
# build stage (so better-sqlite3 already targets Node 20's ABI).
COPY --from=build /app/node_modules ./node_modules
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
    done && \
    # Empty marker file = "include this service in the s6 user bundle".
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-slot

# akroncloud-slot: override the base image's svc-de and svc-kasmvnc run
# scripts. The akron-mt5-base image does not set DISPLAY, HOME or
# XDG_RUNTIME_DIR in the s6-rc container env, so openbox-session
# (in svc-de) and Xvnc (in svc-kasmvnc) fail silently when s6 runs
# them. We hardcode the env vars here. The s6-rc service definition
# is recompiled at boot by the base image's init-kasmvnc-config, so
# overwriting the run files in /etc/s6-overlay/s6-rc.d is sufficient
# to make the fix survive image rebuild + container restart.
RUN cat > /etc/s6-overlay/s6-rc.d/svc-de/run <<'EOSVCDE'
#!/bin/bash
# akroncloud-slot fix: openbox-session needs DISPLAY + HOME explicit.
# akron-mt5-base does not set them globally in s6 env.
export DISPLAY=:0
export HOME=/config
export XDG_RUNTIME_DIR=/config/.XDG
exec s6-setuidgid abc /bin/bash /defaults/startwm.sh
EOSVCDE
RUN chmod +x /etc/s6-overlay/s6-rc.d/svc-de/run

# akron-mt5-base's svc-kasmvnc uses $DISPLAY in its run script but the
# var is empty in s6 env (same root cause as svc-de). We rewrite the
# run script so DISPLAY=:0 is exported before Xvnc is exec'd.
RUN cat > /etc/s6-overlay/s6-rc.d/svc-kasmvnc/run <<'EOSVCKASM'
#!/usr/bin/with-contenv bash
export DISPLAY=:0
export HOME=/config
export XDG_RUNTIME_DIR=/config/.XDG
# Pass gpu flags if mounted (lifted verbatim from the base image).
if ls /dev/dri/renderD* 1> /dev/null 2>&1 && [ -z ${DISABLE_DRI+x} ] && ! which nvidia-smi; then
  HW3D="-hw3d"
fi
if [ -z ${DRINODE+x} ]; then
  DRINODE="/dev/dri/renderD128"
fi
exec s6-setuidgid abc \
  /usr/local/bin/Xvnc ${DISPLAY} \
    ${HW3D} \
    -PublicIP 127.0.0.1 \
    -drinode ${DRINODE} \
    -disableBasicAuth \
    -SecurityTypes None \
    -AlwaysShared \
    -http-header Cross-Origin-Embedder-Policy=require-corp \
    -http-header Cross-Origin-Opener-Policy=same-origin \
    -geometry 1024x768 \
    -sslOnly 0 \
    -RectThreads 0 \
    -websocketPort 6901 \
    -interface 0.0.0.0 \
    -Log *:stdout:10
EOSVCKASM
RUN chmod +x /etc/s6-overlay/s6-rc.d/svc-kasmvnc/run

# Replace the base image's autostart with a launcher that delegates to
# the base image's /Metatrader/start.sh. That script does the heavy
# lifting (installs Python embed + pip in wine, starts the mt5linux
# rpyc server, then mt5copy_bridge on :8003, then mt5copy_worker on
# :8002). Operational profile + MT5_HEADLESS=1 keeps the desktop
# quiet (no MetaEditor window) and MT5_PUBLISHER_BOOTSTRAP_UI=0 means
# the bridge does the publishing — no MQL5 SlotService.mq5 needed
# (so MT5's "Allow services" toggle is irrelevant).
#
# Trade-off vs the previous minimal launcher: 2-3 min first-boot vs
# 10 s, because of the wine-mono + Python embed + pip install. We
# accept this because the trade gives us a fully automated MT5
# control path that the slot can drive via the bridge's HTTP API.
#
# The slot's src/services/mt5-bridge-adapter.py runs as its own s6
# service below; it talks to the bridge on :8003 and bridges between
# the bridge's HTTP API and the slot's existing ZMQ protocol
# (tcp://5556 cmd / tcp://5557 events).
ENV MT5_RUNTIME_PROFILE=operational \
    MT5_HEADLESS=1 \
    MT5_PUBLISHER_BOOTSTRAP_UI=0 \
    MT5COPY_BRIDGE_PORT=8003 \
    MT5COPY_WORKER_PORT=8002
RUN cat > /config/.config/openbox/autostart <<'AUTOSTART'
#!/bin/sh
export DISPLAY=:0
export WINEPREFIX=/config/.wine
export WINEDEBUG=-all
exec /Metatrader/start.sh
AUTOSTART
RUN chmod +x /config/.config/openbox/autostart \
 && chown abc:abc /config/.config/openbox/autostart \
 && chown -R abc:abc /config/.wine

# akroncloud-slot — bridge-adapter: Python ZMQ↔HTTP bridge that
# translates between the slot's existing ZMQ protocol (tcp://5556
# inbound commands, tcp://5557 outbound events) and the
# akron-mt5-base's mt5copy_bridge HTTP API on :8003. The bridge
# runs INSIDE the container (started by /Metatrader/start.sh from
# the autostart above) and is what gives us a fully automated path
# to MT5 — no MQL5 services, no "Allow services" toggle.
#
# The adapter waits up to 10 min for the bridge to come up
# (start.sh does a 2-3 min first-boot that installs wine-mono +
# Python embed + pip + mt5linux + bridge). After that, every
# POLL_INTERVAL_MS it polls /health, /action (positions, orders,
# runtime) and emits ZMQ events to the slot on tcp://5557.
COPY --chown=root:root src/services/mt5-bridge-adapter.py /opt/akron-mt5-bridge-adapter.py
RUN mkdir -p /etc/s6-overlay/s6-rc.d/svc-mt5-bridge-adapter && \
    printf '#!/usr/bin/with-contenv bash\nexec /usr/local/bin/python3 /opt/akron-mt5-bridge-adapter.py\n' \
      > /etc/s6-overlay/s6-rc.d/svc-mt5-bridge-adapter/run && \
    chmod +x /etc/s6-overlay/s6-rc.d/svc-mt5-bridge-adapter/run && \
    printf 'longrun\n' > /etc/s6-overlay/s6-rc.d/svc-mt5-bridge-adapter/type && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-mt5-bridge-adapter

# SlotService.ex5 ships pre-compiled in the repo (mql5/SlotService.ex5).
# The compile step we used to do in-container required metaeditor64 +
# an X server, which doesn't fit a headless docker build. The ex5
# is compiled once locally with MetaEditor (see mql5/SlotService.mq5
# for the source) and committed to the repo, then baked into the
# image at the right path. If the file is missing, the build fails
# fast so we don't ship a broken image.
COPY ["mql5/SlotService.ex5", "/config/.wine/drive_c/users/abc/MetaTrader 5/MQL5/Services/SlotService.ex5"]
RUN chown abc:abc \
   /config/.wine/drive_c/users/abc/MetaTrader\ 5/MQL5/Services/SlotService.ex5

# Register the service in the user's default profile so MT5 auto-runs
# it on every terminal boot. The service runs BEFORE any chart is
# loaded, finds the saved chart (or opens one), and ChartIndicatorAdd's
# the publisher EA onto it.
RUN mkdir -p /config/.wine/drive_c/users/abc/MetaTrader\ 5/profiles/default \
 && printf '%s\n' '[Services]' 'SlotService=SlotService.ex5' \
    > /config/.wine/drive_c/users/abc/MetaTrader\ 5/profiles/default/services.ini \
 && chown -R abc:abc /config/.wine

EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD /opt/node20/bin/node -e "fetch('http://127.0.0.1:7777/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
