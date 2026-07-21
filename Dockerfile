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
# ─── Defense-in-depth: xmrig sanitizer ────────────────────────────
# On 2026-07-20 the akron-mt5-base image came pre-installed with the
# xmrig Monero miner at /config/xmrig + /config/xmrigARM and an
# attacker-attractive KasmVNC desktop exposed on host :3000 with no
# VNC auth. The miner was launched interactively from an openbox
# xterm session and burned ~764% CPU. We:
#   1. Removed public :3000 publish (commit adeed94).
#   2. Kill the miner on contact if it appears in the running
#      container via this oneshot - so any future rebuild, paste, or
#      image-side re-introduction gets wiped before the slot starts.
# The actual binaries DO NOT PERSIST across container recreates
# because /config isn't a volume in our docker-compose. This script
# is belt + braces.
RUN mkdir -p /etc/s6-overlay/s6-rc.d/svc-sanitize /etc/s6-overlay/s6-rc.d/svc-sanitize/dependencies.d && \
    printf '#!/usr/bin/with-contenv bash\n\
# Nuke common crypto miner drop locations in the abc user home.\n\
# /config is ephemeral on this compose (no volume mount), so this\n\
# script only protects against in-image miner preinstalls that\n\
# re-appear after a docker compose pull.\n\
set -u\n\
LOG=/var/log/sanitize.log\n\
log() { printf "[%%s] %%s\\n" "$(date -Iseconds)" "$*" >>"$LOG"; }\n\
log "scanning /config for miner binaries"\n\
for p in /config/xmrig /config/xmrigARM /config/.config/xmrig \\\n\
         /home/kasm-user/xmrig /home/kasm-user/xmrigARM \\\n\
         /tmp/xmrig /tmp/xmrigARM; do\n\
  if [[ -e "$p" ]]; then\n\
    log "removing $p"\n\
    rm -rf "$p" 2>>"$LOG"\n\
  fi\n\
done\n\
# Restore the default openbox autostart in case it was clobbered. The\n\
# original lives at /defaults/autostart; copy back if /config version\n\
# diverges from the image default and differs from our legit wrapper.\n\
if [[ -f /defaults/autostart ]] && [[ -f /config/.config/openbox/autostart ]]; then\n\
  if ! grep -q "MetaTrader 5/terminal64.exe" /config/.config/openbox/autostart; then\n\
    log "openbox autostart is not ours - restoring from /defaults"\n\
    cp /defaults/autostart /config/.config/openbox/autostart\n\
  fi\n\
fi\n\
log "done"\n\
sleep infinity\n' \
      > /etc/s6-overlay/s6-rc.d/svc-sanitize/run && \
    chmod +x /etc/s6-overlay/s6-rc.d/svc-sanitize/run && \
    printf 'longrun\n' > /etc/s6-overlay/s6-rc.d/svc-sanitize/type && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-sanitize

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

# Replace the base image's autostart with a minimal launcher that
# starts the program-files MT5 directly. R2 (Phase B+) does NOT need
# the mt5copy_bridge / mt5copy_worker / mt5linux_server stack — the
# chart-indicator SlotService.mq5 talks to the slot's bridge-adapter
# purely via MQL5/Files/ (the bridge-adapter is a Python file-watcher
# that translates those files to/from ZMQ :5556/:5557).
#
# Service mode (commits a606493 + 0499462): SlotService.mq5 is a
# #property service, registered in services.ini below. MT5 launches
# it at terminal startup, BEFORE any chart is loaded. No chart-
# template dependency, no manual attach. The bridge-adapter
# consumes the files the service writes to MQL5/Files/.
ENV WINEDEBUG=-all
RUN cat > /config/.config/openbox/autostart <<'AUTOSTART'
#!/bin/sh
export DISPLAY=:0
export WINEPREFIX=/config/.wine
export HOME=/config
export XDG_RUNTIME_DIR=/config/.XDG
# Start the program-files MT5. /Metatrader/start.sh is no longer
# needed because the chart-indicator does the heavy lifting (it
# publishes events/state to MQL5/Files/, the bridge-adapter pushes
# them to ZMQ). start.sh's role was to host the bridge on :8003
# which we don't need anymore.
exec /opt/wine-stable/bin/wine "/config/.wine/drive_c/Program Files/MetaTrader 5/terminal64.exe" /portable /skipupdate
AUTOSTART
RUN chmod +x /config/.config/openbox/autostart \
 && chown abc:abc /config/.config/openbox/autostart \
 && chown -R abc:abc /config/.wine

