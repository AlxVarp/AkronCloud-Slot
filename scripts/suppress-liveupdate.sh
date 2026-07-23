#!/bin/bash
# Persistent suppression of MT5's stuck-liveupdate behavior.
#
# MT5 build 5836 (current as of 2026-07) on first boot in Wine 11.0
# tries to fetch a terminal update from `downloads.metaquotes-net.com`.
# The download sometimes succeeds but the install hangs, leaving
# zombie `terminal64.exe /update` subprocesses that block the
# normal terminal from launching. This in turn prevents SlotService.ex5
# (#property service) from running, so the v2.11 command server on
# port 7779 never opens.
#
# We used to delete the liveupdate/ directory once at boot (see
# Dockerfile: svc-strip-mt5-liveupdate). That worked initially but
# MT5 recreates the directory within seconds, restarting the loop.
# This script runs forever (s6 longrun) and uses three layers of
# defense that together cover all the ways MT5 could respawn the
# stuck liveupdate subprocess.
#
#   1. Network block: iptables OUTPUT drops TCP to the update server.
#      Once MT5 can't reach downloads.metaquotes-net.com, the
#      liveupdate subprocess fails fast and exits.
#   2. Process block: pkill any terminal64.exe /update subprocess every
#      2 s. Catches any liveupdate process that already spawned
#      (e.g. while iptables was still being applied, or for alternate
#      update servers MT5 might try).
#   3. Filesystem block: rm -rf the liveupdate/ subdir every 2 s.
#      Catches any dir MT5 manages to recreate before its next
#      subprocess invocation finds it.
#
# Three layers because MT5 has multiple ways to start the liveupdate
# subprocess and we want to make sure the normal terminal64.exe wins
# the race to keep its port/files. Any single layer could be defeated
# by a future MT5 build; together they form a tight net.

set -u

LOG=/var/log/suppress-liveupdate.log
PROFILES_DIR=/config/.wine/drive_c/users/abc/AppData/Roaming/MetaQuotes/Terminal

log() { printf "[%s] %s\n" "$(date -Iseconds)" "$*" >>"$LOG"; }

# --- One-shot bootstrap ---

# Layer 1: block the MetaQuotes update server. Three attempts:
#   1. Domain string match (precise; needs `-m string` module)
#   2. Owner match on the abc user (works without -m string; kills
#      MT5's outbound HTTPS entirely — the terminal doesn't need it)
#   3. Plain REJECT (no -m required; returns ICMP-unreachable which
#      causes liveupdate to fail-fast and fall through to normal boot)
# We try them in order; first success wins. iptables inside Docker
# sometimes refuses rules depending on the network capabilities of
# the container, so multiple fallbacks are worth it.
if command -v iptables >/dev/null 2>&1; then
    if iptables -I OUTPUT -p tcp --dport 443 \
        -m string --string 'downloads.metaquotes-net.com' \
        --algo kmp -j DROP 2>/dev/null; then
        log "layer 1: blocked downloads.metaquotes-net.com:443 (iptables string)"
    elif iptables -I OUTPUT -p tcp --dport 443 \
        -m owner --uid-owner abc -j REJECT 2>/dev/null; then
        log "layer 1: blocked ALL outbound 443 from user abc (iptables owner)"
    elif iptables -I OUTPUT -p tcp --dport 443 -j REJECT 2>/dev/null; then
        log "layer 1: blocked ALL outbound TCP 443 (broad REJECT — MetaQuotes liveupdate was the only HTTPS dependency we observed)"
    else
        log "WARN: iptables rule add failed — relying on layers 2 + 3 only"
    fi
else
    log "WARN: iptables not found — relying on layers 2 + 3 only"
fi

# Layer 2 (one-shot): nuke any liveupdate subprocess that was already
# running when this service starts. The watchdog below keeps it clean
# from here on.
pkill -9 -f 'terminal64.exe /update' 2>/dev/null || true

# Layer 3 (one-shot): wipe any liveupdate/ subdir already on disk
# so the next MT5 boot doesn't pick them up.
if [[ -d "$PROFILES_DIR" ]]; then
    while IFS= read -r lu; do
        rm -rf "$lu" && log "removed pre-existing $lu"
    done < <(find "$PROFILES_DIR" -mindepth 2 -maxdepth 2 -type d -name liveupdate 2>/dev/null)
fi

log "watchdog started (pid=$$)"

# --- Watchdog loop ---

while true; do
    sleep 2

    # Layer 2: kill any liveupdate subprocess. The /update flag is
    # only used by liveupdate subprocesses; the normal terminal uses
    # /portable /skipupdate. So a /update process is always a zombie.
    pkill -9 -f 'terminal64.exe /update' 2>/dev/null || true

    # Layer 3: remove liveupdate/ subdirs. MT5 may recreate this dir
    # between our removes — that's fine, we'll catch the next instance.
    if [[ -d "$PROFILES_DIR" ]]; then
        while IFS= read -r lu; do
            rm -rf "$lu"
        done < <(find "$PROFILES_DIR" -mindepth 2 -maxdepth 2 -type d -name liveupdate 2>/dev/null)
    fi
done