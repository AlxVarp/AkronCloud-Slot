# Task — v56 Benchmark — confirm slot-as-API readiness

> Created 2026-07-22 after v56 merge (commit 6705980). v56 is the
> first version where `/v1/state` actually reflects real balance/equity
> after the user logs into MT5. Before v56, `/v1/state.connector.balance`
> was permanently 0. Now we need to verify the whole API behaves like
> a real product surface: latency under load, error paths, state
> consistency, recovery from disconnects.

## Scope

This is **read-side + state-sync benchmarking**, not order placement.
The slot's order-placement API is the cerebro's job, not the slot's
(the slot exposes `/v1/state`, `/v1/health`, `/v1/sync`, plus the
internal/mobile routes; the cerebro talks to MT5 over TCP 7778 to
place orders). What this benchmark validates is the surface the
AkronCloud panel + cerebro + kubernetes probes actually consume.

## What's tested

### Tier 1 — Happy path (must pass before any other tier)

- [ ] `GET /v1/health` returns 200, `status:"ok"`, valid `slot_id`
- [ ] `GET /v1/state` returns 200, `account.broker_login` matches DB, `connector.accountRef` matches expected format
- [ ] After MT5 login + sync, `connector.balance > 0` and `connector.equity > 0`
- [ ] `connector.lastError` is null or absent (not "unknown accountRef")
- [ ] `POST /v1/sync` returns 200, `account_validated` fires within 30s
- [ ] `/mobile` returns 200 with HTML containing "MetaTrader 5"

### Tier 2 — Latency & throughput

- [ ] `GET /v1/health` p50 < 5ms, p99 < 50ms over 1000 sequential calls
- [ ] `GET /v1/state` p50 < 10ms, p99 < 100ms over 1000 sequential calls
- [ ] 50 parallel `GET /v1/state` all return 200 with consistent data (no torn reads)
- [ ] After MT5 broker state change (manual operation in mobile viewer),
    `GET /v1/state` reflects it within 15s (publisher poll interval)

### Tier 3 — State consistency under churn

- [ ] Logout from MT5 → `connector.loggedIn` flips to `false` within 15s
- [ ] Log back in → `connector.loggedIn` flips back to `true` within 15s
- [ ] Place a market order in MT5 → `connector.balance` decreases by order
    value (after fills) within 30s
- [ ] Open a position, close it → position disappears from `/v1/state` (when
    /v1/state exposes positions; in v56 it currently shows account state
    only — this test becomes relevant when positions are added)

### Tier 4 — Failure modes

- [ ] Send `GET /v1/state` 100x in a tight loop while the publisher is
    being killed (s6 respawns it) — verify no 5xx, all return eventually
- [ ] Restart the container (`docker compose restart`) — `/v1/health`
    back to 200 within 60s
- [ ] Stop KasmVNC viewer while broker login is in flight — verify
    `/v1/state` recovers cleanly when viewer comes back
- [ ] Send malformed JSON over TCP 7778 — slot logs error, doesn't crash
- [ ] Send 10 concurrent TCP 7778 connections with valid frames — slot
    processes all without deadlock

### Tier 5 — Recovery from edge cases

- [ ] MT5 broker login while publisher is mid-IPC-timeout — publisher
    recovers within 60s (the Bug 2 fix)
- [ ] Container restart with MT5 broker already logged in — publisher
    reconnects within 30s of broker auth (the v55/v56 finding from today)
- [ ] `POST /v1/sync` when no account exists — returns clear error
    (currently `reason: "no account yet - login through the mobile wrapper first"`)
- [ ] `GET /v1/state` when no account exists — returns `ok: false` with
    same reason

## How to run

```sh
# Install deps (one-time)
pip install requests websockets

# Mint a JWT (or skip — /v1/* is unauthenticated in v56)
npm run dev:token   # writes token to stdout

# Run the benchmark
python3 scripts/benchmark.py \
  --base http://45.151.122.104:7777 \
  --token "$JWT" \
  --tier all
```

The script:
- Runs each tier in order
- Prints pass/fail per check
- Writes a `benchmark-report-<date>.md` summarizing results
- Exits non-zero if any Tier 1 check fails (hard gate)

## What's NOT in scope

- Order placement/modification via cerebro (separate concern; needs the
  cerebro API to be wired into the slot's TCP commands on 7778)
- Multi-account scenarios (slot is single-tenant in v56)
- Position management REST endpoints (not implemented in v56)
- Authentication (v56 endpoints are unauthenticated; JWT path is for
  cerebro/panel internal use)

## Acceptance criteria for v56 close-out

- All Tier 1 checks pass
- Tier 2 latency P99 < 100ms on the live VPS (45.151.122.104)
- Tier 3 state-refresh latency < 15s after MT5 ops
- Tier 4 failure modes recover without manual intervention
- Tier 5 edge cases match documented behavior

If any check fails, open a follow-up task in this doc and link the
fix in the same PR cycle. Don't merge new features until benchmark
is green.

## Owner / next steps

- Owner: whoever has the slot deployed + MT5 logged in (right now: user
  in this session, with the live VPS at 45.151.122.104)
- Run in a fresh session with both the live container reachable and
  the mobile viewer open (so manual operations are possible for Tier 3)
- Schedule: ideally before any further slot features (so the
  benchmark becomes a gate for regressions)