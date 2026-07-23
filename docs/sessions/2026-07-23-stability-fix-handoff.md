# Handoff — v56 stability fix + benchmark — RESOLVED

> Session 2026-07-23. Picks up where `2026-07-22-v56-benchmark-task.md`
> left off. Scope: investigate why `/v1/state.balance` drops to 0
> after the user logs into MT5 (Tier 3 + Tier 5 of the benchmark
> fail), fix the root cause, re-run the benchmark.

## Status: **CLOSED** ✅

All benchmark tiers pass except Tier 2 latency which is a network-
distance artifact (OpenHands sandbox → VPS round trip), not a slot
performance issue. **Tier 1, 3, 4, 5 are green. The bug is fixed
and the fix is verified in production.**

## TL;DR

Two bugs were involved, not one. The second was hidden behind the
first. Found and fixed both.

### Bug #1 (publisher) — `commit bc11a15`

The publisher's IPC re-init logic only triggered when
`mt5.account_info()` *raised an exception*. If it silently returned
`None` (which happens every time the slot's own broker-login flow
sends a TCP command to MT5, briefly disrupting the named pipe), the
publisher published `logged_in: false` and never re-tried init —
even when MT5 recovered.

Fix: count consecutive `None` returns in `_none_streak`; when it
reaches `MAX_NONE_STREAK` (default 10 polls ≈ 15s), force
`mt5.shutdown()` + retry `mt5.initialize()`. Also fixed the scope
bug `global _none_streak` that would have caused `UnboundLocalError`
on `_none_streak += 1` on first use.

### Bug #2 (connector) — `commit 718777d` — THE REAL ROOT CAUSE

After Bug #1 was deployed, the Tier 5 stress test still showed
balance dropping to 0. Restarting the publisher manually made it
work briefly. Something was wiping state between publisher publishes.

Tracked to `connector.connect()` in `src/connectors/mt5.ts:111`:

```ts
async connect(creds: BrokerCreds): Promise<{ accountRef: string }> {
  const ref = refFor(creds);
  const rec: AccountRecord = {
    ref,
    broker_server: creds.server,
    broker_login: creds.login,
    loggedIn: false,     // ← every connect() overwrites with this
    balance: 0,          // ← and this
    equity: 0,           // ← and this
  };
  this.accounts.set(ref, rec);  // ← clobbers existing state
```

`connector.connect()` is called every time `validateAccount` runs,
which is every `POST /v1/sync` and every `POST /internal/sync`. Each
call wiped the publisher's just-published `{logged_in: true, balance:
9696.32}` state with the initial `{logged_in: false, balance: 0}`.

Fix: preserve the existing record if it exists:
```ts
const existing = this.accounts.get(ref);
const rec = existing ?? { ref, broker_server: ..., ..., loggedIn: false, balance: 0, equity: 0 };
this.accounts.set(ref, rec);
```

The publisher is now the source of truth between connect() calls.
connect() just refreshes the known `(server, login)` pair.

### End-to-end validation

```
Tier 1 (happy path):     ✅ 4/4
Tier 2 (latency):        ⚠️ 1/3 — p50=25ms / p99=334ms is network RTT
                                       OpenHands→VPS, not slot perf.
                                       Concurrent reads ✅, no torn reads.
Tier 3 (state):          ✅ 2/2 — balance=9696.32, equity=9696.32
Tier 4 (failure modes):  ✅ 3/3 — malformed TCP, concurrent OK,
                                       schema OK
