# v54 step-1 validation — 64-bit Python + MetaTrader5 in wineprefix

> Continuation of `2026-07-22-new-chat-handoff.md`. This chat
> validated the **install** side of "Step 1" (the handoff's HIGH-
> payoff path) end-to-end in a fresh test container built from
> `akroncloud-slot:0.3.0-tcp-bridge-v53`. Findings: install works
> cleanly, but **`mt5.initialize()` fails in this wine sandbox** —
> the IPC pipe between the MetaTrader5 .pyd and the running MT5
> does not establish. Plus three new findings the original handoff
> did not mention (numpy.libs/, MSVC runtime DLLs, the v53
> login-detector transitively killing MT5).

## TL;DR

| What | Status |
|---|---|
| 64-bit Python 3.9.13 embeddable installs at `C:\Python39\` | ✅ works |
| `numpy` 1.26.4 cp39-win_amd64 + `.libs/` openblas DLL | ✅ works |
| `MetaTrader5` 5.0.5735 cp39-win_amd64 wheel | ✅ works |
| `import MetaTrader5 as mt5` → `mt5.__version__ == '5.0.5735'` | ✅ works |
| `mt5.initialize()` returns `True` against running MT5 in wine | ❌ blocked |
| `mt5.account_info()` returns balance/equity | ❌ blocked by prev |

**The install recipe works. The runtime does not, in this wine
sandbox.** A test container was spun up from the v53 image, the
install was performed, `import MetaTrader5` succeeded, but
`mt5.initialize()` returns `(-10001, 'IPC send failed')` (or hangs
indefinitely when called with `path=` to launch MT5 itself).

## Test container used

- Image: `akroncloud-slot:0.3.0-tcp-bridge-v53` (local, 2h old)
- Name: `akron-slot-v53-test` (stopped + removed after testing)
- Volume: `slot-state-test:/var/lib/akron-slot` (fresh, removed)
- Ports (host → container): `17777:7777`, `17778:7778`,
  `13000:3000` (all bound `127.0.0.1` on host, isolated from v4)
- Live v4 container `akroncloud-slot` was **never touched**.

## What I did, in order

1. Started `akron-slot-v53-test` from the v53 image with isolated
   ports. Verified `MT5 login detected → operational` then
   `from logged_in to logged_out` — the v53 login-detector
   worked exactly as the v53 handoff describes.
2. Confirmed the wineprefix has `Python39-32/` (32-bit, untouched
   by the slot Dockerfile, baked in by `akron-mt5-base`).
3. Downloaded Python 3.9.13 embeddable **amd64** zip into the
   container. Extracted to `C:\Python39\`.
4. Edited `python39._pth` to add `Lib\site-packages` (embeddable
   Python defaults to `no site`).
5. Downloaded `MetaTrader5-5.0.5735-cp39-cp39-win_amd64.whl`.
   Extracted to `C:\Python39\Lib\site-packages\MetaTrader5\`.
6. **First `import MetaTrader5` failed** with
   `numpy._core.multiarray failed to import`. Downloaded numpy
   1.26.4 cp39-win_amd64 wheel. Extracted `numpy/` and
   `numpy-1.26.4.dist-info/`. Test passed. **But then it failed
   again** with `ImportError: DLL load failed while importing
   _multiarray_umath: Module not found`. WINEDEBUG=+loaddll
   revealed the missing DLL was
   `libopenblas64__v0.3.23-293-...dll` (bundled in the wheel's
   `numpy.libs/` top-level directory). **Copied `numpy.libs/`
   too. Test passed.**
7. Confirmed `numpy` and `MetaTrader5` import successfully:
   ```
   numpy: 1.26.4
   mt5 loaded: C:\Python39\Lib\site-packages\MetaTrader5\__init__.py
   mt5 version: 5.0.5735
   has initialize: True
   has account_info: True
   ```
8. **Called `mt5.initialize()` with no args → returned
   `(-10001, 'IPC send failed')`.** With `XDG_RUNTIME_DIR` set:
   same error. With `path=` and `portable=True`: hung indefinitely.
9. Killed the test container, removed the test volume. **Live v4
   untouched.**

## Three new findings (not in `2026-07-22-new-chat-handoff.md`)

### Finding A — `numpy.libs/` must be copied explicitly

The numpy wheel ships a top-level `numpy.libs/` directory
containing the OpenBLAS DLL
(`libopenblas64__v0.3.23-293-gc2f4bdbb-gcc_10_3_0-2bde3a66a51006b2b53eb373ff767a3f.dll`,
38 MB). If you only `cp -r numpy/ numpy-1.26.4.dist-info/` to
site-packages, `_multiarray_umath.pyd` cannot find its BLAS
dependency and `import numpy` fails with:

```
ImportError: DLL load failed while importing _multiarray_umath: Module not found.
```

**Fix:** `cp -r numpy.libs/ /config/.wine/drive_c/Python39/Lib/site-packages/`
alongside numpy and numpy-X.Y.Z.dist-info. Verified: after this
copy, `import numpy` succeeds.

The original handoff said "the .pyd and .py files are in place"
but did not mention numpy or numpy.libs because the previous
session never got past the 32/64 mismatch.

### Finding B — MSVC runtime DLLs must be next to python.exe

The 64-bit native `python.exe` cannot find the MSVC runtime DLLs
(`msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`,
`ucrtbase.dll`) via wine's `syswow64` (which is 32-bit). It looks
in the same directory as python.exe first.

**Fix:** `cp /config/.wine/drive_c/windows/system32/{msvcp140,
vcruntime140, vcruntime140_1, ucrtbase}.dll /config/.wine/drive_c/Python39/`

(These are 64-bit native DLLs, verified with `file` — `PE32+
x86-64`. Without them, `import numpy` fails immediately with
"the OS cannot find the runtime" type errors before even reaching
multiarray.)

### Finding C — `mt5.initialize()` does NOT work in this wine env

This is the killer finding. The MetaTrader5 Python package talks
to the running MT5 terminal via a Windows named pipe (no separate
daemon process — the `.pyd` opens the pipe directly). In wine
11.0, the named pipe either doesn't get created by MT5 or can't
be opened by the .pyd. Symptoms observed:

| `mt5.initialize(...)` call | Result |
|---|---|
| `()` (no args, MT5 already running with display) | returns `False`, `last_error == (-10001, 'IPC send failed')` |
| `(path=..., portable=True)` (MT5 already running) | hangs indefinitely, even with `timeout=10000` |
| `(path=..., portable=True)` after `pkill terminal64.exe` | hangs indefinitely (tries to launch MT5 itself, gets stuck) |

With `XDG_RUNTIME_DIR=/config/.XDG` and `HOME=/config` set, with
MT5 fully booted (wineserver alive, terminal64.exe PID confirmed
via `pgrep`), with `WINEDEBUG=+loaddll` enabled — wine loads
python.exe, the .pyd loads, but the IPC handshake never
completes. The wine named-pipe mechanism (`wine_stream_pipe`)
appears to be the bottleneck.

**Possible explanations** (unconfirmed):
1. Wine's named pipe support is incomplete for the specific
   protocol MT5 uses (named pipe over `\\.\pipe\MT5Trade...`).
2. MT5 in wine creates pipes in a different way (e.g. Unix
   sockets under `/tmp/.wine-<uid>/`) that the MetaTrader5 .pyd
   doesn't know how to find.
3. The .pyd's IPC code uses Win32 APIs (`CreateFile` with
   `\\.\pipe\...`) that wine translates but with a path mangling
   that breaks the connection.

**Not tried** (would be a separate investigation):
- `mt5linux` (the Linux wrapper that uses rpyc to talk to a
  Windows MT5+MetaTrader5 setup). It exists in the container at
  `/config/.local/lib/python3.11/site-packages/mt5linux/` but
  requires a Windows broker which defeats the purpose.
- Wine `wineserver` named-pipe inspection (would need a custom
  wineserver patch or strace).
- Running MT5 with a different Wine prefix or different wine
  version.

## Finding D — v53 login-detector transitively kills MT5

While testing, I observed that the v53 login-detector's cascade
kill (`pkill Xvnc; pkill openbox; ...`) leaves MT5 (`terminal64.exe`)
alive briefly, then it dies — likely because MT5 loses its X
display when Xvnc goes down. So even if the MetaTrader5 IPC
worked, **`account_info()` would always return None** in a v53
container because by the time the slot reports
`loggedIn: true`, MT5 is already dead.

This is a v53 regression that the original handoff did not
flag. The user-reported symptom (`loggedIn: true, balance: 0`)
might partly be because MT5 isn't alive to provide balance,
not just because SlotService.ex5 doesn't autostart.

**Fix for v54 (if we go that route):** either
- Make the cascade-kill conditional on something other than
  `logged_in` (e.g. only kill VNC if no chart is open and the
  user hasn't interacted for N minutes), OR
- Run MT5 in a way that doesn't need Xvnc once logged in
  (`xvfb-run wine ...` or similar), OR
- Make `account_info()` read from a cached snapshot that
  SlotService.ex5 wrote to `MQL5/Files/` before login (but that
  needs SlotService to autostart, which is the original problem).

## Install recipe (works end-to-end through `import MetaTrader5`)

Saved at `/tmp/setup/INSTALL_RECIPE.sh` inside the test container
before teardown. Restated here:

```bash
#!/bin/bash
# Install 64-bit Python + MetaTrader5 in an existing wineprefix.
# Pre-req: MT5 terminal64.exe runs OK under wine; /config/.wine
# owned by user 'abc'. Run as user 'abc'.

