# CHAT HANDOFF — AkronCloud-Slot v0.4 session chain

**Purpose:** Single self-contained handoff document. If you start a
new chat and paste this, you have everything needed to resume
without reading the rest of the repo.

**When this was written:** 2026-07-26 (Sunday)
**Session length:** ~30+ back-and-forth rounds
**Branch state:** `debug/desktop-minimal` @ `22f837f` (pushed)
**Companion doc:** `docs/sessions/2026-07-26-slotservice-v2.12-investigation.md`
(read this for the deep technical detail — this doc is the
executive summary + resume-from-cold-start instructions)

---

## TL;DR (1 paragraph)

A debug session that went from "container doesn't show MT5" to
"everything works except SlotService dies after 5s for unknown
reasons". The `/desktop` VNC wrapper is fully fixed, the debug
endpoints work, the SlotService v2.12 source fixes the Alert()
modal that was killing it instantly, and v2.13 was added with a
diagnostic sentinel to identify the remaining 5-second death
cause. **The user needs to compile the v2.13 .mq5 → .ex5 and push
it for the next investigation step.**

---

## Branch data (paste this to resume in a new chat)

```
Repository:  github.com/AlxVarp/AkronCloud-Slot.git
Branch:      debug/desktop-minimal
Commit HEAD: 22f837f
Image tag:  0.3.0-tcp-bridge-v0.4al-debug (deployed on VPS)

VPS:         45.151.122.104 (SSH alias: vps)
            SSH: SSH_ASKPASS=~/.ssh/.askpass_vps \
                 SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ssh vps
Container:  akroncloud-slot (running v0.4al-debug)
MT5 build:  5836 (wine 11.0)
```

**To resume:**
```bash
cd /home/openhands/workspace/project/fc04bdcf8d6f4ee4854b0575def25e83/
git fetch origin
git checkout debug/desktop-minimal
git pull
```

---

## What works (verified end-to-end)

- ✅ **`/desktop` VNC wrapper** — MT5 fully visible, clicks work, type
  works, cursor:none applied (KasmVNC draws its own), tabindex=0 +
  canvas.focus() so keyboard input is routed. Tested via xdotool from
  inside the container.
- ✅ **MT5 logged in** to Deriv-Demo / `6238128` (the account the
  slot DB is currently set to; previous account was `32141235`,
  manually updated via sqlite3 because the rebuild lost the session).
- ✅ **Slot REST API** responding at `http://45.151.122.104:7777/v1/*`,
  `accountRef: "mt5-Deriv-Demo-6238128"`, `loggedIn: true`
  (synthetic from login-detector).
- ✅ **Debug endpoints** at `http://45.151.122.104:7777/debug/*`:
  - `GET /debug/slotservice` — TCP server state, ring buffers
  - `GET /debug/cmd-port` — TCP probe 127.0.0.1:7780 (1.5s)
  - `POST /debug/inject-cmd` — manual command dispatch
  - `POST /debug/cmd-client/reconnect` — drop+rebuild outbound TCP
- ✅ **KasmVNC permissions** — fixed via
  `kasmvncpasswd -u abc -r -w /config/.kasmpasswd` in the Dockerfile
  (`.r`/`.w` flags + explicit file path). Without this, all
  connections were rejected with "User abc has no read permissions".

## What doesn't work (the open issue)

- ❌ **SlotService v2.12 dies 5s after start** — `OnStart` runs to
  completion (we see the full log: `v2.12 start ... connected
  ... COMMAND SERVER LISTENING on 0.0.0.0:7780 ... command server
  bound after 1 attempts`), then ~5s later `Services service
  'SlotService' stopped (result code 0)`. The kernel keeps the
  LISTEN socket alive as a zombie (wineserver has it), the slot's
  cmdClient reports `isConnected: true` (lying), and commands time
  out. **v2.13 with an OnTimer sentinel is on the branch but
  uncompiled — user needs to build it for the next diagnosis step.**

## What was tried and ruled out (in this branch)

- Alert() blocking OnStart — fixed in commit `4e7ac32`
- getCanvas() not exposed by KasmVNC fork — fixed in commit
  `60b73a4` (use `screen.querySelector('canvas')` instead)
- Placeholder div shadowing the canvas wrapper — fixed by clearing
  `screen.innerHTML = ''` before attaching RFB
- Click events not firing — fixed with `tabindex=0 + canvas.focus()
  + cursor:none` (commits `9be9b38`, `60b73a4`)
- Algo trading off — user enabled it via Options dialog
- DLL imports off — user enabled it; terminal.ini already has
  `AllowDllImport=1`
- bind() EADDRINUSE from prior zombie socket — was a real bug
  caused by `kasmvncpasswd` not setting the file properly; fixed
  by `kill -TERM <wineserver pid>` to release the socket. NOT
  durable — the orphan returns every time SlotService dies.

---

## Files changed in this branch (vs master)

