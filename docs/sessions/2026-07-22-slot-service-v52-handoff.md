# v52 SlotService — path + registry fix (2026-07-22)

> Continuation of `2026-07-22-slot-service-autoenable.md` (commits
> dd43e37 → 6b61ac3 on master). All three root causes of the
> "MT5 starts but SlotService.ex5 never connects to the slot"
> condition identified in the previous chat are now fixed in
> the image. Verification still requires the one-time manual
> start on a fresh WINEPREFIX — see "Known limitation" below.

## What changed in v52

Commit `6b61ac3` on `master`. Diff: `Dockerfile` +116 / -21,
`docker-compose.yml` +1 / -1. Image:
`ghcr.io/alxvarp/akroncloud-slot:0.3.0-tcp-bridge-v52`
(`sha256:c14adc98d9d34fb638b27b9346aed23bebc5c54bb9b206e4b677bd5be177fe26`).

### 1. Path fix: users/abc → Program Files

The autostart script (`/config/.config/openbox/autostart`) has
been launching `Program Files/MetaTrader 5/terminal64.exe` since
commit ad1965e, but the Dockerfile still wrote SlotService.ex5
+ `[Experts]` + `services.ini` under the user-space
`users/abc/MetaTrader 5/` install (the old `start.sh` location).
The two diverged, so the running MT5 never saw the .ex5 nor
read services.ini. The v52 Dockerfile moves all three to the
Program Files install.

This was the single biggest root cause. The slot has been
shipping with the service binary in a path MT5 never reads
since the v50-series migration to the program-files launcher.

### 2. [Experts] terminal.ini — three toggles, not one

Old Dockerfile only stamped `AllowDllImport=1`. v52 also stamps
`AllowServices=1` (the MQL5 service-mode toggle in Tools → Options
→ Expert Advisors → "Allow Services") and `AllowAlgoTrading=1`
(the master "Enable Expert Advisors" toggle). Both default to
off in a fresh MT5 install. The v52 step is idempotent
(upsert via Python) so re-applying the image over an existing
WINEPREFIX just keeps the keys.

### 3. Wine registry stamp

`user.reg` under
`Software\MetaQuotes Software\MetaTrader 5\Settings\AllowServices=1`
(master toggle) + a `Services\SlotService` subkey with the same
five values the GUI writes when you right-click → Add Service
→ Start with terminal:

```
Allow      = dword:00000001
AutoStart  = dword:00000001
Enabled    = dword:00000001
Name       = "SlotService"
Path       = "C:\\Program Files\\MetaTrader 5\\MQL5\\Services\\SlotService.ex5"
```

The v52 Dockerfile also creates `Profiles/Default/services.ini`
with the standard `[Services] SlotService=SlotService.ex5` line
in case MT5 build 5836 honours the ini variant (empirically it
does not — see caveat).

## Verification (in a fresh container from the v52 image)

```sh
# 1. Pull the new image
ssh vps
cd /srv/akron
docker compose pull akroncloud-slot      # NOT just `restart` — restart reuses
docker compose up -d akroncloud-slot    # the running v4 container.
docker logs -f akroncloud-slot 2>&1 | grep -E 'slot transitioned|operational'
# 2. Curl /v1/state from the user's browser
curl -sS http://45.151.122.104:7777/v1/state | python3 -m json.tool
# 3. From the celu, open /mobile → click Login → type Deriv creds
#    → Save & Fill. The wrapper types the creds into MT5.
# 4. Click Sync.
# 5. /v1/state should now show loggedIn: true, balance: N.
```

## Known limitation — first-run manual start still required

Despite all three fixes above, the v52 image does **not** auto-launch
SlotService on a fresh WINEPREFIX. MT5 build 5836 requires the
user (or a one-time script) to do the first manual right-click →
Start in the Navigator's "Services" tab, AFTER which MT5 persists
the "auto-start on next launch" state in the per-install hash
dir (`AppData\Roaming\MetaQuotes\Terminal\<hash>\`) and the
service auto-launches on every subsequent boot.

Tested twice — once in the running v4 container (after manually
copying SlotService.ex5 + services.ini + [Experts] into
`Program Files/...` and writing all five registry values), and
once in a fresh v52 container. In both cases MT5 logged its
`updating MQL5 folder / 453 files updated` line and proceeded
to the broker login dialog without ever launching the service.
`MQL5/logs/` stayed empty; `services.ini` was on disk; the
registry had `Services\SlotService` — none of it was enough.

This is a documented MT5 behaviour, not a slot bug: the
"Services" tab list lives in a binary cache file inside the
per-install hash dir and is only populated by the GUI's
right-click → Add Service. The next patch will need one of:
  - a small chart-indicator that calls MT5 internal APIs to
    register + start the service on its first tick, and a
    chart template that auto-attaches it to a hidden chart
  - a Wine-side "fake GUI" that drives the right-click via
    `SendMessage` to the running terminal64.exe window
  - a one-time `wine reg add` driven by a `s6-rc oneshot`
    that runs AFTER svc-de has confirmed openbox is up, and
    adds a registry key whose value (yet to be determined)
    makes MT5 launch services without the manual ack

The first option is the cleanest but needs metaeditor64
running with xvfb to compile — the build stage already has
xvfb installed (line 14-18 of the Dockerfile) but the compile
target for the indicator has not been written yet.

## Files in this handoff

- `docs/sessions/2026-07-22-slot-service-v52-handoff.md` — this file
- `Dockerfile` — paths, [Experts] upsert, registry stamp (commit 6b61ac3)
- `docker-compose.yml` — image tag bumped v51 → v52 (commit 6b61ac3)
- Image `ghcr.io/alxvarp/akroncloud-slot:0.3.0-tcp-bridge-v52` —
  pushed by the chat. Built from 6b61ac3, sha256:c14adc98d9d34fb63…

## What is NOT in v52

- Bridge-adapter (the legacy `MQL5/Files/` → ZMQ watcher) is
  still copied and started, even though `SLOT_BRIDGE=tcp`
  means the slot does not consume its ZMQ output. The
  bridge-adapter still watches `users/abc/.../MQL5/Files/`
  (wrong path; should be `Program Files/.../MQL5/Files/` if
  the slot ever flipped to `SLOT_BRIDGE=file`). Leaving it
  alone for now; cleanup is a separate PR.
- The user-space `users/abc/MetaTrader 5/` install is still
  populated by the akron-mt5-base image (it's the install the
  old `/Metatrader/start.sh` uses). The slot never launches
  that binary, so it's dead weight but harmless.
- The chart-indicator (R2) fallback path. We removed it in
  a606493 in favour of the service. If the service path is
  unrecoverable, the chart-indicator path can be reinstated
  by reverting a606493 + 0499462 and restoring the
  chart-template generator script.