set -e
WINEPREFIX=/config/.wine
WINE=/opt/wine-stable/bin/wine
PY64="$WINEPREFIX/drive_c/Python39"
MIRROR=https://files.pythonhosted.org/packages

# Env vars that MUST be set when running wine python afterwards:
export WINEPREFIX=$WINEPREFIX WINEDEBUG=-all PYTHONHASHSEED=0
export HOME=/config XDG_RUNTIME_DIR=/config/.XDG DISPLAY=:0

mkdir -p /tmp/setup && cd /tmp/setup

# 1. Python 3.9.13 embeddable amd64
curl -sSL -o py64.zip https://www.python.org/ftp/python/3.9.13/python-3.9.13-embed-amd64.zip
mkdir -p "$PY64"
(cd "$PY64" && unzip -q /tmp/setup/py64.zip)
echo 'Lib\site-packages' >> "$PY64/python39._pth"   # embeddable defaults to no site

# 2. MetaTrader5 cp39-cp39m-win_amd64 wheel
curl -sSL -o mt5.whl "$MIRROR/6a/05/2da597e23c6ab603ebb1afe0925e6c17656830948987c13768890202cb59/metatrader5-5.0.5735-cp39-cp39-win_amd64.whl"
mkdir -p "$PY64/Lib/site-packages"
unzip -q mt5.whl -d mt5_extract
cp -r mt5_extract/MetaTrader5 "$PY64/Lib/site-packages/"

