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

# v55 — AccountReporter chart indicator + mt5-state-bridge Python service.
# Unlike SlotService.ex5 (which is a #property service that doesn't
# autostart on fresh WINEPREFIX), AccountReporter is a chart indicator
# that autostarts the moment any chart is loaded in MT5. It writes
# account state (balance/equity/login/server) to MQL5/Files/slot-state.json
# every PollSeconds. The mt5-state-bridge watches that file and forwards
# to the slot's Mt5TcpServer (TCP 127.0.0.1:7778) on the same wire
# protocol SlotService.ex5 would have used.
#
# The compiled .ex5 must be checked into the repo at
# mql5/AccountReporter.ex5 — the source is in mql5/AccountReporter.mq5
# and was compiled outside this sandbox (metaeditor64.exe CLI is broken
# in wine 11.0 here). Until the .ex5 is committed, this COPY will
# fail the docker build — that's intentional, it surfaces the missing
# artifact instead of silently shipping an indicator-less image.
COPY ["mql5/AccountReporter.ex5", "/config/.wine/drive_c/Program Files/MetaTrader 5/MQL5/Indicators/AccountReporter.ex5"]
RUN chown abc:abc \
   "/config/.wine/drive_c/Program Files/MetaTrader 5/MQL5/Indicators/AccountReporter.ex5"

# v55 auto-attach: edit every Profiles/Charts/<Profile>/chart*.chr to
# include AccountReporter in its <indicator> list. MT5 restores the
# .chr state on every boot, so the indicator comes back automatically
# — no manual Navigator-drag, no template wiring, zero user steps.
# Idempotent: the script checks for an existing AccountReporter entry
# before adding. Charts that lack an AccountReporter line get one
# injected right before </window>.
COPY scripts/inject-account-reporter.py /usr/local/bin/inject-account-reporter.py
RUN chmod +x /usr/local/bin/inject-account-reporter.py && \
    /usr/local/bin/inject-account-reporter.py 2>&1 | sed 's/^/  [inject] /'

COPY --chown=root:root src/services/mt5-state-bridge.py /opt/akron-mt5-state-bridge.py
RUN mkdir -p /etc/s6-overlay/s6-rc.d/svc-mt5-state-bridge && \
    printf '#!/usr/bin/with-contenv bash\nexec /usr/bin/python3 /opt/akron-mt5-state-bridge.py\n' \
      > /etc/s6-overlay/s6-rc.d/svc-mt5-state-bridge/run && \
    chmod +x /etc/s6-overlay/s6-rc.d/svc-mt5-state-bridge/run && \
    printf 'longrun\n' > /etc/s6-overlay/s6-rc.d/svc-mt5-state-bridge/type && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-mt5-state-bridge

# SlotService.ex5 ships pre-compiled in the repo (mql5/SlotService.ex5).
# Service mode (commits a606493 + 0499462): #property service,
# registered in services.ini + Wine registry below. MT5 launches
# it at terminal startup, before any chart is loaded — no chart-
# template dependency, no manual attach.
#
# v52: paths moved from `users/abc/MetaTrader 5/` to
# `Program Files/MetaTrader 5/`. The autostart (above) launches
# the Program Files terminal64.exe, so the service binary and its
# config MUST live in the same install. The user-space MT5 dir
# is an akron-mt5-base artifact (carried over from /Metatrader/start.sh
# pre-ad1965e) that the slot never uses.
#
# Phase C / Ruta B1: the service talks to the slot over a TCP socket
# on 127.0.0.1:7778 (newline-delimited JSON). This requires
# `AllowDllImport=1` in terminal.ini (set below) so MQL5 can load
# ws2_32.dll via #import. See docs/plans/PHASE_C_RTA_B1_TCP_SOCKET.md
# for the wire protocol.
#
# Compiled inside ghcr.io/alxvarp/akron-mt5-base:mt5-preinstalled
# with MetaEditor64.exe via Wine (see mql5/SlotService.mq5 for the
# source).
COPY ["mql5/SlotService.ex5", "/config/.wine/drive_c/Program Files/MetaTrader 5/MQL5/Services/SlotService.ex5"]
RUN chown abc:abc \
   "/config/.wine/drive_c/Program Files/MetaTrader 5/MQL5/Services/SlotService.ex5"

