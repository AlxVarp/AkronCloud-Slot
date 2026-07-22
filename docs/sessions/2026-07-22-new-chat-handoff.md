# Handoff — continuation doc for the next chat

> Written 2026-07-22 mid-session because the user said "vamos a
> irnos a un nuevo chat" (we're going to a new chat). The repo is
> `AlxVarp/AkronCloud-Slot`, on `master`, with two commits ahead
> of `origin/master` that are NOT pushed yet. Image
> `ghcr.io/alxvarp/akroncloud-slot:0.3.0-tcp-bridge-v53` IS
> pushed.

## What the user wanted

The slot's `/v1/state` was returning `connector.loggedIn: false,
balance: 0` even after the user logged into MT5 manually via the
KasmVNC desktop. Root cause: the MQL5 `SlotService.ex5` that
normally publishes `account_status` over TCP 127.0.0.1:7778 was
not running — MT5 build 5836 doesn't autostart services on a
fresh WINEPREFIX (the GUI "right-click → Add Service" step has
to happen at least once, manually).

User wanted the slot to know about MT5 login without the user
having to touch MT5 → Tools → Options → Allow Services or the
Services tab in the Navigator. Bonus goal (user pushed for it
mid-session): real `balance: N` and `equity: M` in `/v1/state`,
not just `loggedIn: true`.

## What's already shipped

### v52 — Dockerfile-side keys (commit `6b61ac3`)
Path fix + Wine registry stamp + `[Experts]` in terminal.ini.
The Dockerfile changed to put `SlotService.ex5` and friends
under `Program Files/MetaTrader 5/` (where the running MT5
actually is, not `users/abc/...`). Plus registry stamps for
`HKCU\Software\MetaQuotes Software\MetaTrader 5\Settings\AllowServices=1`
and `Services\SlotService` subkey with `Allow=1, AutoStart=1,
Enabled=1, Name, Path`.

**Result: SlotService still doesn't autostart.** MT5 services
tab list is populated only by GUI right-click → Add Service
on a fresh WINEPREFIX, and the per-install binary cache that
MT5 keeps for "auto-start on next launch" is empty on first boot.

### v53 — slot-side login-detector → MT5 connector (commits
`186aaa3` + handoff `36d74a2`)

`loggedIn: true` works WITHOUT MQL5. Three small files changed:

1. `src/services/mt5-tcp-server.ts`: new `publish(evt)` method
   that validates against `AnyEvent` schema and calls
   `handleEvent` directly. Same code path as a wire frame
   from the SlotService. ~26 lines.

2. `src/services/login-detector.ts`: rewritten as a state
   machine. On every `wmctrl` tick it detects logged_in ↔
   logged_out transitions and publishes
   `{kind:'account', data:{logged_in:true|false}}` to the
   Mt5TcpServer. Symmetric (handles logout, was one-shot before).
   ~96 lines diff.

3. `src/app.ts`: passes the `mt5Tcp` instance to
   `startLoginDetector` so it can call `.publish()`.

**Tests:** `login-detector.test.ts` 7/7 passed. Full suite 48/59
(the 11 failures are all pre-existing EADDRINUSE on :7778 from
the still-running v4 container holding the port — unrelated).

**Deployed at:** `ghcr.io/alxvarp/akroncloud-slot:0.3.0-tcp-bridge-v53`
sha256 `f303abe1d995bc0f51551ce02584d36f3b876d66d8a35bc10fd7b03275cc97ba`.

**Trade-off:** `loggedIn: true` works, but `balance: 0, equity: 0`
because the login-detector can detect "user is logged in"
(wmctrl window title) but can't read MT5's internal balance
without MQL5 calling `AccountInfoDouble(ACCOUNT_BALANCE)`.

## What's NOT done — the gap

The user wants `balance: N, equity: M` in `/v1/state`. The slot
currently returns `balance: 0` even after login because nothing
in the system has access to MT5's account state.

The only thing that CAN read balance natively is an MQL5 process
(`SlotService.ex5` or a chart indicator). And `SlotService.ex5`
is `#property service` so it doesn't autostart on fresh WINEPREFIX.

The user explicitly said "avanza con eso no?" — go ahead with
getting balance.

## What I tried in the last session that you should NOT redo