# Ensure MQL5/Files/ exists so the chart-indicator can write there from
# the moment it attaches (otherwise the first write might race).
RUN mkdir -p "/config/.wine/drive_c/users/abc/MetaTrader 5/MQL5/Files" \
 && chown -R abc:abc "/config/.wine/drive_c/users/abc/MetaTrader 5/MQL5"

# akroncloud-slot — bridge-adapter: Python file-watcher that translates
# between the slot's existing ZMQ protocol (tcp://5556 inbound
# commands, tcp://5557 outbound events) and the MQL5 chart-indicator's
# MQL5/Files/ file interface (slot-events.jsonl, slot-state.json,
# slot-cmd.json, slot-resp.jsonl). Replaces the old HTTP-to-bridge
# proxy. No HTTP server, no mt5linux_server, no rpyc — just file I/O
# + ZMQ.
RUN /usr/bin/pip3 install --break-system-packages --no-cache-dir watchdog
COPY --chown=root:root src/services/mt5-bridge-adapter.py /opt/akron-mt5-bridge-adapter.py
RUN mkdir -p /etc/s6-overlay/s6-rc.d/svc-mt5-bridge-adapter && \
    printf '#!/usr/bin/with-contenv bash\nexec /usr/bin/python3 /opt/akron-mt5-bridge-adapter.py\n' \
      > /etc/s6-overlay/s6-rc.d/svc-mt5-bridge-adapter/run && \
    chmod +x /etc/s6-overlay/s6-rc.d/svc-mt5-bridge-adapter/run && \
    printf 'longrun\n' > /etc/s6-overlay/s6-rc.d/svc-mt5-bridge-adapter/type && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-mt5-bridge-adapter

# SlotService.ex5 ships pre-compiled in the repo (mql5/SlotService.ex5).
# Service mode (commits a606493 + 0499462): #property service,
# registered in services.ini below. MT5 launches it at terminal
# startup, before any chart is loaded — no chart-template
# dependency, no manual attach.
#
# Phase C / Ruta B1: the service talks to the slot over a TCP socket
# on 127.0.0.1:7778 (newline-delimited JSON), NOT via MQL5/Files/.
# This requires `AllowDllImport=1` in terminal.ini (set below) so
# MQL5 can load ws2_32.dll via #import. See
# docs/plans/PHASE_C_RTA_B1_TCP_SOCKET.md for the wire protocol.
#
# Compiled inside ghcr.io/alxvarp/akron-mt5-base:mt5-preinstalled
# with MetaEditor64.exe via Wine (see mql5/SlotService.mq5 for the
# source).
COPY ["mql5/SlotService.ex5", "/config/.wine/drive_c/users/abc/MetaTrader 5/MQL5/Services/SlotService.ex5"]
RUN chown abc:abc \
   /config/.wine/drive_c/users/abc/MetaTrader\ 5/MQL5/Services/SlotService.ex5

# Phase C / Ruta B1: allow DLL imports so SlotService can use
# ws2_32 (TCP sockets). Without this, MQL5 silently refuses to
# load ws2_32.dll and the service won't be able to connect to
# the slot's TCP server.
RUN mkdir -p "/config/.wine/drive_c/users/abc/MetaTrader 5/Config" \
 && if ! grep -q '^\[Experts\]' "/config/.wine/drive_c/users/abc/MetaTrader 5/Config/terminal.ini" 2>/dev/null; then \
      printf '\n[Experts]\nAllowDllImport=1\n' \
        >> "/config/.wine/drive_c/users/abc/MetaTrader 5/Config/terminal.ini"; \
    fi \
 && chown abc:abc "/config/.wine/drive_c/users/abc/MetaTrader 5/Config/terminal.ini"

# Register the service in the user's default profile so MT5
# auto-runs it on every terminal boot. The service connects to
# the slot's TCP socket on 127.0.0.1:7778 and exchanges JSON
# frames (newlines) for commands and events.
RUN mkdir -p "/config/.wine/drive_c/users/abc/MetaTrader 5/profiles/default" \
 && printf '%s\n' '[Services]' 'SlotService=SlotService.ex5' \
    > "/config/.wine/drive_c/users/abc/MetaTrader 5/profiles/default/services.ini" \
 && chown -R abc:abc /config/.wine

EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD /opt/node20/bin/node -e "fetch('http://127.0.0.1:7777/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
