# Handoff — v54 — Python account-publisher + login-detector v54

> Continuation of `2026-07-22-step1-validation.md`. The previous
> session validated the **install** side of Step 1 (Python 3.9.13
> amd64 + MetaTrader5 in wineprefix) end-to-end but left the IPC
> failure (`(-10001, 'IPC send failed')`) unsolved. This session
> ships the production-ready plumbing around the install recipe
> so a future container build can validate end-to-end with one
> `docker run`. **The runtime IPC question is still open** — the
> code, Dockerfile recipe, s6 service, and Python script are all in
> place; the only remaining unknown is whether `mt5.initialize()`
> succeeds in the wine named-pipe environment of `akron-mt5-base`.
> See "Open question" at the bottom.

## What's shipped

### 1. login-detector v54 — Finding D fix (Finding D from validation doc)

**File:** `src/services/login-detector.ts`

The previous version killed the VNC chain after detecting login
(`pkill Xvnc; pkill openbox; ...; s6-svc -D svc-de svc-kclient
svc-kasmvnc svc-nginx`). Rationale at the time was "save resources
once operational". In practice MT5 (`terminal64.exe`) dies shortly
after Xvnc goes down because it loses its X display. With MT5
dead, the MetaTrader5 Python package's `account_info()` always
returns `None`, so the Python account-publisher (item 3) has
nothing to publish — `/v1/state` reports `balance: 0, equity: 0`
even when the user is logged in.

**Fix:** removed the cascade-kill entirely. The slot now leaves
`svc-de` / `svc-kclient` / `svc-kasmvnc` / `svc-nginx` running so
MT5 keeps its display and the Python side can read `account_info()`.

**Why this is the right call, not a hack:**

- The original cascade-kill made sense for a deployment where MT5
  ran in pure headless/service mode and didn't need a display.
  That's not what `akron-mt5-base` ships — the base image runs
  MT5 under KasmVNC + openbox precisely so the user can log in
  via the web VNC viewer. Killing the display kills MT5's reason
  to exist.
- KasmVNC idle RSS is ~50 MB. Acceptable cost.
- If a future deployment needs to drop the display after login,
  the right path is `xvfb-run wine terminal64.exe /portable`
  (headless) plus an MT5 build that supports it. That's a
  separate, larger change. v54 doesn't try.

### 2. Dockerfile — Python 3.9.13 amd64 + MetaTrader5 install (Findings A+B)

**File:** `Dockerfile` (lines 365-413)

Bakes the install recipe from `2026-07-22-step1-validation.md` into
the image. Idempotent: skips if `/config/.wine/drive_c/Python39/python.exe`
already exists (re-applying the image over an existing WINEPREFIX
just upserts).

| Step | What | Why |
|---|---|---|
| 1 | Download Python 3.9.13 embeddable amd64 zip, extract to `C:\Python39\` | The base image's `C:\Python39-32\` is 32-bit; MetaTrader5 only ships 64-bit wheels. |
| 2 | Append `Lib\site-packages` to `python39._pth` | Embeddable Python defaults to `no site` — without this, `import MetaTrader5` fails immediately. |
| 3 | Download MetaTrader5 cp39-cp39-win_amd64 wheel, extract | The bridge. |
| 4 | Download numpy 1.26.4 cp39-win_amd64 wheel, extract `numpy/`, `numpy-X.Y.Z.dist-info/`, **`numpy.libs/`** | Finding A from validation: `numpy.libs/` contains the OpenBLAS DLL `_multiarray_umath.pyd` needs. Skipping this makes `import numpy` fail with "DLL load failed". |
| 5 | Copy `msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`, `ucrtbase.dll` from wine's `system32/` to `C:\Python39\` | Finding B from validation: 64-bit `python.exe` doesn't pick these up from wine's 32-bit syswow64. |
| 6 | `chown -R abc:abc` on the install | So user `abc` (which runs `svc-de` → MT5) owns it. |

Pinned versions (matches validation doc):
- `python-3.9.13-embed-amd64.zip` (Python.org)
- `MetaTrader5-5.0.5735-cp39-cp39-win_amd64.whl` (PyPI)
- `numpy-1.26.4-cp39-cp39-win_amd64.whl` (PyPI)

### 3. mt5-account-publisher.py — Finding C solution architecture

**File:** `src/services/mt5-account-publisher.py` (280 lines)

The Python half of Step 1. Behavior:

```
forever:
    if MT5 not initialized:
        try mt5.initialize()
        if fails: publish {logged_in:false, last_error:"mt5-init-pending"}
                  sleep POLL_SECS, retry
                  (give up after INIT_TIMEOUT_SECS, publish last_error:mt5-init-timeout)
        else:    MT5 is ready

    info = mt5.account_info()
    if info is None:
        publish {logged_in:false} (only if previously true)
    else:
        data = {logged_in:true, login, server, balance, equity}
        if data != last_sent: publish data

    sleep POLL_SECS (sliced in 200ms chunks for responsive SIGTERM)