# Phase C / Ruta B1: allow DLL imports so SlotService can use
# ws2_32 (TCP sockets). Without this, MQL5 silently refuses to
# load ws2_32.dll and the service won't be able to connect to
# the slot's TCP server.
#
# v52: also enable `AllowServices` (the MQL5 service-mode toggle
# in Tools → Options → Expert Advisors) and `AllowAlgoTrading` so
# the service auto-launches on first MT5 boot. Without these
# toggles MT5 silently ignores services.ini and the registry
# Services\ subkey, and the slot gets `loggedIn: false` forever
# (see docs/sessions/2026-07-22-slot-service-autoenable.md §2).
# Idempotent: re-applying the image over an existing WINEPREFIX
# just upserts the keys.
RUN MT5_TI="/config/.wine/drive_c/Program Files/MetaTrader 5/Config/terminal.ini" \
 && mkdir -p "$(dirname "$MT5_TI")" \
 && touch "$MT5_TI" \
 && export MT5_TI \
 && python3 <<'PY'
import os, re
p = os.environ['MT5_TI']
with open(p) as f: txt = f.read()
# Find or append the [Experts] block; ensure the three toggles.
m = re.search(r'(\[Experts\][^\n]*\n)([^\[]*?)(?=\n\[|\Z)', txt, re.S)
def ensure(lines, key, val):
    if not re.search(rf'^{re.escape(key)}=', lines, re.M):
        return lines.rstrip('\n') + f'\n{key}={val}\n'
    return lines
if m:
    head, body = m.group(1), m.group(2)
    body = ensure(body, 'AllowDllImport',  '1')
    body = ensure(body, 'AllowServices',   '1')
    body = ensure(body, 'AllowAlgoTrading', '1')
    txt = txt[:m.start()] + head + body + txt[m.end():]
else:
    txt = txt.rstrip('\n') + '\n\n[Experts]\nAllowDllImport=1\nAllowServices=1\nAllowAlgoTrading=1\n'
with open(p, 'w') as f: f.write(txt)
PY
RUN chown abc:abc "/config/.wine/drive_c/Program Files/MetaTrader 5/Config/terminal.ini"

# Register the service in the Program Files default profile so MT5
# auto-runs it on every terminal boot. The service connects to
# the slot's TCP socket on 127.0.0.1:7778 and exchanges JSON
# frames (newlines) for commands and events.
#
# v52: same path fix as above — moved from
# `users/abc/MetaTrader 5/profiles/default/` to
# `Program Files/MetaTrader 5/Profiles/Default/`. MT5 case-sensitive
# matches the path: `Profiles` (uppercase P) and `Default` (uppercase
# D) on a case-sensitive filesystem.
RUN mkdir -p "/config/.wine/drive_c/Program Files/MetaTrader 5/Profiles/Default" \
 && printf '[Services]\nSlotService=SlotService.ex5\n' \
    > "/config/.wine/drive_c/Program Files/MetaTrader 5/Profiles/Default/services.ini"

# v52: also stamp the service into the Wine registry under
# HKCU\Software\MetaQuotes Software\MetaTrader 5\Services\SlotService.
# MT5's "Services" tab in the Navigator reads from this key. Without
# the registry stamp, the .ex5 in MQL5/Services/ is on disk but
# MT5's service loader skips it on the first launch. The keys are
# the same set the GUI sets when you right-click → Add Service in
# the Navigator and toggle AutoStart.
RUN python3 - <<'PY'
import re
p = "/config/.wine/user.reg"
try:
    with open(p) as f: txt = f.read()
except FileNotFoundError:
    open(p, 'w').close(); txt = ""

