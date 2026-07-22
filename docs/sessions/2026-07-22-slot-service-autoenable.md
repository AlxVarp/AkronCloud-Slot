# SlotService auto-enable + broker login (2026-07-22)

> Continuation of the v51 mobile-wrapper session. The
> previous chat ended with the user manually logging into
> Deriv broker in MT5 but the slot's `loggedIn: false` because
> the SlotService.ex5 (the MQL5 service that publishes
> account_status back to the slot over TCP 7778) was not
> running. The user wants the slot to come up ready: open MT5,
> have the broker dialog auto-fill from slot's saved creds,
> press OK, click Sync → done. No "Tools → Options → Allow
> Services" step.

## 1. Current state (v51)

- Slot deployed at `0.3.0-tcp-bridge-v51` (da4d7dc8dcc3).
- Wrapper is single-broker single-tenant: server
  `Deriv-Server-02`, login `32324375` (saved in
  `localStorage['akron.creds.v1']` on the celu browser).
- Mobile wrapper: full scancode path for every key (v46-v50);
  Shift sends the right-case keysym directly (XK_D for 'D'),
  no modifier tracking. The user verified this works:
  ⇧ + d now types uppercase in MT5.
- Desktop: 414x440 portrait (was 414x500), #screen bg
  softened to #0b0e14 to match the rest of the page.
- xmrig crypto miner incident (v34) and the dropped JWT
  /multi-tenant API surface (v41) are documented in
  `2026-07-21-xmrig-security-incident.md`.

## 2. The open problem

The user logged into Deriv broker manually in the MT5 desktop
(via the "Deriv.com Limited" row in the Select a Company
dialog, then OK on the login form). MT5 shows the dashboard
with a working account. **But the slot doesn't know.**

```
$ curl -sS http://45.151.122.104:7777/v1/state
{
  "ok": true,
  "account": {
    "broker_server": "Deriv-Server-02",
    "broker_login": "32324375",
    "status": "active"
  },
  "connector": {
    "accountRef": "mt5-Deriv-Server-02-32324375",
    "loggedIn": false,
    "balance": 0,
    "equity": 0
  }
}
```

The slot's `account.status = "active"` is just the local
DB record. `connector.loggedIn = false` means no MQL5 service
has published the account_status event. The slot keeps
retrying:

```
"mt5 connect: requesting broker login via TCP"
"mt5 connect timed out waiting for account_status"
"account validated"
```

… 7 times, all timed out at the 15s mark. The login command
DOES get sent to MT5 (the slot pushes the broker creds
down through the TCP bridge at 127.0.0.1:7778). MT5 receives
the creds and the SlotService.ex5 MQL5 service is supposed
to do the actual broker login and emit `account_status`. The
service is not running, so nothing comes back.

## 3. Why SlotService isn't running

The SlotService.ex5 is installed at:

```
/config/.wine/drive_c/users/abc/MetaTrader 5/MQL5/Services/SlotService.ex5
```

It needs three things to run:

1. **MT5 Tools → Options → Expert Advisors → "Allow
   algorithmic trading"** - allows scripts to run
2. **MT5 Tools → Options → Expert Advisors → "Allow Services"** -
   the specific toggle for MQL5 services (separately from
   EAs). This is OFF by default in a fresh MT5 install.
3. **The service has to be added to the "Services" tab** of
   the Navigator (Ctrl+U) and toggled to Started. The EX5
   file on disk is not enough; the user has to right-click →
   Start the service in the Navigator panel.

The user's "window shows it as logged in" - that's the
account_status that MT5 displays in its UI. The user is
right that the broker login WORKED. But the slot's
SlotService.ex5 (the MQL5 process that publishes
account_status back over TCP 7778 to the slot) is what
the slot is waiting for. That side didn't run.

## 4. The goal: zero-touch broker login from the user side

The user says:

> "el usuario solo tiene que hacer el login darle a sincronizar y
> nada más"

So the desired flow is:
1. Slot container starts → MT5 starts → SlotService.ex5
   should already be running (no manual user action in MT5
   settings)
2. User opens `/mobile` on the celu
3. Clicks **Login** → modal types broker creds into MT5's
   dialog