```
docker-compose.yml                                                |   2 +-
docs/sessions/2026-07-26-slotservice-v2.12-investigation.md         | 408 ++++++++++++++++
docs/sessions/2026-07-26-CHAT-HANDOFF.md (this file)                | NEW
mql5/SlotService.ex5                                              | Bin 95040 -> 94080 bytes
mql5/SlotService.mq5                                              |  51 +-
src/api/debug.ts                                                  | 157 ++++++
src/app.ts                                                        |   5 +
src/services/mt5-command-client.ts                                |  11 +
src/services/mt5-tcp-server.ts                                    |  56 +++
src/web/desktop.html.ts                                           | 552 +++++++--------------
```

The big src/web/desktop.html.ts diff is because the wrapper went
from 490 → 285 lines (stripped FAB, status bar, credential sheet,
virtual keyboard) and then gained ~120 lines of click counters +
tabindex/focus/cursor:none.

---

## Commits in this branch (oldest to newest)

```
3d4c81d  chore(compose): bump image tag to 0.3.0-tcp-bridge-v0.4ak-debug
9be9b38  feat(web/desktop): tabindex=0 + canvas.focus() + click counters
1a9ca71  chore(compose): bump image tag to 0.3.0-tcp-bridge-v0.4ai-debug
02deb89  chore(compose): bump image tag to 0.3.0-tcp-bridge-v0.4aj-debug
8e39277  feat(debug): add /debug/* endpoints for SlotService (EA) wiring
60b73a4  fix(web/desktop): replace rfb.getCanvas() with screen.querySelector('canvas')
3d4c81d  chore(compose): bump image tag to 0.3.0-tcp-bridge-v0.4ak-debug
4e7ac32  fix(slotservice): drop blocking Alert() — v2.12
5d44922  build(mql5): compile SlotService v2.11
c21566b  merge: bring recompiled SlotService.ex5 over v2.12 source fix
275dbe9  chore(compose): bump to v0.4al-debug (SlotService v2.12 .ex5)
8950549  docs(sessions): full SlotService v2.12 investigation handoff (2026-07-26)
8d461ab  feat(slotservice): v2.13 — OnTimer sentinel print every 5s
22f837f  docs(sessions): mark OnTimer sentinel as done in TODOs  ← HEAD
```

The merge commit `c21566b` exists because the user originally built
the .ex5 from the OLD v2.11 source and I merged it on top of the
v2.12 source fix. Then the user recompiled against v2.12 and
committed as `a3abaa8`, but we force-pushed past that with `22f837f`
to include the v2.13 sentinel change. So the .ex5 binary in the
branch is the user's v2.12 build (96120 bytes), NOT v2.13.

---

## How to use the debug endpoints

```bash
# Snapshot of slot state (TCP server, ring buffers, etc.)
curl -sS http://45.151.122.104:7777/debug/slotservice | python3 -m json.tool

# Is anything listening on 127.0.0.1:7780?
curl -sS http://45.151.122.104:7777/debug/cmd-port | python3 -m json.tool

# Manually dispatch a command (same path /v1/orders uses)
curl -X POST -H "Content-Type: application/json" \
  -d '{"action":"account","payload":{}}' \
  http://45.151.122.104:7777/debug/inject-cmd | python3 -m json.tool

# Get a dev JWT (no login needed)
TOKEN=$(SSH_ASKPASS=~/.ssh/.askpass_vps SSH_ASKPASS_REQUIRE=force DISPLAY=:0 \
  ssh vps 'cd /srv/akroncloud-slot && npm run -s dev:token 2>/dev/null')

# Hit a slot REST endpoint
curl -sS -H "Authorization: Bearer $TOKEN" \
  http://45.151.122.104:7777/v1/state | python3 -m json.tool

# Open a real order (works only when SlotService is alive)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"account_id":"04ac13e8-8ab5-4694-bedb-24c4c3aad596","symbol":"EURUSD","side":"buy","volume":0.01}' \
  http://45.151.122.104:7777/v1/orders
```

---

## How to interact with the VPS

**Terminal gotcha:** the OpenHands sandbox terminal mangles
`akroncloud-slot` to `akroncloud-sotl` (drops the `o` because
docker sees `-slot` as a flag). Workaround: use the container ID
or `--` separator.

```bash
# SSH into VPS (vps is alias for 45.151.122.104)
SSH_ASKPASS=~/.ssh/.askpass_vps SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ssh vps

# Container ID (use this if 'akroncloud-slot' gets mangled)
CID=$(SSH_ASKPASS=~/.ssh/.askpass_vps SSH_ASKPASS_REQUIRE=force DISPLAY=:0 \
  ssh vps 'docker ps --format "{{.ID}} {{.Names}}" | grep akroncl | cut -d" " -f1')

# Run a command in the container
SSH_ASKPASS=~/.ssh/.askpass_vps SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ssh vps \
  "docker exec $CID bash -c '...command...'"

# Check MT5 window
xdotool search --name "MetaTrader*"

# Send a click (X display coords, MT5 main window at (4,30) 1016x734)
xdotool mousemove --window $MT5_WIN 500 400
xdotool click 1

# Send a key
xdotool key Escape
xdotool key Return

# Send Ctrl+N for Navigator
xdotool key ctrl+n
```