# 1. AllowServices / AllowAlgoTrading under
#    Software\MetaQuotes Software\MetaTrader 5\Settings
SETTINGS = r'[Software\\MetaQuotes Software\\MetaTrader 5\\Settings]'
m = re.search(rf'({re.escape(SETTINGS)}[^\n]*\n#time=[a-f0-9]+\n)([^\[]*?)(?=\n\[|\Z)', txt, re.S)
def ensure_block(body, pairs):
    for k, v in pairs:
        if not re.search(rf'^{re.escape(k)}=', body, re.M):
            body = body.rstrip('\n') + f'\n"{k}"=dword:{v}\n'
    return body
if m:
    head, body = m.group(1), m.group(2)
    body = ensure_block(body, [('AllowAlgoTrading', '00000001'),
                                ('AllowServices',   '00000001')])
    txt = txt[:m.start()] + head + body + txt[m.end():]
else:
    txt += (
        f'\n{SETTINGS} 1784529275\n#time=1dd1811d496d02a\n'
        f'"AllowAlgoTrading"=dword:00000001\n'
        f'"AllowServices"=dword:00000001\n'
    )

# 2. Services\SlotService subkey with the same fields the GUI
#    writes when you add a service and toggle "Start with terminal".
SVC = r'[Software\\MetaQuotes Software\\MetaTrader 5\\Services\\SlotService]'
if SVC not in txt:
    txt += (
        f'\n{SVC} 1784529275\n'
        f'#time=1dd1811d496d02a\n'
        f'"Allow"=dword:00000001\n'
        f'"AutoStart"=dword:00000001\n'
        f'"Enabled"=dword:00000001\n'
        f'"Name"="SlotService"\n'
        f'"Path"="C:\\\\Program Files\\\\MetaTrader 5\\\\MQL5\\\\Services\\\\SlotService.ex5"\n'
    )

with open(p, 'w') as f: f.write(txt)
PY

RUN chown -R abc:abc /config/.wine

# ─── v54: Python 3.9.13 (amd64) + MetaTrader5 + numpy in the wineprefix ──
# Goal: the slot needs `balance: N, equity: M` in /v1/state without the
# user having to manually enable SlotService.ex5 (which doesn't autostart
# on a fresh WINEPREFIX). The standard MT5 Python integration does this:
# a Python script under wine calls `MetaTrader5.initialize()` +
# `mt5.account_info()` and pushes the result to the slot over TCP 7778.
# The user only has to log in to MT5 normally — no MQL5 service, no VNC
# clicks.
#
# Idempotent: re-applying the image over an existing WINEPREFIX just
# upserts the install. We gate on `/config/.wine/drive_c/Python39/python.exe`.
#
# Install path: /config/.wine/drive_c/Python39/ (64-bit). The base image
# already has a 32-bit Python at C:\Python39-32\ for MQL5 scripts — we
# leave it alone.
#
# Pinned wheels (verified working in 2026-07-22 step1-validation test
# container). Hashes live in the URL — PyPI serves them at the path.
RUN WINEPREFIX=/config/.wine \
    PY64="$WINEPREFIX/drive_c/Python39" \
 && if [ ! -x "$PY64/python.exe" ]; then \
      echo "[v54] Installing 64-bit Python + MetaTrader5 into wineprefix..." && \
      mkdir -p /tmp/setup && cd /tmp/setup && \
      curl -fsSL -o py64.zip \
        https://www.python.org/ftp/python/3.9.13/python-3.9.13-embed-amd64.zip && \
      curl -fsSL -o mt5.whl \
        https://files.pythonhosted.org/packages/6a/05/2da597e23c6ab603ebb1afe0925e6c17656830948987c13768890202cb59/metatrader5-5.0.5735-cp39-cp39-win_amd64.whl && \
      curl -fsSL -o numpy.whl \
        https://files.pythonhosted.org/packages/b5/42/054082bd8220bbf6f297f982f0a8f5479fcbc55c8b511d928df07b965869/numpy-1.26.4-cp39-cp39-win_amd64.whl && \
      mkdir -p "$PY64" && \
      (cd "$PY64" && unzip -q /tmp/setup/py64.zip) && \
      echo 'Lib\\site-packages' >> "$PY64/python39._pth" && \
      mkdir -p "$PY64/Lib/site-packages" && \
      unzip -q /tmp/setup/mt5.whl -d /tmp/setup/mt5_extract && \
      cp -r /tmp/setup/mt5_extract/MetaTrader5 "$PY64/Lib/site-packages/" && \
      unzip -q /tmp/setup/numpy.whl -d /tmp/setup/np_extract && \
      cp -r /tmp/setup/np_extract/numpy "$PY64/Lib/site-packages/" && \
      cp -r /tmp/setup/np_extract/numpy-1.26.4.dist-info "$PY64/Lib/site-packages/" && \
      cp -r /tmp/setup/np_extract/numpy.libs "$PY64/Lib/site-packages/" && \
      cp "$WINEPREFIX/drive_c/windows/system32/msvcp140.dll"     "$PY64/" && \
      cp "$WINEPREFIX/drive_c/windows/system32/vcruntime140.dll" "$PY64/" && \
      cp "$WINEPREFIX/drive_c/windows/system32/vcruntime140_1.dll" "$PY64/" && \
      cp "$WINEPREFIX/drive_c/windows/system32/ucrtbase.dll"     "$PY64/" && \
      rm -rf /tmp/setup && \
      echo "[v54] 64-bit Python + MetaTrader5 install complete at $PY64"; \
    else \
      echo "[v54] 64-bit Python already installed at $PY64 — skipping"; \
    fi \
 && chown -R abc:abc "$PY64"