```

**Wire protocol:** newline-delimited JSON over TCP 127.0.0.1:7778
— exactly what `SlotService.ex5` would have sent. The slot's
`Mt5TcpServer.publish()` (mt5-tcp-server.ts:172) validates the
frame against `AnyEvent` schema, the `Mt5Connector` (mt5.ts:471)
flips `loggedIn`/`balance`/`equity` per-account.

**Why it's defensive:**

- `try/except` around every `mt5.*` call — the C-extension raises
  on broken pipes, not return codes
- Auto-reconnect TCP client — if the slot restarts, the publisher
  reconnects on the next send attempt
- Dedupes frames — only publishes on actual change (saves ledger
  writes downstream)
- Sleeps in 200ms slices — SIGTERM stops the service in <200ms
  instead of up to 1.5s
- Falls back to heartbeat-only mode if `MetaTrader5` can't be
  imported — the slot at least knows the publisher is alive
- Configurable via env vars: `SLOT_MT5_TCP_HOST`, `SLOT_MT5_TCP_PORT`,
  `MT5_ACCOUNT_POLL_SECS`, `MT5_INIT_RETRY_SECS`, `MT5_INIT_TIMEOUT_SECS`,
  `LOG_LEVEL`

**Designed-for-failure:**
If Finding C (the wine IPC limitation) proves unsolvable, the
script's heartbeat-only mode means `/v1/state` will report
`loggedIn: false, last_error: "mt5-init-pending"` instead of
`loggedIn: true, balance: 0`. That's a regression but a diagnosable
one — `last_error` surfaces the failure mode and the slot's `account:error`
bus event fires. Compare to v53 which silently reported `loggedIn: true,
balance: 0` because the cascade-kill had killed MT5.

### 4. s6 service — `svc-mt5-account-publisher`

**File:** `Dockerfile` (lines 415-448)

New longrun s6 service. Depends on `svc-de` (openbox session that
launches MT5). Sets the env vars the recipe needs:

```bash
export WINEPREFIX=/config/.wine
export WINEDEBUG=-all
export HOME=/config
export XDG_RUNTIME_DIR=/config/.XDG
export DISPLAY=:0
export PYTHONHASHSEED=0      # mandatory: wine's advapi32.SystemFunction036 is unimplemented
cd /config
exec s6-setuidgid abc /opt/wine-stable/bin/wine \
  /config/.wine/drive_c/Python39/python.exe \
  /opt/akron-mt5-account-publisher.py