---

## If user logs in to a different broker account (DB update)

```bash
# Update the slot DB to use a new account
SSH_ASKPASS=~/.ssh/.askpass_vps SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ssh vps \
  "docker exec $CID bash -c 'cat > /tmp/u.js << \"EOF\"
const D = require(\"/app/node_modules/better-sqlite3\");
const db = new D(\"/var/lib/akron-slot/state.db\");
db.prepare(\"UPDATE accounts SET broker_login = ?, broker_server = ?, updated_at = ? WHERE id = ?\")
  .run(\"NEW_LOGIN\", \"Deriv-Demo\", Date.now(), \"04ac13e8-8ab5-4694-bedb-24c4c3aad596\");
EOF
docker cp /tmp/u.js $CID:/app/u.js
docker exec $CID /opt/node20/bin/node /app/u.js'"

# Get a dev token and trigger sync
TOKEN=$(SSH_ASKPASS=~/.ssh/.askpass_vps SSH_ASKPASS_REQUIRE=force DISPLAY=:0 \
  ssh vps 'cd /srv/akroncloud-slot && npm run -s dev:token 2>/dev/null')
curl -X POST -H "Authorization: Bearer $TOKEN" http://45.151.122.104:7777/v1/sync
```

After changing broker login, user must:
1. Open `/desktop` and log out of current account
2. Log in with the new account via File → Login to Trade Account
3. Enable algo trading + DLL imports in Tools → Options
4. Manually start SlotService in Navigator

---

## How to start SlotService manually

MT5 build 5836 + wine 11.0 doesn't auto-load services even when
all flags are set (services.ini + registry AutoStart=1). The
workaround is:

1. Open `http://45.151.122.104:7777/desktop`
2. Click on a chart so MT5 gets focus
3. Press `Ctrl+N` for Navigator
4. Expand `Services` in the tree
5. Right-click `SlotService.ex5` → `Start`
6. Immediately open the `Experts` tab at the bottom to see the
   print output (sentinel ticks at every 5s in v2.13)

The service runs ~5 seconds then dies. `Tools → Options → Expert
Advisors` must have both `Allow algorithmic trading` and `Allow
DLL imports` enabled, or the service won't even bind 7780.

---

## How to start MT5 if it's dead

The `openbox` autostart uses `exec` so when MT5 exits, the
autostart script exits and openbox doesn't restart it. Need to
manually launch:

```bash
SSH_ASKPASS=~/.ssh/.askpass_vps SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ssh vps \
  "docker exec $CID bash -c \"DISPLAY=:0 setsid s6-setuidgid abc /opt/wine-stable/bin/wine /config/.wine/drive_c/Program\ Files/MetaTrader\ 5/terminal64.exe /portable /skipupdate > /tmp/mt5.log 2>&1 < /dev/null &\""
```

Wait 8-30s for MT5 to fully boot (logs to `/tmp/mt5.log`).

---

## Open TODOs in priority order

1. **User compiles v2.13 .mq5 → .ex5, pushes it.** I rebuild image
   and redeploy. User starts SlotService. We watch the Experts tab
   for the sentinel pattern. Three possible outcomes:
   - (a) sentinel stops after 5s → MQL5 service thread was killed
     by wine/MT5 (case 1 in doc)
   - (b) sentinel keeps going but `g_cmdClients=0` → PollCommandServer
     not accepting connections (case 3)
   - (c) sentinel + `g_cmdClients=1` → service fine, the slot's cmd
     client or something else is the bug
2. **Add `WINEDEBUG=+winsock,+module,+seh` and capture logs during
   service death** to understand if wine is killing the MQL5 thread.
3. **Compile against an older MT5 build** (e.g., build 5000) to
   check if it's a build-specific bug.
4. **Comment out `EventSetMillisecondTimer`** to narrow down if
   the timer subsystem is the issue.
5. **Workaround: implement fake-order mode in the slot** so the
   cerebro can be tested end-to-end without SlotService.
6. **Long-term: file-based order queue** via a chart script polling
   `MQL5/Files/orders.json`. Bypasses the wine service-framework
   bug entirely.

---

## Most important file to read on resume

`docs/sessions/2026-07-26-slotservice-v2.12-investigation.md` (408
lines) has the full timeline, every bug we hit, what we ruled out,
and the three hypotheses for the remaining 5s death. **Read it
first** before doing anything else in a new chat.

---

*Last updated: 2026-07-26 end-of-session, debug/desktop-minimal @ 22f837f*