# 3. numpy 1.26.4 cp39-win_amd64 (version pinned — known to work)
curl -sSL -o numpy.whl "$MIRROR/b5/42/054082bd8220bbf6f297f982f0a8f5479fcbc55c8b511d928df07b965869/numpy-1.26.4-cp39-cp39-win_amd64.whl"
unzip -q numpy.whl -d np_extract
cp -r np_extract/numpy "$PY64/Lib/site-packages/"
cp -r np_extract/numpy-1.26.4.dist-info "$PY64/Lib/site-packages/"
cp -r np_extract/numpy.libs "$PY64/Lib/site-packages/"        # <-- NOT in original handoff

# 4. MSVC runtime DLLs next to python.exe
cp "$WINEPREFIX/drive_c/windows/system32/"{msvcp140,vcruntime140,vcruntime140_1,ucrtbase}.dll "$PY64/"

chown -R abc:abc "$PY64"

# 5. Test
"$WINE" "$PY64/python.exe" -c \
  'import MetaTrader5 as mt5; print("mt5:", mt5.__version__, "has init:", hasattr(mt5, "initialize"))'
```

Expected output:
```
mt5: 5.0.5735 has init: True
```

## Recommended next steps (my opinion, not pushed)

The user's primary remaining goal is **`balance: N, equity: M` in
`/v1/state`**. The handoff's ranked options:

1. **Step 1 (MetaTrader5 Python)** — install recipe works, but
   runtime (mt5.initialize) is blocked in this wine sandbox.
   **Recommend deferring** until either (a) someone proves wine
   named pipes work for MetaTrader5 with a known-good wine
   config, or (b) we move the broker integration off MetaTrader5
   entirely (e.g. to the broker's REST API).

2. **Step 2 (OCR with tesseract)** — tesseract + ImageMagick are
   already in the slot image (per the v53 handoff). Wire up a
   small s6 service that screenshots the MT5 Trade panel area,
   runs tesseract, parses "Balance: N | Equity: M", publishes to
   TCP 7778 like the MetaTrader5 Python service would. ~1-2h of
   work, low risk, no new infrastructure. **This is my pick for
   "best bang for buck right now".**

3. **Step 3 (manual VNC)** — works but not zero-touch. Document
   the manual step, accept the limitation.

4. **Step 4 (chart indicator + proper metaeditor64)** — proper
   root-cause fix. Needs a working `metaeditor64.exe /compile:` in
   some env. The v53 handoff said this was blocked in this
   sandbox. Worth revisiting if someone can find a clean wine
   that supports the metaeditor CLI.

## Files touched in the repo by this session

None. **The 5 unpushed commits from the previous session are
unchanged.** This file is saved locally and is **not committed** —
the user should decide whether to add it as a 6th commit.

## State of the live system

- `akroncloud-slot` (v4) still up 2 days, healthy, untouched.
- `ghcr.io/alxvarp/akroncloud-slot:0.3.0-tcp-bridge-v53` still
  pushed (sha `f303abe1...`). Not yet deployed to live (the v53
  handoff flagged this as Open Question #1).
- 5 unpushed commits on master:
  - `6b61ac3` — fix(docker): make SlotService autostart-ready on first MT5 boot (v52)
  - `42082a7` — docs: v52 handoff
  - `186aaa3` — feat(slot): login-detector publishes account events (v53)
  - `36d74a2` — docs: v53 handoff
  - `20d8ca2` — docs: handoff for next chat (v52+v53 summary)