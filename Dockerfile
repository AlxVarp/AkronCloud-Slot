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

# Replace the base image's autostart with a minimal launcher for
# MetaTrader 5. The base image's /Metatrader/start.sh spins up the
# mt5copy bridge + Python embed + wine-mono, which we don't need for
# the broker-login demo. Direct wine + terminal64.exe boots MT5 in ~10 s.
RUN cat > /config/.config/openbox/autostart <<'AUTOSTART'
#!/bin/sh
export DISPLAY=:0
export WINEPREFIX=/config/.wine
export WINEDEBUG=-all
exec /opt/wine-stable/bin/wine "/config/.wine/drive_c/users/abc/MetaTrader 5/terminal64.exe" /portable /skipupdate
AUTOSTART
RUN chmod +x /config/.config/openbox/autostart \
 && chown abc:abc /config/.config/openbox/autostart \
 && chown -R abc:abc /config/.wine

# SlotService MQL5 source ships in the image, dropped in the
# MQL5/Services dir. Compile it to .ex5 in this same stage using
# metaeditor64 (which the runtime image already has from the base
# akron-mt5-base) under an Xvfb so metaeditor can open its dummy
# UI. This is the same trick the parent akron-mt5-base uses to bake
# PublisherZMQEvents.ex5 into the base image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /config/.wine/drive_c/users/abc/MetaTrader\ 5/MQL5/Services \
 && cp /tmp/mql5/SlotService.mq5 /config/.wine/drive_c/users/abc/MetaTrader\ 5/MQL5/Services/SlotService.mq5 \
 && rm -rf /tmp/mql5 \
 && mkdir -p /tmp/xvfb-runtime && cd /tmp/xvfb-runtime \
 && Xvfb :99 -screen 0 1024x768x24 -ac +extension RANDR +extension RENDER >/dev/null 2>&1 & \
   XVFB_PID=$! \
 && sleep 2 \
 && export DISPLAY=:99 XDG_RUNTIME_DIR=/tmp/xvfb-runtime \
 && cd /config/.wine/drive_c/users/abc/MetaTrader\ 5/MQL5/Services \
 && WINEDEBUG=-all /opt/wine-stable/bin/wine \
       "Z:\\users\\abc\\MetaTrader 5\\metaeditor64.exe" \
       /compile:"Z:\\users\\abc\\MetaTrader 5\\MQL5\\Services\\SlotService.mq5" \
       /log:"Z:\\users\\abc\\MetaTrader 5\\MQL5\\Services\\SlotService-compile.log" \
       /dir:"Z:\\users\\abc\\MetaTrader 5\\MQL5\\Services" 2>&1 | tail -30 ; \
   echo "--- compile log ---" ; \
   cat SlotService-compile.log 2>/dev/null | tail -20 ; \
   kill $XVFB_PID 2>/dev/null ; \
   ls -la /config/.wine/drive_c/users/abc/MetaTrader\ 5/MQL5/Services/ ; \
   chown -R abc:abc /config/.wine

# Register the service in the user's default profile so MT5 auto-runs
# it on every terminal boot. The service runs BEFORE any chart is
# loaded, finds the saved chart (or opens one), and ChartIndicatorAdd's
# the publisher EA onto it.
RUN mkdir -p /config/.wine/drive_c/users/abc/MetaTrader\ 5/profiles/default \
 && printf '%s\n' '[Services]' 'SlotService=SlotService.ex5' \
    > /config/.wine/drive_c/users/abc/MetaTrader\ 5/profiles/default/services.ini \
 && chown -R abc:abc /config/.wine

# Init s6 service: compile SlotService.mq5 -> SlotService.ex5
# before the slot starts. The slot depends on svc-mt5-compile so
# this only runs once (services with type=oneshot run at boot).
#
# Why: metaeditor64 inside `docker build` fails (no DISPLAY, no
# XDG_RUNTIME_DIR). But once the container is running, Wine has a
# working X server (Xorg isn't required because metaeditor doesn't
# actually open a window for the /compile: pass; it just runs
# headless). This is a known trick from the parent akron/mt5-base
# image's documentation.
RUN mkdir -p /etc/s6-overlay/s6-rc.d/svc-mt5-compile
RUN cat > /etc/s6-overlay/s6-rc.d/svc-mt5-compile/run <<'COMPILE'
#!/usr/bin/with-contenv bash
# Only run if the .ex5 doesn't exist yet
EX5="/config/.wine/drive_c/users/abc/MetaTrader 5/MQL5/Services/SlotService.ex5"
if [ -f "$EX5" ]; then
  echo "[mt5-compile] SlotService.ex5 already present, skipping"
  exit 0
fi
# Wine needs DISPLAY + XDG_RUNTIME_DIR to run any Windows GUI
# process (even a headless compile). with-contenv exposes the
# container's env; we set these here so metaeditor finds its sockets.
export DISPLAY=:0
export XDG_RUNTIME_DIR=/run/user/0
cd /config/.wine/drive_c/users/abc/MetaTrader 5/MQL5/Services || exit 1
WINEDEBUG=-all /opt/wine-stable/bin/wine \
  "Z:\\users\\abc\\MetaTrader 5\\metaeditor64.exe" \
  /compile:"Z:\\users\\abc\\MetaTrader 5\\MQL5\\Services\\SlotService.mq5" \
  /log:"Z:\\users\\abc\\MetaTrader 5\\MQL5\\Services\\SlotService-compile.log" \
  /dir:"Z:\\users\\abc\\MetaTrader 5\\MQL5\\Services" \
  2>&1 | tail -20
if [ -f SlotService.ex5 ]; then
  echo "[mt5-compile] compiled OK"
  chown abc:abc SlotService.ex5
  exit 0
else
  echo "[mt5-compile] compile failed; see SlotService-compile.log"
  exit 0  # don't fail the slot just because we couldn't compile
fi
COMPILE
RUN printf 'oneshot\n' > /etc/s6-overlay/s6-rc.d/svc-mt5-compile/type
RUN touch /etc/s6-overlay/s6-rc.d/svc-mt5-compile/up
RUN chmod +x /etc/s6-overlay/s6-rc.d/svc-mt5-compile/run \
 && touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-mt5-compile

EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD /opt/node20/bin/node -e "fetch('http://127.0.0.1:7777/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