4. Hits **OK** (or the modal's "Fill" should also do OK)
5. MT5's broker session goes live
6. SlotService.ex5 sees the new account_status, publishes
   to TCP 7778
7. Slot's /v1/state shows `loggedIn: true`
8. User hits **Sync** → done

Steps 1, 2, 6, 7, 8 already work. The gap is at step 1:
make SlotService start automatically when MT5 starts.

## 5. Where to configure "Allow Services" + SlotService autostart

In the akron-mt5-base image, the SlotService.ex5 is already at
`MQL5/Services/SlotService.ex5`. What needs to change so it
starts automatically:

### 5a. "Allow Services" toggle

This is stored in the Wine registry at
`HKCU\Software\MetaQuotes Software\MetaTrader 5\Settings\AllowAlgoTrading`
(or similar key) plus a per-feature key for "Allow Services".
We can preset this with `wine reg add` in the Dockerfile's
build stage, OR more simply with a `regedit-style .reg` file
that we `regedit /s` on first container start.

Concretely, the registry tweak:

```reg
[HKEY_CURRENT_USER\Software\MetaQuotes Software\MetaTrader 5\Settings]
"AllowAlgoTrading"=dword:00000001
```

And there's a separate key for Services:

```reg
[HKEY_CURRENT_USER\Software\MetaQuotes Software\MetaTrader 5\Settings\Services]
"AllowServices"=dword:00000001
```

(In a fresh MT5 install, both default to 0.)

The container already has `users.reg` and `system.reg`
under `/config/.wine/`. Since `/config` is the persistent
volume and the Wine registry lives there, we can write the
keys to `user.reg` directly. **However**, MT5 may overwrite
or ignore keys it doesn't recognize; a more reliable path
is to use the MT5 `servers.dat` for service definitions and
the `MQL5/Services/SlotService.ex5` autostart via a config
file in the same dir.

### 5b. SlotService autostart

MT5's services can autostart via `MQL5/Services/<service>.ini`
or via `MQL5/Profiles/Default/MT5.json` under the "Services"
key. The SlotService binary is `.ex5` (compiled MQL5), so
the autostart config file is `MQL5/Services/SlotService.ini`
(if the source used INI-based config) OR it's added to the
user's services list via MT5's internal store.

Looking at what already exists in the container:
`MQL5/Services/` only has `SlotService.ex5` (no .ini). The
Services list is stored in
`AppData\Roaming\MetaQuotes\Terminal\Services\<hash>\.cache`
or similar. MT5 reads the Services list at startup from
`HKEY_CURRENT_USER\Software\MetaQuotes Software\MetaTrader 5\Services\`.

### 5c. Plan

1. Modify the slot's Dockerfile to:
   a. Add the registry patch in a build stage (so each
      fresh slot has the right values baked in). Use a
      custom `.reg` file and `wine reg` or `regedit /s`.
   b. Add a SlotService entry to the services list.
   c. OR: a `start.sh` hook that does `wine reg add` on
      first boot (idempotent), plus an MT5 service config
      bootstrap.

2. Rebuild the slot image (and the akron-mt5-base if
   possible - but we don't have access to the upstream
   repo, so the patch has to live in the slot layer).

3. Verify the user flow: open `/mobile`, click Login, type
   creds, click Save & Fill. MT5 receives creds. User
   clicks Sync. Slot gets `account_status` within 15s.
   `/v1/state` shows `loggedIn: true` with non-zero balance.

## 6. Things to be aware of for the next chat

- The user is the slot's `abc` Wine user. Wine's profile
  directory is `/config/.wine/drive_c/users/abc/`.
- The user.reg registry is at `/config/.wine/user.reg`. It
  is a standard Windows registry export format. Adding a
  section is the same as `wine reg import`.
- MT5 might require both `AllowServices` (in
  `Software\MetaQuotes Software\MetaTrader 5\Settings`) AND
  the per-service `Services` entry under
  `Software\MetaQuotes Software\MetaTrader 5\Services`.
- `MQL5/Services/` is the watched directory for autostart
  service binaries. If `SlotService.ex5` is there, MT5 picks
  it up on next startup IF services are allowed.
- The slot's wrapper DOES type characters correctly (fixed
  in v50: case-matched keysym). The modal "Reset" button
  in the topbar (v45) clears the MT5 input field via
  Ctrl+A + Delete. So if the user types wrong creds, the
  path to recovery is: tap Reset, fix the modal fields,
  hit Save & Fill again.

## 7. Test sequence for the next chat

1. Open shell on VPS:
   ```
   ssh root@45.151.122.104
   ```
2. Apply the registry patch (test a one-time run before
   baking into Dockerfile):
   ```
   docker exec akroncloud-slot sh -c "..."
   ```
3. Restart MT5 via `docker restart akroncloud-slot`.
4. Open `http://45.151.122.104:7777/mobile` on celu
5. Cick Login → modal types creds → MT5 broker dialog
6. Click **Save & Fill**
7. Click Sync
8. `curl -sS http://45.151.122.104:7777/v1/state` should
   show `"loggedIn": true` and a non-zero `"balance"`.

## 8. Tag

`ghcr.io/alxvarp/akroncloud-slot:0.3.0-tcp-bridge-v51` is
the current deployed image.
