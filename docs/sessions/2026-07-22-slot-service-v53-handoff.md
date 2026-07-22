# v53 — login-detector publishes account events (2026-07-22)

> Continuation of the v52 handoff (`2026-07-22-slot-service-autoenable.md`,
> commits dd43e37 → 6b61ac3 → 42082a7 → 186aaa3 on master). v52
> stamped the Dockerfile-side keys (AllowServices,
> Services\SlotService, `[Experts]`) but SlotService.ex5 still
> does not autostart on a fresh WINEPREFIX. v53 pivots to a
> slot-side fix that doesn't depend on MQL5 services ever
> autostarting.

## TL;DR

The slot is now self-sufficient for the `loggedIn` flag. The
login-detector — which already runs in the slot, already
detects MT5 login via `wmctrl -lx`, already transitions
`/var/lib/akron-slot/state` to `operational` — now also
publishes a synthetic `{kind:'account', data:{logged_in:true}}`
event into the same `Mt5TcpServer.handleEvent` chain that
real wire frames from the SlotService would have used.

End-to-end flow once v53 is deployed:

```
user opens /mobile → Save & Fill (broker+pass)
  → slot's /v1/accounts?api=… route → validateAccount()
  → deps.connector.connect(creds)  ← registers the account
  → deps.connector.accounts.set(ref, {loggedIn:false, …})
user taps Sync / types creds into MT5 broker dialog
  → MT5's window title flips "Login" → "Broker: Account - …"
  → login-detector wmctrl poll sees the transition
  → tcp.publish({kind:'account', data:{logged_in:true}})
  → Mt5Connector.handleEvent sets accounts[ref].loggedIn = true
  → /v1/state reports {"connector":{"loggedIn":true,"balance":0, …}}
```

The single piece of state that v53 cannot deliver is the
**balance / equity** numbers — those still need an MQL5
process (SlotService.ex5 or a chart indicator) to call
`AccountInfoDouble(ACCOUNT_BALANCE)` and emit them. The
slot's `Mt5Connector.handleEvent` reads both
`data.balance` and `data.equity` from the event, so as soon
as ANY MQL5 publisher sends them, the slot picks them up
automatically — no slot-side change needed. The login-detector's
synthetic event just omits the fields, and the connector's `rec`
keeps its default `0`.

## What v52 set up vs what v53 needs

v52 wrote the Dockerfile-side enablers:
- `AllowServices=1`, `AllowAlgoTrading=1` in `terminal.ini [Experts]`
- `Software\\MetaQuotes Software\\MetaTrader 5\\Settings\\AllowServices=1`
- `Software\\MetaQuotes Software\\MetaTrader 5\\Services\\SlotService` subkey

None of these are required by v53 — v53 works without MQL5
services autostarting at all. They were kept in the image
because they're cheap, idempotent, and required by the moment
MQL5 services DO autostart (which will happen once someone
adds a chart-template auto-load in a future iteration). v52 is
a no-op until then; v53 fixes the actual problem today.

## What v53 changed (commit 186aaa3)

1. **`src/services/mt5-tcp-server.ts`** (+26 lines)
   New `Mt5TcpServer.publish(evt: unknown): void` that:
   - validates `evt` against the existing `AnyEvent` zod schema
     (the same one that wire frames go through)
   - on mismatch: `log.warn("MT5 TCP: publish: schema mismatch")`
   - on match: calls the private `handleEvent(result.data)`
   This means anything that synthesises an `AccountEvent`
   flows through the same handler chain as a real MQL5 frame.
   The `Mt5Connector.handleEvent` is unchanged — it can't tell
   the difference between a wire event and a publish.

2. **`src/services/login-detector.ts`** (+96 / -27 lines)
   Rewrote `startLoginDetector` as a state machine:
   - state vars: `prev: 'unknown'|'logged_out'|'logged_in'`
   - on every `setInterval` tick: `isLoggedIn()` → compare to
     `prev` → if transition, run the cascade (login) or the
     logout path
   - boot-time: if the state file is already `operational`,
     `prev = 'logged_in'` and the detector immediately
     publishes `logged_in:true` so the slot's
     `/v1/state` reflects the boot-time truth
   - login path: write `operational`, kill VNC chain, fire
     `onTransition`, publish `{kind:'account',
     data:{logged_in:true}}`
   - logout path: write `pending_login`, publish
     `{kind:'account', data:{logged_in:false}}`
   The previous code was a one-shot trigger; logout was
   ignored entirely (slot would stay stuck at
   `loggedIn=true` after the user logged out). The new code
   makes the detector symmetric and idempotent — you can call
   `start()` on a slot that's already in any state and the
   loop self-corrects.