# ─── v54: mt5-account-publisher.py — pushes account events to slot ───
# Sits alongside slot's Mt5TcpServer (TCP 127.0.0.1:7778, newline-
# delimited JSON, same wire protocol as SlotService.ex5 would use).
# Reads `mt5.account_info()` on a 1.5s poll, diffs against last frame,
# publishes only on change.
COPY src/services/mt5-account-publisher.py /opt/akron-mt5-account-publisher.py
RUN chmod +x /opt/akron-mt5-account-publisher.py

# ─── v54: s6 service — runs account-publisher after MT5 is up ────────
# Longrun, depends on svc-de (the openbox session that launches MT5).
# Sets the env vars the recipe needs (WINEPREFIX, HOME, XDG_RUNTIME_DIR,
# DISPLAY, PYTHONHASHSEED=0). PYTHONHASHSEED=0 is mandatory because
# wine's advapi32.SystemFunction036 is unimplemented and crashes Python
# before any code runs.
RUN mkdir -p /etc/s6-overlay/s6-rc.d/svc-mt5-account-publisher
RUN cat > /etc/s6-overlay/s6-rc.d/svc-mt5-account-publisher/run <<'EOSVCAP'
#!/usr/bin/with-contenv bash
export WINEPREFIX=/config/.wine
export WINEDEBUG=-all
export HOME=/config
export XDG_RUNTIME_DIR=/config/.XDG
export DISPLAY=:0
export PYTHONHASHSEED=0
cd /config
exec s6-setuidgid abc /opt/wine-stable/bin/wine \
  /config/.wine/drive_c/Python39/python.exe \
  /opt/akron-mt5-account-publisher.py
EOSVCAP
RUN chmod +x /etc/s6-overlay/s6-rc.d/svc-mt5-account-publisher/run
RUN printf 'longrun\n' > /etc/s6-overlay/s6-rc.d/svc-mt5-account-publisher/type
RUN mkdir -p /etc/s6-overlay/s6-rc.d/svc-mt5-account-publisher/dependencies.d && \
    ln -sfn /etc/s6-overlay/s6-rc.d/svc-de \
            /etc/s6-overlay/s6-rc.d/svc-mt5-account-publisher/dependencies.d/svc-de
RUN touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-mt5-account-publisher

EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD /opt/node20/bin/node -e "fetch('http://127.0.0.1:7777/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