| Path tried | Outcome | Why it didn't work |
|---|---|---|
| Convert SlotService to `#property indicator` and compile in build stage via `xvfb-run wine MetaEditor64.exe /compile:` | ❌ blocked | metaeditor64.exe CLI mode returns `ShellExecuteEx failed: File not found` in every wine setup tried. The binary opens fine as a GUI but the CLI compile path is broken in this sandbox. Tested in fresh wineprefix, in the v4 wineprefix, with/without xvfb, with/without /portable. |
| Shim via `MetaTrader5` Python package | ❌ blocked | Package is Windows-only — no PyPI wheel for Linux, `pip install MetaTrader5` fails. (BUT — see "UNEXPECTED FIND" below, I broke through this barrier at the very end.) |
| `xdotool` to add the service to MT5's Navigator via GUI scripting | ❌ broken in this env | `Ctrl+N` doesn't open the Navigator, clicking Navigator menu items doesn't trigger. Wine keyboard input routing seems broken for this specific MT5 session state. Would probably work on a clean fresh container, but I couldn't verify without disrupting the user's live v4 session. |
| One-time manual add via VNC | ✅ works but not zero-touch | 30-second click-through: View → Navigator → right-click Services → Add → `MQL5/Services/SlotService.ex5` → right-click → Start. After that, MT5 persists the "Start with terminal" flag and autostarts the service on every reboot. |

## UNEXPECTED FIND — read this carefully

At the very end of the session, I tried installing MetaTrader5
into the wine Python embedded in the wineprefix
(`C:\Python39-32\python.exe` — installed by akron-mt5-base for
MQL5 scripts). I had to:

