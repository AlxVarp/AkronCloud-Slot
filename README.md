# AkronCloud-Slot

Pure REST + WebSocket trading service. Runs on every tenant VPS, connects to the broker (Deriv MVP), maintains an internal ledger, and exposes a unified trading interface to the AkronCloud cerebro.

There is **no web UI, no login page, no visual layer**. Auth is a short-lived JWT signed by the AkronCloud cerebro. The only entry point is the REST + WS API.

## What this is

When a community admin finishes their `/onboarding` wizard on the AkronCloud panel, the `AkronCloud-Node/bootstrap.sh` they run on their VPS:

1. Pulls the `akroncloud-slot:<tag>` Docker image from `ghcr.io/alxvarp/`.
2. Runs the image with `.env` vars wired (broker credentials, JWT secret, etc.).
3. The slot connects to the broker, seeds its SQLite ledger, exposes the API at `127.0.0.1:7777`.
4. The cerebro (in `AkronCloud`) reaches the slot through NetBird at `<slot-peer-name>:7777`.

From there, **all** the trading surface (signals, copy, analytics, risk controls, notifications) consumes this slot's API. No module talks to the broker directly.

## Repo layout

```
SPEC.md                      ← API contract (the canonical source of truth)
README.md                    ← this file
LICENSE                      ← MIT
Dockerfile                    ← scaffolded, real impl in follow-up PRs
package.json                  ← @akroncloud/slot-service, deps, scripts
tsconfig.json
docs/
  CONNECTORS.md              ← how to add a broker connector (placeholder)
src/
  server.ts                   ← entry point (scaffolded)
  api/
    rest.ts                   ← scaffolded
    ws.ts                     ← scaffolded
  ledger.ts                   ← scaffolded
  reconciler.ts               ← scaffolded
  risk.ts                     ← scaffolded
  auth.ts                     ← scaffolded
  connectors/
    base.ts                   ← scaffolded
    deriv.ts                  ← scaffolded (MVP)
  db/
    schema.ts                 ← Drizzle schema
    migrations/               ← forward-only SQL migrations
scripts/                      ← ops scripts (placeholder)
```

## Reading order

1. `SPEC.md` — start here, it's the source of truth.
2. `docs/CONNECTORS.md` — when adding a new broker.

## Companion repos

- [`AkronCloud`](https://github.com/AlxVarp/AkronCloud) — the platform monorepo (Vercel panel + cerebro orchestrator + Supabase schema). The cerebro consumes this service.
- [`AkronCloud-Node`](https://github.com/AlxVarp/AkronCloud-Node) — the tenant VPS bootstrap script that pulls + runs this Docker image.

## Status

Scaffolded. The architecture, API surface, data model, connector interface, and auth flow are documented in `SPEC.md`. Implementation (real `src/server.ts`, real `src/connectors/deriv.ts`, real DB migrations) lands in follow-up PRs once the AkronCloud cerebro's auth + slot-registration endpoints exist.

## Building locally

(placeholder — see SPEC § 8 once implementation starts)

## License

MIT. See `LICENSE`.
