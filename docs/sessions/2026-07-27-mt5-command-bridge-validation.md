# MT5 command bridge: validation and operating notes

Date: 2026-07-27

## Scope

This session made the desktop MT5 slot usable end-to-end after an interactive
login:

1. MT5 login is detected and creates the API account automatically.
2. REST commands use the independent Python/MT5 command bridge on port 7780.
3. The desktop container is healthy without a persisted host volume.
4. AutoTrading is guarded after login instead of requiring a user click.
5. Completed executions are emitted as slot events so they can be consumed as
   a signal source by the WebSocket and ledger paths.

## Runtime topology

```text
KasmVNC / MT5 desktop
        │ user login
        ▼
  MT5 terminal64.exe ── Wine IPC ── Python MT5 API
                                  │
                      mt5-command-server.py :7780
                                  │ commands
                                  ▼
                          Node slot API :7777
                         /v1/* + /v1/stream

Python command server ── event frames :7778 ──► MT5 TCP server
                                                │
                                                ├─ ledger fills/order state
                                                └─ WebSocket event source
```

The Python command server is deliberately independent from the account
publisher. Wine's MT5 IPC can stall one Python process; orders remain
available if the publisher is waiting on account information.

## Required container configuration

The production image defaults to `SLOT_CONNECTOR=mt5`. A local run requires
the slot identifiers and secrets, for example:

```powershell
docker run -d --name akroncloud-slot-final `
  -e SLOT_TENANT_ID=<tenant UUID> `
  -e SLOT_SLOT_ID=<slot UUID> `
  -e SLOT_JWT_SECRET=<32+ byte secret> `
  -e SLOT_ENCRYPTION_KEY=<base64 32-byte key> `
  -p 127.0.0.1:13001:3000 -p 127.0.0.1:17780:7777 `
  akroncloud-slot:cmd-bridge-final
```

Desktop login is at `http://127.0.0.1:13001/`. The API is at
`http://127.0.0.1:17780/` in this local mapping.

## Login-to-account provisioning

The first authenticated MT5 account event includes its broker login and
server. `buildApp()` registers a single active MT5 account immediately when
there is no matching database row. The stored credential object deliberately
contains no broker password: MT5 has already been authenticated interactively.

This removes the former failure mode where MT5 was connected and commands
worked, but `/v1/state` returned `no account yet` because no API row existed.

Observed validation account:

| Property | Result |
|---|---|
| Broker | Deriv-Demo |
| Account | 6238128 |
| Connector | `mt5` |
| Command port | `127.0.0.1:7780`, listening |
| Final positions | 0 |

## AutoTrading guard

MT5 build 5836 stores its interactive AutoTrading preference in the user
profile. It may reset that preference during the first broker login even when
the image has `AllowAlgoTrading=1` in `terminal.ini` and Wine registry
defaults.

`scripts/ensure-autotrading.sh` is installed as an s6 long-running service.
It checks the authoritative runtime value
`MetaTrader5.terminal_info().trade_allowed`. Only when false it opens
Tools → Options → Expert Advisors and enables **Allow algorithmic trading**.
It does not send orders and does not toggle an already-enabled setting.

The intended user experience is now: start container → log into MT5 → use the
API. No second AutoTrading click is required.

## Event/source behavior

The command bridge returns an order result synchronously, but broker execution
also needs to be observable by a downstream consumer. The bridge therefore
publishes two newline-delimited frames to `127.0.0.1:7778` after a completed
market execution:

```json
{"type":"event","kind":"order_state","data":{"broker_order_id":"…","status":"filled"}}
{"type":"event","kind":"fill","data":{"broker_order_id":"…","deal":"…","symbol":"EURUSD","qty":0.01,"price":1.13996}}
```

The MT5 TCP server persists the fill (when an order row is available) and the
MT5 connector fans it out to `/v1/stream`. That makes this slot suitable as a
source for another process: subscribe to the authenticated WebSocket, rather
than screen-scraping KasmVNC or polling the terminal.

`/v1/fills` remains the reconciliation source of truth if a local event frame
is temporarily lost.