1. Download the wheel manually (Linux pip can't fetch it —
   no Linux wheel exists): the URL is
   `https://files.pythonhosted.org/packages/6a/05/2da597e23c6ab603ebb1afe0925e6c17656830948987c13768890202cb59/metatrader5-5.0.5735-cp39-cp39-win_amd64.whl`
   (cp39-cp39m-win_amd64, version 5.0.5735). Extract with `zipfile`,
   copy `MetaTrader5/__init__.py` + `_core.cp39-win_amd64.pyd` into
   `C:\Python39-32\Lib\site-packages\MetaTrader5\`.
2. Edit `C:\Python39-32\python39._pth` to add `Lib\site-packages`
   (it wasn't there — embeddable Python defaults to no site).
3. Run with `PYTHONHASHSEED=0` env var — without it, wine's
   `advapi32.dll.SystemFunction036` (used by Python's hash
   random init) is unimplemented and Python crashes before
   any code runs.
4. **Bit-width trap:** the wine Python in akron-mt5-base is
   **32-bit** (`MSC v.1929 32 bit (Intel)`), but the MetaTrader5
   wheel on PyPI is **64-bit only** (cp39-cp39m-**win_amd64**).
   The .pyd file won't load in 32-bit Python. PyPI does NOT
   publish a 32-bit wheel for MetaTrader5. To use the package
   you need a 64-bit Python in the wineprefix — either install
   one manually (Python 3.9.13 embeddable 64-bit zip into
   `C:\Python39\` — the akron-mt5-base only ships the 32-bit
   one at `C:\Python39-32\`) OR keep using the 32-bit one and
   accept that MetaTrader5 won't load.

**Where I left off:** the import was tested (`from
MetaTrader5._core import *` failed with `ModuleNotFoundError`
because of the 32/64 mismatch). The .pyd and .py files are in
place in `C:\Python39-32\Lib\site-packages\MetaTrader5\`. The
.pth file is edited. The user's question was the next thing to
investigate but the chat ended.

## Recommended next steps (in order)

**Step 1 — Try the 64-bit Python approach** (1-2h, HIGH payoff)

a. Get a 64-bit Python embeddable zip:
   `https://www.python.org/ftp/python/3.9.13/python-3.9.13-embed-amd64.zip`
   (or newer if compatible). Copy it into the wine prefix:
   ```
   /config/.wine/drive_c/Python39/
   ```
   (NOT the `Python39-32/` dir — that's the 32-bit one.)

b. Add the 64-bit Python's path to MT5's auto-launch OR run
   it via a one-shot s6 service that runs after MT5 is up. The
   script does:
   ```python
   import MetaTrader5 as mt5
   mt5.initialize()
   # connect to TCP 7778 and push account events
   ```
   This is the standard MT5 Python integration, no compilation
   needed, no xdotool needed, no MQL5 needed.

c. The script:
   - Polls `mt5.account_info()` every 1-2 seconds
   - On change, sends `{kind:'account', data:{logged_in,
     balance, equity, login, server}}` to the slot via TCP 7778
   - Reuses the wire protocol that SlotService would have used

d. This solves the original problem end-to-end:
   - `loggedIn: true` ✓ (already works via login-detector)
   - `balance: N, equity: M` ✓ (via MetaTrader5 Python)
   - No MQL5 needed ✓
   - No manual VNC add needed ✓
   - No xdotool fragility ✓

**Step 2 — If Step 1 fails, try the OCR path** (already started,
documented in handoff `2026-07-22-slot-service-v53-handoff.md`)

Use `tesseract` (5.3.0, already in the slot image) +
ImageMagick (also already there) to screenshot the MT5 Trade
panel and OCR "Balance: N | Equity: M". Less elegant but
doesn't require any new Python package.

**Step 3 — If both fail, the manual VNC add**

Document the one-time manual step in the deployment docs.
Not zero-touch but works.

**Step 4 — Properly fix the root cause** (separate PR / future
env that has working metaeditor)

The chart indicator + bake template approach. Doesn't need
Python integration, lives entirely inside MT5.

## Where things live in the repo

```
AkronCloud-Slot/
├── docs/sessions/
│   ├── 2026-07-22-slot-service-autoenable.md   (dd43e37 — original handoff)
│   ├── 2026-07-22-slot-service-v52-handoff.md   (42082a7 — Dockerfile-side keys)
│   └── 2026-07-22-slot-service-v53-handoff.md   (36d74a2 — slot-side login-detector)
├── src/
│   ├── services/
│   │   ├── mt5-tcp-server.ts    (v53: added publish() method)
│   │   ├── login-detector.ts    (v53: state machine + publish)
│   │   └── mt5-bridge-adapter.py (legacy, still running but unused for v53)
│   └── app.ts                   (v53: passes tcp to login-detector)
├── Dockerfile                    (v52: paths + registry + [Experts])
├── docker-compose.yml           (image tag: 0.3.0-tcp-bridge-v53)
└── tests/login-detector.test.ts  (7/7 passing)
```

## Commit graph on master (3 ahead of origin)

```
dd43e37  docs: continuation handoff for slot-service auto-enable
6b61ac3  fix(docker): make SlotService autostart-ready on first MT5 boot   (v52)
42082a7  docs: v52 handoff                                                       (v52 doc)
186aaa3  feat(slot): login-detector publishes account events to Mt5Connector  (v53)
36d74a2  docs: v53 handoff                                                       (v53 doc)
```

Plus one NEW commit for this handoff (uncommitted at time of
writing, file at `docs/sessions/2026-07-22-new-chat-handoff.md`).

## Image registry

- `ghcr.io/alxvarp/akroncloud-slot:0.3.0-tcp-bridge-v52` — superseded
- `ghcr.io/alxvarp/akroncloud-slot:0.3.0-tcp-bridge-v53` — current
  (sha256 `f303abe1d995bc0f51551ce02584d36f3b876d66d8a35bc10fd7b03275cc97ba`)
- `ghcr.io/alxvarp/akroncloud-slot:0.3.0-tcp-bridge-v4` — the
  pre-v52 image still running on the VPS as `akroncloud-slot`.

## Things to NOT break

- The `slot.state` file at `/var/lib/akron-slot/state` is
  state-machine driven by login-detector. Don't rewrite it
  from a new service without coordinating with login-detector.
- The `tcp.publish()` method on `Mt5TcpServer` validates the
  schema and dispatches to the same `handleEvent` that wire
  frames use. The slot's `Mt5Connector` doesn't know the
  difference between a wire frame and a `publish()` call — and
  shouldn't.
- The `mt5-bridge-adapter` Python service is still running
  inside the slot container but is dead code for v53
  (`SLOT_BRIDGE=tcp` means the slot consumes TCP events, not
  the bridge-adapter's ZMQ output). Cleanup PR for another
  day — keeping it for now to avoid scope creep.
- The Dockerfile writes paths to `users/abc/...` in several
  places that are NOT actually used by the running MT5. Don't
  try to "fix" these by deleting them — they're harmless
  and the Dockerfile would break.

## Open questions for the next chat

1. Should we pull `0.3.0-tcp-bridge-v4` to v53 manually first
   (before the next fresh deploy) so the user has a known-
   good baseline? They currently have v4 running on the VPS.

2. The login-detector has a wmctrl regex that occasionally
   false-positives during MT5 startup (the `MetaTrader 5` main
   window title matches before the login dialog appears). The
   detector self-corrects within 1.5s but it does publish a
   brief `{logged_in: true}` event first. Not a bug but worth
   tracking. (The slot's Mt5Connector just sets loggedIn=true
   then back to false on the next tick — net effect on
   /v1/state is zero.)

3. For the MetaTrader5 Python path: even after the 64-bit
   Python issue is solved, `mt5.initialize()` from inside
   wine-python needs to find the running MT5 terminal. The
   standard way is via the per-install hash directory in
   `AppData/Roaming/MetaQuotes/Terminal/<hash>/`. There's a
   `D0E8209F77C8CF37AD8BF550E51FF075/` dir already in the
   akroncloud-slot v4 container for the Program Files install
   (matches the per-install hash of `C:\Program Files\MetaTrader 5\`).
   Verify this works in the v53 image too.

## User's last message

> "Puedes dejar una introducción o dame un txt porque vamos a
> irnos a un nuevo chat"

Translation: "Can you leave an intro or give me a txt because
we're going to a new chat."

So: hand off cleanly. This doc is the handoff. Good luck.