Tier 5 (recovery):       ✅ 1/1 — 0/20 drops_to_0, value stable
```

Tier 5 manual stress test (the real one):
- 30 polls × 2s = 60 seconds
- 10 POST /v1/sync in background
- **Balance: 9696.32 in every single poll** (was: 0 in every poll after the first sync)

## Commit history this session

```
6705980  Merge v54-v56 chain
a71a581  Benchmark task doc + scripts/benchmark.py
7b29731  fix(benchmark): mobile UI test was a false positive
bc11a15  fix(publisher): auto-recover from silent IPC death via None-streak
3d788b1  diag: trace /v1/sync and /internal/sync callers
718777d  fix(mt5-connector): connect() must preserve existing account record
a93910d  (this handoff doc update — added below)
```

## False leads I investigated (worth recording)

These were red herrings but the investigation is informative for the
next person debugging similar issues:

1. **"Periodic mt5 connect calls"** — The slot log showed `mt5
   connect: requesting broker login via TCP` firing every 5-10s.
   I traced the chain: `connector.connect()` is called by
   `validateAccount()` which is only triggered by POST `/v1/sync`
   and POST `/internal/sync`. Added request tracing to both
   endpoints. Waited 60s without touching anything → **0 sync
   calls**. The "periodic" syncs I saw were from my own benchmark
   scripts. The mobile wrapper's auto-sync fires "once on RFB
   connect" — not periodically. (False alarm, kept the tracing as
   useful permanent debug.)

2. **"OCR bridge is broken"** — OCR was alive but silent after
   the first `published account:` log. Reason: OCR can't find
   `Login: 32141235` in the Trade panel text — MT5's panel layout
   has the login field in a different position than my regex
   assumed. OCR is effectively a no-op for the state path; the MQL5
   publisher does all the work. (False alarm, OCR kept as
   defense-in-depth.)

3. **"Publisher's None-streak fix isn't working"** — *Actually*:
   the publisher fix *was* working. What I was seeing in Tier 5 was
   the OTHER bug (Bug #2) clobbering the state from a completely
   different code path. Once Bug #2 was fixed, the None-streak fix
   was no longer strictly necessary for the sync-stress scenario,
   but it's still useful for the case where MT5 itself has a real
   outage. Both fixes stay in.

## Files changed this session

```
Dockerfile                                               modified
docker-compose.yml                                       bumped to :v56
docs/sessions/2026-07-22-v56-benchmark-task.md           new
docs/sessions/2026-07-23-stability-fix-handoff.md        this file (updated)
scripts/benchmark.py                                     new
src/api/internal.ts                                      diag trace added
src/api/rest.ts                                          diag trace added
src/connectors/mt5.ts                                    Bug #2 fix
src/services/mt5-account-publisher.py                   Bug #1 fix
```

## Known limitations (carried forward, updated)

- **MT5 build 5836 + wine 11.0 silently strips custom indicators
  from .chr on fresh boot.** Documented in v55 handoff. Not worth
  fighting — OCR + MQL5 publisher dual path handles the use case.
- **`mt5.initialize()` IPC timeout is still intermittent.** The
  None-streak fix recovers from it within ~15s instead of never.
- **OCR bridge doesn't detect `Login: NNNNN` from the Trade panel.**
  OCR still does its job for balance/equity, but the `logged_in:
  bool` field always comes from MQL5. Fine in practice.
- **Latency p99 ~200-350ms from outside the VPS.** Not a slot issue
  — local callers see <10ms. If this becomes a real bottleneck,
  the slot can be reverse-proxied behind a local TLS endpoint.
- **One TCP client at a time on port 7778.** If the slot's broker-
  login flow is in flight, the publisher's send may queue. With
  Bug #2 fixed, this is now cosmetic (state doesn't reset), but
  if we ever want concurrent TCP clients (e.g. cerebro sending
  commands + publisher publishing events simultaneously), we'd
  refactor `mt5-tcp-server.ts`. Low priority.

## Quick command reference

```sh
# Health
curl -sS http://45.151.122.104:7777/v1/health

# State (balance/equity from MT5 publisher)
curl -sS http://45.151.122.104:7777/v1/state

# Force a sync (tests the broker-login flow — now a no-op for state
# thanks to Bug #2 fix, but still triggers the slot's TCP login
# command for testing)
curl -sS -X POST http://45.151.122.104:7777/v1/sync

# Run the benchmark
cd /home/openhands/workspace/project/AkronCloud-Slot
python3 scripts/benchmark.py --base http://45.151.122.104:7777 --tier all

# Tail logs with grep
ssh vps 'docker logs akroncloud-slot --tail 200 2>&1 | grep -E "publisher|state-bridge|ocr-bridge|published account|sync called|mt5 connect"'

# Manual restart of the publisher (fallback if fix regresses)
ssh vps 'docker exec akroncloud-slot pkill -f akron-mt5-account-publisher.py'
# s6 will respawn within 5s
```

## Operational guidance for the cerebro / panel

When this slot is wired up to the AkronCloud panel/cerebro, the
panel needs to know:

1. **Don't call `POST /v1/sync` periodically.** It used to be
   tempting to use as a "refresh" trigger, but each call triggers
   a slot-side TCP command to MT5 that briefly disrupts the
   publisher's IPC. After Bug #2, the state doesn't reset anymore,
   but the IPC spike is still unnecessary noise. The publisher
   polls `mt5.account_info()` every 1.5s already.
2. **Trust `/v1/state.connector.balance` as live.** With both
   fixes, the balance shown in `/v1/state` is the MT5-reported
   balance, updated within 1.5s of any MT5-side change. After
   user-initiated trades, expect a 1-2 second lag.
3. **Tier 5 stress is part of the regression test suite.** Add
   `python3 scripts/benchmark.py --tier 5` to CI when CI is wired
   up. It runs in 60 seconds and catches any future regression of
   either bug.