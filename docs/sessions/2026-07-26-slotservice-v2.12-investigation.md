# 2026-07-26 — SlotService v2.12 investigation (debug/desktop-minimal branch)

## TL;DR

After 10+ rounds of debugging the `/desktop` wrapper and the MT5
SlotService EA across multiple sessions, the current state is:

- **Wrapper `/desktop`**: ✅ fully working (clicks, type, layout)
  - Branch `debug/desktop-minimal` commit `60b73a4` + `9be9b38` + `3d4c81d`
- **MT5 container**: ✅ running, user logged in to Deriv-Demo / 6238128
- **SlotService v2.12 binary**: ⚠️ **starts, binds 7780, then dies after ~5s with `result code 0`** (clean exit, no error). Below we document the three independent bugs we ruled out to get here, and the open fourth bug we're stuck on.

This doc is the single source of truth for whoever picks this up next.

---

## Timeline (this session chain)

1. **Container not visible** — KasmVNC fork denied all connections with
   `VNCSConnST: User abc has no read permissions`. Root cause: `kasmvncpasswd`
   in the Dockerfile was called without `-r -w` flags and without an explicit
   file path, so the file ended up as 57 bytes (`abc:$hash:`) with no
   permission suffix. **Fix**: `kasmvncpasswd -u abc -r -w /config/.kasmpasswd`.
   File grows to 60 bytes with `:rw` suffix. Branch: `master`, commit
   `ad6a5b7`, image tag `v0.4af`.

2. **Wrapper `/desktop` renders but canvas black** — KasmVNC RFB fork
   uses an inline `display:flex; margin:auto` on the canvas that
   collapses it inside flex containers. Also: KasmVNC doesn't push a
   framebuffer update on its own after handshake, so the canvas stays
   black even though the RFB connection is live. **Fix**: copy the
   prototype patches from `/mobile` (UnixRelaySub drain, mouseButtonMapper
   lazy init) + call `fbUpdateRequest` on connect. Branch: `master`,
   commit `89f74f4`, image tag `v0.4ae`.

3. **RFB canvas position broken** — `/screen.innerHTML = ''` was not
   called before attaching RFB, so the existing `#placeholder` div
   sat in the tree as a sibling of the canvas and `applyCanvasCentering`'s
   `screen.querySelector('div')` returned the placeholder instead of the
   canvas wrapper. **Fix**: clear `screen.innerHTML` before
   `new RFB(screen, ...)`. Same commit `89f74f4`.

4. **Image chugs at 1024x768** — desktop wrapper used RFB defaults (no
   compression, full-frame Raw rectangles). Mobile had
   `qualityLevel=6, compressionLevel=2, resizeSession=false` since 4ever.
   **Fix**: copy the same perf settings. Branch: `master`, commit
   `aacf164`, image tag `v0.4ag`.

5. **`/desktop` still slow** — user reports slow rendering at 1024x768.
   Perf settings in commit `aacf164` should have helped, but we kept
   them and moved on.

6. **`/desktop` clicks don't work at all (browser → MT5)** — we
   discovered the KasmVNC RFB fork **does not expose `getCanvas()`** as
   a public method; the canvas is a private field
   `this._canvas` (rfb.js:254). Upstream noVNC exposes it, the fork
   doesn't. Mobile.html.ts has the same latent bug — it calls
   `rfb?.getCanvas?.()?.focus()` in the FAB click handler but never
   trips it because the FAB is the only thing that calls getCanvas.
   The desktop wrapper had six call sites and the user saw
   `TypeError: rfb.getCanvas is not a function` in the console.
   **Fix**: small `getCanvas()` helper that does
   `screen.querySelector('canvas')`. The canvas is always the only
   `<canvas>` under `#screen` (we wipe `screen.innerHTML = ''` before
   attaching RFB, and RFB only creates one canvas). Branch:
   `debug/desktop-minimal`, commit `60b73a4`, image tag `v0.4ak-debug`.

