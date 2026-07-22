# Handoff — Step 2 (OCR) — pending after v54 merge

> Decision 2026-07-22: Step 1 (MetaTrader5 Python lib) is blocked by
> wine named-pipe IPC. The v54 plumbing around Step 1 is merged to
> master (PR #16) and deployed to `45.151.122.104` as image
> `0.3.0-tcp-bridge-v54` (`bc55f3d92ad0`). The next path is Step 2
> (OCR with tesseract + ImageMagick), which the previous session's
> `step1-validation.md` author also recommended as "best bang for
> buck right now".

## What's live now

- Container: `akroncloud-slot` on `45.151.122.104:7777`
- Image: `ghcr.io/alxvarp/akroncloud-slot:0.3.0-tcp-bridge-v54`
- Git: `master` @ `7c0d7da` (PR #16 merged)
- Mobile link: `http://45.151.122.104:7777/mobile`
- State: `/v1/state.connector.loggedIn: false, balance: 0, equity: 0`
  (Finding C — Step 1 blocked)
- `lastError: "unknown accountRef"` (separate resolveAccount bug —
  also needs a fix)

## Why Step 1 is blocked

`mt5.initialize()` consistently returns `(-10005, 'IPC timeout')` in
the wine 11.0 environment shipped by `akron-mt5-base:mt5-preinstalled`.
The MetaTrader5 Python package talks to `terminal64.exe` via Windows
named pipes (`\\.\pipe\MT5Trade...`); wine 11.0 doesn't implement
that protocol correctly. Confirmed twice — once in `step1-validation`
sandbox, once in production after deploying v54.

The v54 publisher handles this gracefully: it logs the failure,
publishes `last_error: "mt5-init-timeout"` (or `"mt5-init-pending"`
during the first 60s), and keeps retrying. So the failure is
diagnosable — just not fixable from our code. Fixing it requires
either:

1. A wine version that implements the MetaTrader5 named-pipe protocol
   correctly (upstream wine bug, no ETA).
2. A different broker integration that doesn't go through MetaTrader5
   (Deriv has a REST API; IC Markets etc. vary). Out of scope for
   "user logs into MT5 and balance shows up".
3. Pivoting to Step 2 (OCR the MT5 Trade panel).

## What Step 2 is

Use `tesseract` 5.3.0 (already in the v54 image, came in via
`akron-mt5-base`) and ImageMagick (also already in the image) to
screenshot the MT5 Trade panel area and OCR the balance/equity
strings. Parse the output, publish to TCP 7778 with the same wire
protocol the Python publisher would.

**Architecture sketch:**

```
svc-mt5-ocr  (new s6 longrun, depends on svc-de)
  ┌─ sleep 5s ─────────────────────────────┐
  │                                         │
  │  import subprocess, json, socket        │
  │  while not _stop:                       │
  │      # screenshot the MT5 Trade panel   │
  │      # (Trade tab is the bottom-right   │
  │      #  widget of MT5's main window)    │
  │      png = subprocess.run(              │
  │          ["import", "-window",          │
  │           "root", "-display", ":0",     │
  │           "/tmp/trade.png"]             │
  │      )                                  │
  │                                         │
  │      # OCR the screenshot               │
  │      out = subprocess.run(              │
  │          ["tesseract", "/tmp/trade.png",│
  │           "-", "-l", "eng", "--psm",    │
  │           "6"],                         │
  │          capture_output=True)           │
  │                                         │
  │      # parse "Balance: 10047.32"        │
  │      # and "Equity: 10051.18"           │
  │      m_balance = re.search(             │
  │          r"Balance[:\s]+([\d.]+)",      │
  │          out.stdout)                    │
  │      m_equity = re.search(              │
  │          r"Equity[:\s]+([\d.]+)",       │
  │          out.stdout)                    │
  │                                         │
  │      if matches:                        │
  │          frame = json.dumps({           │
  │              "type": "event",           │
  │              "kind": "account",         │
  │              "data": {                  │
  │                  "logged_in": True,     │
  │                  "balance": float(      │
  │                      m_balance.group(1))│
  │                  "equity": float(        │
  │                      m_equity.group(1)) │
  │              }                          │
  │          }) + "\n"                      │
  │          client.send(                   │
  │              frame.encode("utf-8"))     │
  │                                         │
  │      sleep(5)                           │
  └─────────────────────────────────────────┘
```

**Why this works:**

- Tesseract is already in the image (akron-mt5-base installs it for
  KasmVNC's admin panel).
- ImageMagick `import` is already in the image (same reason).
- Both are standard CLI tools; no Python package install needed.
- The OCR only needs to read two numbers in a fixed position on the
  screen. Even with ~95% accuracy, we can sanity-check the result
  (balance ≈ equity ± a few % unless positions are open).
- Doesn't need `mt5.initialize()` or wine IPC at all.
- Same wire protocol as SlotService.ex5 → `/v1/state` lights up.

**Trade-offs:**

- Tesseract can mis-read (extra digit, decimal vs comma locale).
  Mitigation: re-OCR on the same frame, take majority vote; if 3
  consecutive reads disagree, fall back to last known good.
- MT5 Trade panel position can shift if user drags panels around.
  Mitigation: pin the layout in MT5 settings, or detect the panel
  region by template-matching before cropping.
- Slower than the Python lib — 5s poll instead of 1.5s, and each
  poll takes ~2-3s of CPU (OCR is heavier than reading from a
  shared-memory pipe). Acceptable.

## What else is in the way (separate bug)

`mt5-tcp-server.ts:295` calls `this.resolveAccount('')` with empty
string. `app.ts:56` then runs SQL `WHERE broker_login = ''` which
matches nothing. Result: every `account` event falls through to
`MT5 TCP: no account resolved` and the connector never updates.

Even if Step 1 worked, this would silently swallow the frames. Needs
a 3-line TS fix:

```ts
// src/services/mt5-tcp-server.ts:295
const account = this.resolveAccount(
  // For account events, try to extract the broker_login from the
  // data payload. Falls back to "" (resolveAccount should then
  // return the first active account as a default).
  (evt.data as { login?: string | number }).login?.toString() ?? ''
);
```

Plus optionally `app.ts:56-61` to add a default-return-first-account
fallback. Cheap fix, should ride along with Step 2.

## Plan for next session

1. Fix the `resolveAccount('')` bug (15 min).
2. Implement the OCR service (2-3h, low risk).
3. Test on live container (need user to be at the MT5 desktop so
   the Trade panel is rendered).
4. If OCR is accurate enough → merge Step 2 to master → mark
   "balance/equity in /v1/state" as DONE.
5. Optional follow-ups: file an upstream bug against wine for the
   `MetaTrader5` named-pipe protocol. The v54 Python publisher can
   stay in the image as a forward-compatibility shim for when wine
   fixes this.

## Files that exist now (don't re-create)

- `src/services/mt5-account-publisher.py` — Step 1 publisher
  (running but blocked on Finding C). KEEP — heartbeat-only mode
  is still useful, and it auto-recovers if wine ever fixes the IPC.
- `docs/sessions/2026-07-22-step1-validation.md` — install recipe.
- `docs/sessions/2026-07-22-slot-service-v54-handoff.md` — v54 story.
- `docs/sessions/2026-07-22-step2-pending.md` — this file.

## Open questions

- Should the OCR service live in TypeScript (same Node.js process as
  the slot) or as a separate Python s6 service (mirrors the v54
  publisher pattern)? Pros/cons either way; default to Python to
  match the publisher pattern.
- Where exactly is the MT5 Trade panel on a default layout? Test
  container required to confirm; fall back to screenshotting the
  whole MT5 window + OCRing a region around the bottom-right if the
  panel position varies.
- Should we still pursue fixing the MetaTrader5 Python lib approach
  for users on Windows (where wine isn't a factor), or treat it as
  "wine doesn't work, OCR is the way"?