## Verified API behavior

Using an HS256 development JWT scoped to this tenant/slot:

- `GET /v1/health`: `status=ok`, connector `mt5`, command port listening.
- `GET /v1/state`: active Deriv-Demo account, `loggedIn=true`.
- `GET /v1/account`, `/v1/quote?symbol=EURUSD`, `/v1/symbols`,
  `/v1/positions`, `/v1/fills`: successful.
- `POST /v1/orders`: submitted `EURUSD` market buy, volume `0.01`.
- `POST /v1/positions/{ticket}/close`: closed it successfully.
- Final check: zero positions.

All order tests were performed on the Deriv demo account and closed
immediately. They caused a small normal demo spread loss.

## Quote benchmark

The following benchmark executed ten sequential `quote` commands per symbol
through the HTTP debug route → Node command client → Python MT5 bridge. Values
are end-to-end milliseconds on the local desktop host.

| Symbol | Samples | Min | p50 | p95 | Max | Mean |
|---|---:|---:|---:|---:|---:|---:|
| EURUSD | 10 | 30.3 | 40.0 | 53.6 | 588.4 | 95.2 |
| GBPUSD | 10 | 30.6 | 35.1 | 44.6 | 47.2 | 37.2 |
| USDJPY | 10 | 31.9 | 36.9 | 56.1 | 73.3 | 42.8 |
| XAUUSD | 10 | 27.7 | 31.2 | 53.3 | 73.2 | 37.5 |
| BTCUSD | 10 | 26.9 | 29.3 | 41.0 | 44.9 | 32.5 |
| account | 10 | 28.8 | — | — | 73.2 | 42.9 |

The 588.4 ms EURUSD max was a first-call/warm-up outlier. The remaining
symbols and samples stayed below 74 ms. This is adequate for command/control
and signal-source use; it is not a low-latency/HFT transport guarantee.

## Multi-symbol execution benchmark

Three `0.01` demo market buys were opened and then closed immediately through
the command bridge. They were intentionally held only long enough to verify
that multiple distinct symbols can coexist in MT5. Final positions were zero.

| Symbol | Open ms | Close ms |
|---|---:|---:|
| EURUSD | 942.5 | 407.6 |
| GBPUSD | 339.9 | 381.0 |
| USDJPY | 355.1 | 378.4 |

EURUSD again included a first-call warm-up delay. The other operations stayed
in the 340–408 ms range, including broker acknowledgement, Wine IPC and local
event publication. Each open and close generated both `order_state=filled` and
`fill` frames on port 7778. The test account ended with zero positions.

## Signal-source validation

A live WebSocket client connected to `GET /v1/stream` and a `0.01` GBPUSD demo
order was opened and closed. The client received both frames for the same
broker order (`5727784092`):

```json
{"kind":"order_state","data":{"order_id":"5727784092","status":"filled"}}
{"kind":"fill","data":{"broker_order_id":"5727784092","symbol":"GBPUSD","qty":0.01,"price":1.33181}}
```

The command bridge now sends the correlated state and fill frames through one
event-socket connection. This avoids a connection-replacement race in the
single-producer TCP event server, so downstream WebSocket consumers can use
the slot as an execution-signal source.

## AutoTrading recovery

The image starts `svc-mt5-autotrading-guard` after the desktop service. It
checks MT5's authoritative `terminal_info().trade_allowed` flag every 20
seconds and, if disabled, opens MT5 Options and enables **Allow algorithmic
trading**. The Wine output is normalized before comparison and the Expert
Advisors tab is selected explicitly (Wine can skip it when cycling tabs with
`Ctrl+Tab`). No order is placed by this guard.

## Operational checks

```powershell
Invoke-RestMethod http://127.0.0.1:17780/v1/health
Invoke-RestMethod http://127.0.0.1:17780/v1/state
docker logs akroncloud-slot-final --since 5m
```

For source consumption, issue a JWT with `slot:stream` and connect to
`ws://127.0.0.1:17780/v1/stream`. Consumers should deduplicate using broker
order/deal identifiers and reconcile against `/v1/fills` after reconnect.