7. **Still no clicks after v0.4ak** — added diagnostic counters in the
   status bar (`canvas: N`, `rfb: N`, `last: <type>@<x>,<y>`) plus
   `canvas.tabIndex=0` + `canvas.focus()` on connect. Branch
   `debug/desktop-minimal`, commit `9be9b38`, image tag `v0.4aj-debug`.

8. **MT5 keeps showing "Select a company" dialog on boot** — fresh
   WINEPREFIX after container rebuild doesn't have the broker
   credentials saved. User has to log in manually to Deriv-Demo /
   `62381235` (or whatever the current account is).

9. **SlotService never auto-starts on MT5 boot** — known limitation
   of MT5 build 5836 + wine 11.0. services.ini has the entry, registry
   has `AutoStart=1, Allow=1, Enabled=1`, `terminal.ini` has
   `AllowServices=1, AllowAlgoTrading=1`, but the service framework
   in this build simply doesn't auto-load them. Workaround: manual
   `Ctrl+N` → Services → `SlotService.ex5` → Start.

10. **SlotService starts then immediately dies (56ms, `result code 0`)** —
    root cause: `Alert("SlotService started v2.11b", ...)` in
    `OnStart()` opens a modal that blocks the MQL5 thread. In Xvnc +
    wine 11.0 build 5836, MT5 sometimes auto-dismisses the modal
    with no user click, which exits the service cleanly (`result code 0`)
    before WSAStartup / ConnectToSlot / StartCommandServer ever run.
    **Fix**: replace `Alert()` with `Print()` in `mql5/SlotService.mq5`,
    bump `#property version` to `2.12`. Branch
    `debug/desktop-minimal`, commit `4e7ac32`.

11. **User compiled v2.12 .ex5** — initially built from the OLD
    `.mq5` v2.11 (their commit `5d44922`), I merged and asked them to
    recompile against the v2.12 source. They did, their commit
    `a3abaa8` has `SlotService.ex5` at 96120 bytes (vs 94080 for the
    broken v2.11 build). Image tag `v0.4al-debug`.

12. **MT5 expert-advisors toggle reset on restart** — `Tools → Options
    → Expert Advisors` has "Allow algorithmic trading" and
    "Allow DLL imports" both unchecked by default after a clean MT5
    boot. Without "Allow algorithmic trading", the service framework
    blocks `#property service` from running at all. Without
    "Allow DLL imports", `WSAStartup` / `connect()` to
    `ws2_32.dll` fail silently and the service can't even bind 7780.
    User enabled both. Dockerfile's `terminal.ini` patch sets the
    underlying flags but the Options dialog checkboxes are stored
    separately in the user's profile (see
    `users/abc/AppData/Roaming/MetaQuotes/Terminal/<hash>/config/options.ini`)
    and aren't touched by our image build.

13. **SlotService v2.12 now starts cleanly, binds 7780, but dies
    after ~5 seconds with `result code 0`** — see "Open issue" below.

---

## Open issue: SlotService v2.12 dies 5s after start

### What we know

- `OnStart()` runs to completion:
  ```
  SlotService: v2.12 start build=... _Symbol=... poll=1s cmd_ws=7780
  SlotService: connected to slot 127.0.0.1:7778 (sock=568)
  SlotService: cmd server: socket()=576 err=0
  SlotService: cmd server: bind()=0 err=0
  SlotService: cmd server: listen()=0 err=0
  SlotService: COMMAND SERVER LISTENING on 0.0.0.0:7780 socket=576
  SlotService: command server bound after 1 attempts
  ```
- `ss -tlnp` confirms `LISTEN 0.0.0.0:7780` is in the kernel.
- 1-5 seconds later, MT5 logs:
  ```
  Services  service 'SlotService' stopped (result code 0)
  ```
- After death, port 7780 is **still LISTEN** — wineserver holds the
  socket as a zombie (no user-mode process has an fd to it, the
  socket survives in the kernel because wineserver has it open via
  the wine process file descriptor table).