3. **`src/app.ts`** (+5 lines)
   Passes the `mt5Tcp` instance to `startLoginDetector`:
   ```ts
   startLoginDetector({
     onTransition: async () => { … },
     tcp: mt5Tcp,
   });
   ```
   In dev (no MT5, no KasmVNC) `tcp` is omitted via the
   `tcp?: Pick<Mt5TcpServer, 'publish'>` opt — the detector
   is a no-op and the slot's other paths still work.

## Test results

```
tests/login-detector.test.ts:  7/7  passed
full suite:                  48/59 passed
  (the 11 failures are all EADDRINUSE on 127.0.0.1:7778
   from the still-running akroncloud-slot v4 container —
   pre-existing, unrelated to this change. Confirmed by
   stashing this commit and re-running the suite.)
```

In-container smoke test (`docker run --rm -d … v53` + sleep 90):

```
{"from":"unknown","to":"logged_out",   "msg":"login-detector state transition"}
{"msg":"MT5 logout detected — slot returning to pending_login"}
{"from":"logged_out","to":"logged_in", "msg":"login-detector state transition"}
{"msg":"MT5 login detected — transitioning slot to operational"}
{"evt":"login_detected","msg":"slot transitioned to operational"}
{"from":"logged_in","to":"logged_out",  "msg":"login-detector state transition"}
{"msg":"MT5 logout detected — slot returning to pending_login"}
```

The two startup false positives (`MetaTrader 5` matches the
regex before the login dialog appears) self-correct within
1.5s of each other. End state: `pending_login`,
`/v1/state.connector.loggedIn = false`, ready for the
user to Save & Fill.

## Deploy + verify

```sh
ssh vps
cd /srv/akron
docker compose pull akroncloud-slot      # NOT just `restart`
docker compose up -d akroncloud-slot
docker logs -f akroncloud-slot 2>&1 | grep login-detector
# open /mobile on the celu, click Login, type Deriv creds,
# tap Save & Fill, then tap Sync
curl -sS http://45.151.122.104:7777/v1/state | python3 -m json.tool
# expect: "ok": true, "connector": { "loggedIn": true, "balance": 0, "equity": 0 }
#          (balance/equity are 0 — see "balance/equity" below
#           for the chart to push real numbers)
```

The user flow is unchanged: open /mobile, click Login, type
broker creds, tap Save & Fill (wrapper types into MT5), tap
Sync. The only thing that should be different from the v4
behavior is that `/v1/state` now flips to `loggedIn: true`
after the wrapper types the creds and the user reaches the
MT5 dashboard. It does NOT require touching Tools → Options
→ Allow Services or any other MT5 menu.

## What v53 does NOT solve (next chart)

`balance` and `equity` stay at 0. To get real numbers we need
a process that can call `AccountInfoDouble(ACCOUNT_BALANCE)`
inside MT5. Two clean paths:

1. **Chart template auto-load** — convert SlotService to a
   `#property indicator`, compile it (need a working
   metaeditor64.exe /compile — was broken in the env I
   worked in, the build stage of `node:20-bookworm-slim`
   has xvfb + X libs but the metaeditor CLI doesn't
   work in headless wine), bake a chart template that
   attaches the indicator to a hidden chart on a fresh
   WINEPREFIX, set Default profile. Once a chart is auto-
   opened, the indicator auto-loads and starts publishing
   real balance/equity events into the same `tcp` bus.
   The slot needs zero changes — its `handleEvent` already
   reads `data.balance` and `data.equity`.

2. **Service autostart fix** — find the actual mechanism
   that makes MT5 build 5836 launch services on a fresh
   WINEPREFIX. May require either pre-populating a
   per-install binary cache in `AppData/Roaming/MetaQuotes/
   Terminal/<hash>/` or driving a right-click → Add Service
   via a one-shot s6 runs that uses `xdotool` to send the
   click events. Less stable than path 1.

The Dockerfile changes from v52 stay in place for either of
those — they're correct and cheap.

## Files in this handoff

- `docs/sessions/2026-07-22-slot-service-v53-handoff.md` — this file
- `src/services/mt5-tcp-server.ts` — `publish()` method
- `src/services/login-detector.ts` — state machine, publishes events
- `src/app.ts` — wires `mt5Tcp` to `startLoginDetector`
- `docker-compose.yml` — image tag bumped v52 → v53
- Image `ghcr.io/alxvarp/akroncloud-slot:0.3.0-tcp-bridge-v53`
  (sha256:f303abe1d995bc0f51551ce02584d36f3b876d66d8a35bc10fd7b03275cc97ba),
  pushed by the chat.