```

Why each env var matters (documented in detail in
`2026-07-22-step1-validation.md §UNEXPECTED FIND`):
- `WINEPREFIX` — wine finds the right prefix
- `WINEDEBUG=-all` — silence wine's stderr (very chatty)
- `HOME`, `XDG_RUNTIME_DIR` — some Python bits need them, default to root otherwise
- `DISPLAY=:0` — MetaTrader5 needs an X display even if just for IPC bootstrap
- `PYTHONHASHSEED=0` — without this, Python's hash randomization init calls `advapi32.SystemFunction036` (RtlGenRandom) which wine doesn't implement; Python crashes before any code runs

### 5. login-detector v54 test compatibility

The Finding D fix preserves all 7/7 existing login-detector tests:

```
✓ tests/login-detector.test.ts  (7 tests) 30ms
```

The "already operational" test still passes because on startup with
state `operational`, the code calls `onTransition()` exactly once
without entering the tick loop. The cascade-kill was inside the
tick → `logged_in` branch, which is never reached on this test path.

Full suite baseline unchanged: 48 pass, 11 fail. The 11 failures are
pre-existing EADDRINUSE on :7778 from a stuck test process — not
related to v54. To get a clean baseline, run tests with port 7778
free:

```sh
fuser -k 7778/tcp 2>/dev/null
npx vitest run
```

## File changes summary

| File | Status | Lines |
|---|---|---|
| `src/services/login-detector.ts` | modified | -32 / +20 (Finding D) |
| `Dockerfile` | modified | +86 / 0 (install + s6 service) |
| `src/services/mt5-account-publisher.py` | new | 280 |
| `docs/sessions/2026-07-22-slot-service-v54-handoff.md` | new | this file |

## Open question — Finding C still unresolved

The only thing this PR does NOT solve is Finding C from the validation
doc:

> `mt5.initialize()` returns `(-10001, 'IPC send failed')` in this
> wine sandbox.

The script's `try_init_mt5()` will hit this exact failure every time
in the current wine 11.0 environment. The script degrades gracefully
to heartbeat-only mode (publishes `logged_in: false, last_error:
"mt5-init-pending"`), but `/v1/state` will NOT show `balance: N,
equity: M`.

**What needs to happen for this to work end-to-end:**

1. Run `docker build` with the new Dockerfile → image
   `ghcr.io/alxvarp/akroncloud-slot:0.3.0-tcp-bridge-v54`.
2. Spin up a test container from v54 (NOT touching the live v4).
3. Log into MT5 via the web VNC viewer.
4. Tail `s6-log` for `svc-mt5-account-publisher`. Look for either:
   - ✅ `mt5.initialize() ok — terminal: <info>` followed by
     `published account: login=X server=Y balance=N.M equity=P.Q`
     → **Step 1 works**. Ship it.
   - ❌ `mt5.initialize() failed: (-10001, 'IPC send failed')` →
     **Step 1 blocked**. Pivot to Step 2 (OCR with tesseract).
     The script still ships — it's a regression-detector and a
     future-working path when the wine IPC issue is solved.

## State of the live system

- `akroncloud-slot` (v4) still up, healthy, untouched. v54 is on
  branch `feat/slot-v54-python-mt5`, NOT pushed, NOT deployed.
- `ghcr.io/alxvarp/akroncloud-slot:0.3.0-tcp-bridge-v53` still the
  latest image on GHCR (sha `f303abe1...`).
- 5 unpushed commits from previous sessions remain on master
  (`6b61ac3` `42082a7` `186aaa3` `36d74a2` `20d8ca2`). The v54
  changes are on top of those, on the feature branch.

## Next chat — when continuing

If Finding C fails in real-world validation:

1. The fix has value on its own — the cascade-kill removal (Finding
   D) is correct regardless. Land it as a separate small commit on
   master if it tests cleanly.
2. Pivot to Step 2 (OCR with tesseract). Tools are already in the
   image. ~1-2h of work.
3. Consider filing an upstream bug against `wine` for the
   `MetaTrader5` named-pipe protocol. The script can stay in the
   image as a forward-compatibility shim for when wine (or a
   future wine-prefix rebuild) fixes this.

If Finding C succeeds:

1. Merge `feat/slot-v54-python-mt5` into master.
2. Build & push the v54 image.
3. Deploy to the live slot (replace v4 with v54).
4. Verify `/v1/state` reports real balance + equity.
5. Delete the obsolete SlotService.ex5 + bridge-adapter + autostart
   hackery (separate cleanup PR).