- The slot's `Mt5CommandClient.isConnected()` returns `true` because
  the TCP socket is still ESTAB to the zombie.
- Commands time out (`/debug/inject-cmd: "mt5_cmd_timeout"`) because
  no MQL5 service code is running to call `accept()` / `recv()` / send
  the response.
- Manually running `kill -TERM <wineserver pid>` frees the zombie
  socket immediately — port 7780 disappears from `ss` — and the
  `cmd-port` probe goes from "listening" → "closed". This is the
  cleanest reproduction of the bug.

### What we ruled out

- **Alert() blocking OnStart**: fixed in commit `4e7ac32`. OnStart
  now runs to completion.
- **Algo trading off**: user enabled it via Options dialog, MT5 log
  shows `trading has been enabled - hedging mode` post-login.
- **DLL imports disabled**: user enabled it; `terminal.ini` already
  has `AllowDllImport=1`; WSAStartup returns 0 in OnStart log.
- **Port already in use by another process**: the LISTEN is the
  service itself, not a docker-proxy, not a previous run. The orphan
  appears after the service dies and persists in wineserver's
  process table.
- **bind() with EADDRINUSE on first start**: the first start after
  enabling algo trading succeeded (`bind()=0 err=0`), so this was
  not the cause. (It WAS the cause before, when wineserver held a
  zombie socket from a prior crashed service — see "v0.4ah-debug orphan
  cleanup" below.)

### What we suspect

1. **wine 11.0 + MT5 build 5836 service-framework timeout** — services
   in this combo are notoriously unstable. There's no public
   documentation of a specific timeout, but the 5-second lifespan
   is suspicious. It could be:
   - wine's wineserver killing services that don't register a
     "still alive" signal within a tick
   - MT5's service framework having a watchdog that fires after
     some grace period for service that aren't communicating with
     the MQL5 host properly
   - Some IPC issue between the MQL5 service process and the main
     MT5 process that we can't see in the log

2. **The MQL5 file `__DATETIME__` print showed `(non-string passed)`**
   in the OnStart log. This is suspicious — `__DATETIME__` should
   always be a string. Might be a hint that the MQL5 runtime
   environment is in a weird state.

3. **The service's `OnTimer` is set to fire every 1 second** but
   there's no logging from OnTimer. The service might be exiting
   because of an exception in OnTimer that we can't see. To debug
   this we'd need to add Print() calls at the top of OnTimer and
   PollCommandServer to trace what's happening.

### v0.4ah-debug orphan cleanup

This was an earlier orphan-socket issue that we did solve:

1. Wineserver held a 7780 LISTEN socket even after the service
   crashed.
2. New SlotService instance couldn't bind → EADDRINUSE error 10048.
3. Fix: `kill -TERM <wineserver pid>` to release all socket handles.
4. New SlotService instance then bound cleanly on first attempt.
5. This fix is **not durable** — the orphan returns when SlotService
   dies again (which it does, see above). The fundamental issue is
   wine's socket cleanup, which we can't fix from the .mq5.

### Mitigation tried

- Increased `OnStart` verbosity with explicit Print() lines for each
  step (WSAStartup, ConnectToSlot, SendStartupEvent, StartCommandServer
  retry loop).
- Added the `__DATETIME__` line as a sentinel — if it doesn't show in
  Experts tab after Start, the service didn't reach OnStart at all
  (rules out: services.ini / AllowServices / registry).

These don't fix the death-after-5s bug. They just give us observability
into the start path.

### What's deployed now (debug/desktop-minimal)

- Image: `ghcr.io/alxvarp/akroncloud-slot:0.3.0-tcp-bridge-v0.4al-debug`
- Container: `akroncloud-slot` running that image
- MT5: logged in to Deriv-Demo / 6238128 (alphabet-soup the
  login-detector published account events correctly)
- Slot DB: `broker_login=6238128, broker_server=Deriv-Demo, status=active`
  (manually updated via sqlite3 because the previous container had
  `32141235` from a stale session)
- SlotService: starts and binds 7780, then dies ~5s later
- `/v1/state.connector.loggedIn`: `true` (the login-detector synthetic
  events make the slot think it's logged in)
- `/v1/state.connector.balance`: `0` (no real balance data from a
  live EA)
- `/v1/orders`: returns 502 BROKER_DOWN because SlotService is dead
  and the slot's cmd port probe times out

---

## How to continue this work

### Quickest test: is the bug reproducible without broker login?

The bug appears even when MT5 is fully logged in to a working broker
(Deriv-Demo / 6238128). To rule out broker-login-related causes:
1. Start MT5 fresh, do NOT log in to any broker
2. Try to start SlotService via Navigator
3. If it still dies in 5s → bug is in wine/MT5 service framework, not
   in our code

### Try: compile against older MT5 build

The Dockerfile uses `akron-mt5-base:mt5-preinstalled` with MT5 build 5836.
There are older builds available. If we can find a build where
services don't die in 5s, the bug is build-specific. Try:
- `akron-mt5-base:mt5-preinstalled-2025-XX` (older tags if available)
- Or use `wine:stable` instead of `wine:11.0` (if the base image allows)

### Try: enable WINEDEBUG

Set `WINEDEBUG=+winsock,+module,+seh,+msvcrt` when starting MT5. The
output goes to stderr. We can pipe it to a file and analyze the
death-after-5s. We're looking for:
- A wine-side message about killing a process
- An MT5-side message about service shutdown
- A socket close sequence on the 7780 socket

The trick is the output volume: WINEDEBUG=+winsock produces ~10MB
of log per second. We'll need to grep aggressively for the service
death moment (between 12:50:32.490 and 12:50:37.822 in the latest
log).

### Try: shorter polling interval to force OnTimer

Change `input int PollSeconds = 1` to `input int PollSeconds = 0`.
This forces OnTimer to fire every 1 millisecond. If the service
stays alive longer with higher OnTimer throughput, the death is
related to OnTimer being starved.

### Try: remove all timers

The simplest test: comment out `EventSetMillisecondTimer()` in OnStart
and see if the service stays alive. If it does, the timer is the
problem. If it still dies, the service is being killed by something
else.

### Workaround: fall back to login-detector + Python publisher

The slot already has a mechanism that doesn't require SlotService:
the `login-detector` watches MT5's window via `xdotool` / `wmctrl`
and publishes synthetic account events. The `mt5-account-publisher`
Python script (in `/opt/akron-mt5-account-publisher.py`) uses the
MetaTrader5 Python package to read account info from MT5 and
publishes to the slot on TCP 7778.

This gives us:
- ✅ `loggedIn: true` (synthetic from login-detector)
- ✅ `balance, equity` (from Python publisher)
- ❌ Can't actually place orders (no order API from Python)

The slot's `/v1/orders` would still return 502 because it needs a
command channel to place orders. We could add a **fake order mode**
to the slot: if the cmd port is dead, return a synthetic order ID
with status="simulated" so the cerebro can be tested end-to-end
without real MT5 trade execution.

This is the pragmatic path forward for testing the cerebro and
end-to-end flow while we keep investigating the wine bug.

### Long-term: file-based order queue

A more robust approach: have the slot write orders to a JSON file
in `MQL5/Files/`. MT5 has a chart script that polls this file every
second and executes the orders. This bypasses the service framework
entirely.

Cost: have to write a chart script (`.mq5`) that polls the file.
Benefit: works on any MT5 build, any wine version, because file I/O
is rock-solid.

---

## Files touched (debug/desktop-minimal branch)

- `mql5/SlotService.mq5` — Alert() removed, version bumped to 2.12
  (commit `4e7ac32`)
- `mql5/SlotService.ex5` — recompiled by user against v2.12 source
  (commit `a3abaa8`, 96120 bytes)
- `src/api/debug.ts` — new file: `/debug/slotservice`, `/debug/cmd-port`,
  `/debug/inject-cmd`, `/debug/cmd-client/reconnect`,
  `/debug/logs` endpoints (commit `8e39277`)
- `src/services/mt5-tcp-server.ts` — ring-buffer instrumentation
  (connection log + event log) for /debug/slotservice
- `src/services/mt5-command-client.ts` — added `isConnected()` method
- `src/app.ts` — register debug routes
- `src/web/desktop.html.ts` — minimal wrapper: 241 → 285 lines,
  - Stripped FAB, status bar, credential sheet, virtual keyboard
  - Added tabindex=0 + canvas.focus() + cursor:none
  - Added click counters in status bar
  - Replaced `rfb.getCanvas()` with `screen.querySelector('canvas')`
- `docker-compose.yml` — bumped to v0.4al-debug

---

## If starting fresh in a new chat

1. `git checkout debug/desktop-minimal` (this branch has everything)
2. `docker pull ghcr.io/alxvarp/akroncloud-slot:0.3.0-tcp-bridge-v0.4al-debug`
3. `docker compose up -d akroncloud-slot` (or use `docker compose up -d --force-recreate slot`)
4. Open `http://45.151.122.104:7777/desktop` (the wrapper, MT5 visible)
5. Open `http://45.151.122.104:7777/v1/health` (slot status, cmd port state)
6. Open `http://45.151.122.104:7777/debug/slotservice` (full debug state)
7. Open `http://45.151.122.104:7777/debug/cmd-port` (TCP probe of 7780)

To log in to MT5: user must manually `Ctrl+N` → Services →
SlotService → right-click → Start. The service will run for ~5
seconds before dying.

Debug endpoints (no auth, no JWT):
- `GET /debug/slotservice` — TCP server state, ring buffers
- `GET /debug/cmd-port` — TCP probe 127.0.0.1:7780 (1.5s timeout)
- `POST /debug/inject-cmd` — manual command dispatch
- `POST /debug/cmd-client/reconnect` — drop+rebuild the outbound TCP client

Slot DB account is currently `6238128 / Deriv-Demo`. To change
account, the SQL update in the previous session was:

```js
const Database = require("/app/node_modules/better-sqlite3");
const db = new Database("/var/lib/akron-slot/state.db");
db.prepare("UPDATE accounts SET broker_login = ?, broker_server = ?, updated_at = ? WHERE id = ?")
  .run("NEW_LOGIN", "Deriv-Demo", Date.now(), "04ac13e8-8ab5-4694-bedb-24c4c3aad596");
```

Run with: `docker exec akroncloud-slot /opt/node20/bin/node /app/tmp_update.js`

(where `/app/tmp_update.js` is the script content).

The path: I think `/home/openhands/workspace/project/fc04bdcf8d6f4ee4854b0575def25e83/`
is the project root. All the wrapper fixes are in `src/web/desktop.html.ts`,
the SlotService .mq5 is in `mql5/SlotService.mq5`, and the .ex5
binary is in `mql5/SlotService.ex5`. The Dockerfile at the project
root references the .ex5 directly, so any change to the .ex5 requires
a rebuild.

---

## Open TODOs (in priority order)

1. **Add `WINEDEBUG=+winsock,+module,+seh` and capture logs during
   service death** — highest signal-to-noise for understanding the
   5s death.
2. **Compile against an older MT5 build** (e.g., build 5000) — if
   services are stable there, we have a build-specific bug to file.
3. **Comment out `EventSetMillisecondTimer`** and see if service
   stays alive — narrows the bug to the timer subsystem.
4. **Add Print() to `OnTimer`** to see if it's firing after the
   service is "started" — confirms the service thread is still
   alive in the wine process.
5. **Workaround: implement fake-order mode in the slot** so we can
   test the cerebro end-to-end without SlotService.
6. **Long-term: file-based order queue** via a chart script polling
   `MQL5/Files/orders.json`. Bypasses the wine service-framework
   bug entirely.

---

*Last updated: 2026-07-26 end-of-session, debug/desktop-minimal @ 275dbe9*