# AkronCloud-Slot

Slot-as-a-Service: a single container that runs MT5 and exposes a unified
broker-agnostic REST + WebSocket API to the AkronCloud cerebro (or any
caller). One slot = one broker account. JWT-authenticated (HS256).
Credentials are AES-256-GCM encrypted at rest.

There is **no web UI, no login page, no visual layer**. The only entry
point is the REST + WS API.

## What this is

A Node.js service that wraps a running MT5 terminal. The container
embeds the MT5 runtime (FROM `ghcr.io/alxvarp/akron-mt5-base:mt5-preinstalled`),
runs a Fastify server on top, and the two communicate via a local ZMQ
pair — no network exposure.

The slot accepts credentials from **any broker that accepts the MT5
protocol** (Deriv MT5, IC Markets, Pepperstone, Exness, FXTM, etc.),
encrypts them at rest, and starts a session. From there, callers can
place orders, fetch positions, subscribe to fills over WS, etc. No
module talks to the broker directly — they all go through this slot.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  container: akroncloud-slot                     │
│                                                 │
│   ┌─────────────────┐     ┌────────────────┐    │
│   │  MT5 terminal   │ ZMQ │  Node.js       │    │
│   │  (Wine)         │◀───▶│  Fastify       │    │
│   │  PublisherZMQ   │     │  + WS          │    │
│   │  + bridge       │     │                │    │
│   └─────────────────┘     │  /v1/* REST    │    │
│                           │  /v1/stream WS │    │
│   sqlite: /var/lib/       │                │    │
│   akron-slot/state.db     └────────────────┘    │
│                                                 │
│  listen: 127.0.0.1:7777                          │
└─────────────────────────────────────────────────┘
```

## Repo layout

```
SPEC.md                      ← API contract (the canonical source of truth)
README.md                    ← this file
LICENSE                      ← MIT
package.json                 ← @akroncloud/slot-service
tsconfig.json
.dockerignore
.env.example
Dockerfile
vitest.config.ts
docs/
  CONNECTORS.md              ← how to add a broker connector
src/
  server.ts                  ← Fastify boot + env loading + migration runner
  auth.ts                    ← HS256 JWT validator + scope check
  crypto.ts                  ← AES-256-GCM + HKDF per-tenant key derivation
  log.ts                     ← pino logger wrapper
  error.ts                   ← Problem+JSON (RFC 7807) helpers
  problem.ts                 ← typed problem-shape used by REST + WS errors

  api/
    rest.ts                  ← /v1/* routes (Fastify router plugin)
    ws.ts                    ← /v1/stream upgrade + channel subscription

  db/
    schema.ts                ← Drizzle schema (accounts, orders, fills, migrations)
    migrate.ts               ← forward-only SQL migration runner
    migrations/
      0001_init.sql          ← initial schema

  connectors/
    base.ts                  ← BrokerConnector interface + types
    mt5.ts                   ← ZMQ impl talking to the embedded MT5 runtime
    index.ts                 ← registry: id → connector factory

  validator.ts               ← async broker-credential validation worker
  risk.ts                    ← pre-trade risk gate (reads SLOT_RISK_LIMITS_JSON)
  ledger.ts                  ← orders/fills persistence + positions view
  reconciler.ts              ← ledger ↔ broker sync (Phase B)

scripts/
  dev-token.ts               ← mints a dev JWT (npm run dev:token)
  rotate-secret.ts           ← key-rotation helper (Phase B)

tests/
  crypto.test.ts
  auth.test.ts
  schema.test.ts
  migrate.test.ts
  rest.test.ts
  dev-token.test.ts
```

## Reading order

1. `SPEC.md` — start here, it's the source of truth.
2. `docs/CONNECTORS.md` — when adding a new broker.

## Companion repos

- [`AkronCloud`](https://github.com/AlxVarp/AkronCloud) — the platform monorepo (panel + cerebro + Supabase schema). The cerebro consumes this service.
- [`AkronCloud-Node`](https://github.com/AlxVarp/AkronCloud-Node) — the tenant VPS bootstrap script that pulls + runs this image.
- (legacy) [`Akron`](https://github.com/AlxVarp/Akron) — retired 2026-06-29. The MT5 base layer (`ghcr.io/alxvarp/akron-mt5-base`) it maintained is still pulled here as the base image.

## Status

Phase A scaffold. The first commits land:

1. `docs(spec): MT5 broker-agnostic Phase A architecture`
2. `docs(readme): reflect new architecture`
3. `chore(env): .env.example with SLOT_* vars`
4. `feat(crypto): AES-256-GCM + HKDF` + tests
5. `feat(db): Drizzle schema + first migration` + tests
6. `feat(auth): HS256 JWT validator + dev-token CLI` + tests
7. `feat(server): Fastify bootstrap`
8. `feat(api): REST routes + Problem+JSON errors`
9. `feat(api): WS upgrade skeleton`
10. `feat(connectors): BrokerConnector interface`
11. `chore(stub): validator/risk/ledger/reconciler skeletons (Phase B fill-in)`
12. `chore(docker): Dockerfile`

## Building & running locally

```sh
# 1. install
npm install

# 2. env
cp .env.example .env
# Edit .env and put real SLOT_JWT_SECRET + SLOT_ENCRYPTION_KEY.

# 3. run migrations + dev server
npm run dev

# 4. health check
curl http://127.0.0.1:7777/v1/health
# → {"status":"ok","uptime_s":42,"version":"0.2.0"}

# 5. mint a dev JWT
npm run -s dev:token

# 6. provision a broker account
TOKEN=$(npm run -s dev:token)
curl -X POST http://127.0.0.1:7777/v1/accounts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"broker_server":"ICMarkets-Demo","broker_login":"12345","broker_password":"xxx"}'

# 7. read it back
curl http://127.0.0.1:7777/v1/accounts/<id> \
  -H "Authorization: Bearer $TOKEN"
```

The MT5 broker-credentials validation worker (`src/validator.ts`) is a
Phase B task. In Phase A the row is created in `pending_validation`
status and async validation comes later.

## License

MIT. See `LICENSE`.
