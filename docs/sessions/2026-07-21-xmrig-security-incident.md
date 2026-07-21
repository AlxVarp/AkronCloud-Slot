# Security incident — xmrig Monero miner in `akron-mt5-base` (2026-07-21)

While validating the v33 mobile build end-to-end with the
credential fill flow, a screenshot of the container
framebuffer showed up a background `xterm` window with
crypto-miner output (`cpu accepted (10/0) diff`, `net new job
from`, `H/s`).

## 1. What it was

Process tree at first observation:

```
PID 1820  /usr/bin/xterm                                  (KasmVNC desktop)
  PID 1825  bash  (interactive)                           (pts/0)
    PID 1839  sh -s pool.hashvault.pro:443 82YVC525...    (downloader)
      PID 1917  ./xmrigARM --donate-level=2 -t 8           (THE MINER)
```

xmrig Monero RandomX miner, 8 threads, ~764% CPU. Wallet
`82YVC525F1kCvfmyUWZ6mdeRuNT7DRV9TPkTF1cEKmu5Hp1kjstTJjEjFApSQkG5whVtqEwTBNsnBeWJvuFVktiwJwnHYBW`.

Binaries at `/config/xmrig` (shell wrapper, 663 B) and
`/config/xmrigARM` (2.3 MB, dated 2022-11-21, predates the
akron-mt5-base image build on 2026-07-13).

## 2. Vector

KasmVNC was published as `0.0.0.0:3000:3000` in
`docker-compose.yml` with `-disableBasicAuth -SecurityTypes
None`. Anyone on the public internet could reach
`http://45.151.122.104:3000/`, get the openbox desktop,
right-click → Terminal, and run a one-liner that
downloads + executes `xmrig`. The `abc` user identity
under which the miner ran was just the Wine-mapped UID,
no real distinction from a regular install.

## 3. Containment steps applied

| Step | Commit | What |
|---|---|---|
| 1 | (runtime) | `pkill -9 xmrigARM` inside the container. Process kept the slot alive but became zombie `<defunct>` and stopped consuming CPU. |
| 2 | `adeed94` | `docker-compose.yml`: changed port `0.0.0.0:3000:3000` to `127.0.0.1:3000:3000`. The slot still uses port 3000 internally via the same-container `mt5-ws-proxy.ts -> ws://127.0.0.1:3000/websockify`. To reach the desktop now, tunnel: `ssh -L 3000:127.0.0.1:3000 vps`. |
| 3 | (runtime) | `docker compose up -d` recreated the container. `/config/` is ephemeral on this compose (not in `volumes:`), so the miner binaries were wiped along with the union FS. |
| 4 | `39dd269` (v34) | `Dockerfile`: added s6 service `svc-sanitize` that runs once per container boot. It removes any preinstalled xmrig binaries from `/config`, `/home/kasm-user`, and `/tmp`, and restores the openbox `autostart` from `/defaults/autostart` if it diverges from our legitimate MT5 launcher. Log: `/var/log/sanitize.log` inside the container. |

## 4. Verification

```
=== health ===
{"status":"ok","connector":"mt5","uptime_s":13}

=== svc-sanitize logs ===
[2026-07-21T19:14:03+00:00] scanning /config for miner binaries
[2026-07-21T19:14:03+00:00] done         <-- no miner found, sweep clean

=== miner reappeared? ===
(nothing)                              <-- nothing matches xmrig*

=== port 3000 still locked ===
host:3000 -> 000 (Connection refused)
```

## 5. Remaining risk and recommendations

The binaries in `/config/xmrig*` were dated **2022-11-21**
— far older than the akron-mt5-base build (8 days ago at the
time of incident). Either:

  (a) The akron-mt5-base image has its own compromised layer
      that adds them, OR
  (b) Some earlier systemd/s6 service in the image fetched
      them during build and they persisted in `/config/`.

We didn't have access to the upstream repo to rebuild. Until
the akron-mt5-base image is rewritten from a clean
Dockerfile (and ideally rebuilt from scratch, not from a
`docker load`'d archive whose provenance is unknown),
`svc-sanitize` is the floor. Recommended hardening on top of
that, when access to the upstream is available:

  1. Rebuild `akron-mt5-base` with a known-clean Dockerfile
     and push to GHCR with a reproducible build.
  2. Sign the image with `cosign` and verify on pull.
  3. Bind `:3000` to `127.0.0.1` permanently in the base
     Dockerfile (rather than rely on a downstream compose
     override), OR remove KasmVNC entirely if the cerebro
     doesn't need it.

## 6. Operational notes

- `/config` is **not** in `volumes:` in `docker-compose.yml`.
  The slot-state volume is `slot-state:/var/lib/akron-slot`
  only. So `/config/xmrig*` cannot persist across
  `docker compose up -d` recreates — important property
  that makes the containment durable.
- If you ever need to access the KasmVNC desktop for
  debugging (and don't want to push port 3000 back to
  public): `ssh -L 3000:127.0.0.1:3000 vps` then open
  `http://localhost:3000` in your local browser.
- The miner had been running for at least 106 minutes at
  observation time, suggesting this exposure was open for
  some time before we noticed. There is no audit log of
  earlier connections; the only evidence is the wallet
  payouts on the Monero blockchain (publicly queryable by
  the hashvault pool + wallet address above).
