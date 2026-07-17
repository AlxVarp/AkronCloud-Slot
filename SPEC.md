# AkronCloud-Slot — Slot Service Specification (Phase A)

> **Source of truth** for the slot-service component. Update on every
> commit that changes the API contract. Pares to `AkronCloud/SPEC.md § 16
> (Slot-as-a-Service)`, which explains **why** this exists; this doc
> explains **how** it works in its current scope (Phase A — see
> § "Phase scope" below).

---

## Phase scope

**Phase A** (this iteration): one container, MT5 + broker-agnostic REST
+ WebSocket API. Auth via short-lived JWT (HS256), issuer is the local
slot itself for dev (the cerebro in `AkronCloud` will mint dev/compat
tokens; production signing is later). Local SQLite ledger. Crypto
encryption of broker credentials at rest.

**Out of Phase A** (later phases):
- Multi-broker aggregation across containers (Phase B).
- Order routing across accounts (Phase B).
- The `AkronCloud` cerebro adopting this protocol (Phase C).
- Replacing the embedded Wine + MT5 with a remote MetaAPI connector (post-MVP).

The slot's container image is built FROM
`ghcr.io/alxvarp/akron-mt5-base:mt5-preinstalled` (the existing MT5
runtime image) and adds Node.js + Fastify on top — same process tree,
no ZMQ-over-network between services.

---

## 1. What this is

The slot service is a single container that:

- Connects to **one** broker account via a pluggable `BrokerConnector`.
- Maintains an **internal ledger** (truth source for that slot's
  orders, fills, positions), persisted in a local SQLite file so the
  slot survives restarts.
- Exposes a **unified trading API** over REST + WebSocket.
- Authenticates callers via short-lived JWTs (HS256).

The container has **no public-facing surface** — no DNS, no TLS cert,
no port forwarding. It listens on the host's loopback by default
(`127.0.0.1:7777`); bind to the LAN only when the host is reachable
through a private mesh (NetBird, Tailscale, etc.). The cerebro
(`AkronCloud/apps/orchestrator`) consumes the slot's API from inside the
mesh.

There is **no web UI.** No login page. No visual. The only entry point
is the REST/WS API authenticated by a short-lived JWT. In Phase A the
slot itself mints dev tokens via `npm run dev:token`; in Phase C the
cerebro mints production tokens against the slot's shared secret.

The slot connects to **any broker that accepts the MT5 protocol**:
Deriv MT5, IC Markets, Pepperstone, Exness, RoboForex, FXTM, etc.
Credentials are broker-supplied `login` / `password` / `server`. The
same connector handles all of them; only the credential set changes.

---

## 2. API surface

### 2.1 REST (Fastify)

| Method | Path                    | Description                                              | Auth |
|--------|-------------------------|----------------------------------------------------------|------|
| GET    | `/v1/health`            | Liveness probe (no broker checks).                       | none |
| GET    | `/v1/state`             | Full slot state: connection status, uptime, last fill ts, ledger drift. | JWT |
| GET    | `/v1/balance`           | Account balances per currency.                           | JWT |
| GET    | `/v1/positions`         | Open positions with last mark price.                     | JWT |
| POST   | `/v1/orders`            | Place / close / modify an order.                         | JWT |
| GET    | `/v1/orders/:id`        | Get one order by id.                                     | JWT |
| GET    | `/v1/fills?from=&to=`   | Recent fills in range.                                   | JWT |
| GET    | `/v1/pnl?range=`        | Realized + unrealized P&L over 1d / 7d / 30d / custom.   | JWT |
| GET    | `/v1/stream`            | Upgrade to WebSocket (see § 2.2).                        | JWT |
| POST   | `/v1/accounts`          | Provision / rotate the broker account on this slot.      | JWT (slot:write) |
| GET    | `/v1/accounts/:id`      | Read account status (`pending_validation`, `active`, `error`). | JWT |

All paths return JSON. Errors are RFC 7807 (`Problem+JSON`).

### 2.2 WebSocket streams (`GET /v1/stream` upgrades to `101 Switching Protocols`)

Authenticated once at handshake (JWT in `Authorization: Bearer …`
header — the server upgrades only after validating the header). After
upgrade, client sends `subscribe` / `unsubscribe` / `ping` messages:

```jsonc
// client → server
{ "type": "subscribe",   "channel": "fills" }
{ "type": "subscribe",   "channel": "quotes",  "symbol": "EURUSD" }
{ "type": "unsubscribe", "channel": "quotes",  "symbol": "EURUSD" }
{ "type": "ping" }

// server → client
{ "type": "event",  "channel": "fills",  "data": { /* fill object */ } }
{ "type": "event",  "channel": "quotes", "data": { "symbol": "EURUSD", "ts": 1234, "bid": 1.083, "ask": 1.085 } }
{ "type": "pong" }
{ "type": "heartbeat", "ts": 1234567890 }
{ "type": "error",    "code": "BAD_CHANNEL", "message": "..." }
```

Channels: `fills` (order executions), `orders` (state transitions),
`quotes:<SYMBOL>` (top-of-book ticks), `account` (broker-side events),
`heartbeats` (server-emitted `type: heartbeat` every 30 s). Auth
header is required for the upgrade; the channel subscribe frames are
plain JSON after upgrade.

### 2.3 Auth

The slot validates HS256-signed JWTs against
`SLOT_JWT_SECRET`. In Phase A the slot also mints dev tokens for
`curl`-driven testing; the mint utility is `scripts/dev-token.ts`
(`npm run dev:token`) and writes the token to stdout.

JWT claims:

| Claim    | Meaning                                                       |
|----------|---------------------------------------------------------------|
| `sub`    | Service name (e.g., `cerebro` or `dev`).                      |
| `tenant_id` | Tenant this slot is provisioned for. Always required.       |
| `slot_id`   | Unique id of this slot (fixed per container, set in env).   |
| `exp`    | Expiry in Unix epoch seconds. **Max 1 hour** in Phase A.      |
| `scope`  | Array of permission strings (see § 2.4).                     |

The slot rejects:
- `exp` in the past.
- Unknown `tenant_id` (Phase C: must be in `tenants` registry; Phase A: must match `SLOT_TENANT_ID` env var).
- A `scope` that doesn't include the requested operation.
- Signature that doesn't verify under `SLOT_JWT_SECRET`.

### 2.4 Scope strings

- `slot:read` — read endpoints (`/v1/state`, `/v1/balance`, `/v1/positions`, `/v1/orders/:id`, `/v1/fills`, `/v1/pnl`, `/v1/accounts/:id`).
- `slot:write` — write endpoints (`/v1/orders`, `/v1/accounts`).
- `slot:stream` — WS upgrade.

A full-access dev token includes `["slot:read","slot:write","slot:stream"]`.

### 2.5 Error codes

| HTTP | Code             | Meaning                                                   |
|------|------------------|-----------------------------------------------------------|
| 400  | `BAD_REQUEST`    | Schema validation failed (`zod`).                         |
| 401  | `UNAUTHENTICATED`| Missing / bad JWT.                                        |
| 403  | `FORBIDDEN`      | JWT present but `scope` doesn't permit.                   |
| 404  | `NOT_FOUND`      | Order / position / account not found.                     |
| 409  | `RISK_BLOCKED`   | Pre-trade risk rejected the order.                        |
| 502  | `BROKER_DOWN`    | Connector can't reach broker.                             |
| 503  | `RECONCILING`    | Ledger out of sync with broker; orders paused.            |

---

## 3. Data model (local SQLite)

The slot persists its own state in a local SQLite file
(`/var/lib/akron-slot/state.db` by default, configurable via
`SLOT_STATE_DB`). Survives restarts.

ORM: Drizzle. Forward-only migrations in `src/db/migrations/`.

Tables (Phase A):

- **`accounts`** — one row per broker connection.
  - `id uuid PRIMARY KEY`
  - `tenant_id text NOT NULL`
  - `slot_id text NOT NULL`
  - `broker text NOT NULL` (constant `'mt5'` in Phase A)
  - `broker_server text NOT NULL`
  - `broker_login text NOT NULL`
  - `encrypted_creds blob NOT NULL` — AES-256-GCM ciphertext of the broker password (see § 4.3).
  - `status text NOT NULL` — `pending_validation` | `validating` | `active` | `error` | `disabled`.
  - `last_validation_ts integer`
  - `last_error text`
  - `created_at integer NOT NULL` (Unix epoch ms)
  - `updated_at integer NOT NULL`

- **`orders`** — every order ever placed on this account.
  - `id uuid PRIMARY KEY`
  - `account_id uuid NOT NULL REFERENCES accounts(id)`
  - `instrument text NOT NULL`
  - `side text NOT NULL` (`buy` | `sell`)
  - `qty numeric NOT NULL`
  - `type text NOT NULL` (`market` | `limit` | `stop`)
  - `price numeric`, `sl numeric`, `tp numeric`, `reduce_qty numeric`
  - `status text NOT NULL` (`pending` | `filled` | `cancelled` | `rejected`)
  - `broker_order_id text`
  - `ts_open integer`, `ts_close integer`

- **`fills`** — every fill on this account.
  - `id uuid PRIMARY KEY`
  - `order_id uuid REFERENCES orders(id)`
  - `account_id uuid NOT NULL`
  - `instrument text NOT NULL`
  - `qty numeric NOT NULL`
  - `price numeric NOT NULL`
  - `fee numeric`
  - `ts integer NOT NULL`

- **`positions`** — **derived view**, recomputed from `orders` + `fills`
  on every read. Not a persisted table.

- **`reconcile_log`** (Phase A: nullable, Phase B: populated by reconciler).
- **`risk_limits`** — risk engine config. Phase A: seeded from env. Phase C: updated via `PATCH` from cerebro.

### 3.1 Indexes

- `accounts (tenant_id)`, `accounts (status)`.
- `orders (account_id, ts_open)`, `orders (status)`, `orders (broker_order_id)`.
- `fills (account_id, ts)`.

### 3.2 Migrations

Forward-only SQL in `src/db/migrations/`. Migration runner in
`src/db/migrate.ts` applies unapplied files in lexicographic order and
records each in `_migrations (name text PRIMARY KEY, applied_at integer)`.
The server runs migrations on boot.

---

## 4. Broker connector

### 4.1 Interface

```ts
export interface BrokerConnector {
  readonly id: 'mt5';
  readonly displayName: string;

  /** Open a session with the broker. Returns when the connector is ready. */
  connect(creds: BrokerCreds): Promise<{ accountRef: string }>;

  /** Tear down the session. Idempotent. */
  disconnect(accountRef: string): Promise<void>;

  /** Snapshot of current state for an account. */
  state(accountRef: string): Promise<AccountState>;

  /** Available symbols and their filters. */
  symbols(accountRef: string): Promise<SymbolSpec[]>;

  /** Top-of-book quote for a symbol. */
  quote(accountRef: string, symbol: string): Promise<Quote>;

  /** Currently open positions. */
  positions(accountRef: string): Promise<Position[]>;

  /** Place / close / modify an order. */
  openTrade(accountRef: string, order: NewOrder): Promise<OrderResult>;
  closeTrade(accountRef: string, positionId: string, qty?: number): Promise<OrderResult>;

  /** Stream of broker events (fills, order transitions, account events). */
  stream(accountRef: string, signal: AbortSignal): AsyncIterable<BrokerEvent>;
}
```

### 4.2 Types

```ts
export type BrokerCreds = {
  server: string;
  login: string;
  password: string; // plaintext in memory; only ciphertext is persisted.
};

export type Quote = { symbol: string; bid: number; ask: number; ts: number };

export type Position = {
  id: string;
  account_id: string;
  instrument: string;
  side: 'long' | 'short';
  qty: number;
  avg_price: number;
  mark_price?: number;
  unrealized_pnl?: number;
};

export type NewOrder = {
  instrument: string;
  side: 'buy' | 'sell';
  qty: number;
  type: 'market' | 'limit' | 'stop';
  price?: number;
  sl?: number;
  tp?: number;
  reduce_qty?: number;
};

export type OrderResult =
  | { ok: true; order_id: string; broker_order_id: string }
  | { ok: false; reason: string };

export type BrokerEvent =
  | { kind: 'fill'; data: Fill }
  | { kind: 'order_state'; data: { order_id: string; status: OrderStatus } }
  | { kind: 'account'; data: AccountEvent };

export type OrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected';
```

### 4.3 Credential handling

- **In memory**: the connector takes `password` as plaintext. The slot
  constructs it after decryption (§ 6) when opening the session.
- **On disk**: only the ciphertext (`encrypted_creds`), AES-256-GCM,
  per-tenant key derived from `SLOT_ENCRYPTION_KEY` via HKDF-SHA256
  using `tenant_id` as the salt. No plaintext ever written.
- **Zeroing**: callers MUST zero out plaintext buffers after use
  (`Buffer.fill(0)`). The connector does this in its own scope; the
  slot does the same in the validate-and-save path.

### 4.4 Initial connectors (Phase A)

- **`mt5`** — talks to the embedded MT5 terminal via ZMQ subscriber to
  `PublisherZMQEvents.mq5` and ZMQ publisher for outbound commands
  (placed orders, etc). Implemented in `src/connectors/mt5.ts`. Drives
  the `akron-mt5-base` runtime inside the same container. **No external
  Python SDK.** No Wine-proc inside the Node.js process; we use the same
  inter-process ZMQ pair the existing `mt5copy_bridge_win.py` uses,
  but with Node.js bindings (`zeromq`).

### 4.5 Future connectors (post-Phase A)

- **`ibkr`** — Interactive Brokers TWS API.
- **`alpaca`** — REST.
- **`metatrader_remote`** — MetaAPI as a remote connector (last-resort, paid).

Adding a new connector = implement `BrokerConnector` + register in
`src/connectors/index.ts`. See `docs/CONNECTORS.md`.

---

## 5. Risk engine (pre-trade)

Reads `risk_limits` (Phase A: from `SLOT_RISK_LIMITS_JSON` env var on boot;
Phase C: from a `risk_limits` row updated by cerebro via a registered
caller).

Phase A limits:

| Field                     | Meaning                                         |
|---------------------------|-------------------------------------------------|
| `max_position_size`       | Per-instrument max notional.                    |
| `max_daily_loss_pct`      | Max fraction of allocated balance per day.      |
| `kill_switch_active`      | When true, reject all orders with `409 RISK_BLOCKED`. |

On reject, the slot returns `409 RISK_BLOCKED` with details (which rule
fired + current values vs limits), and writes the attempt to the
`reconcile_log` (Phase B). Phase A: just the response, no audit log row
yet.

---

## 6. Encryption (`src/crypto.ts`)

- Algorithm: **AES-256-GCM** (NIST-approved AEAD; nonces must be unique
  per `(tenant_id, record_id)`).
- Key: 32-byte raw key from `SLOT_ENCRYPTION_KEY` env var (base64
  encoded). For the dev default, the slot refuses to boot if it is
  unset in production builds.
- Per-tenant: the actual key used is `HKDF-SHA256(masterKey, tenant_id,
  "akroncloud-slot-v1")` → 32 bytes. **Tenant isolation at the crypto
  layer**: a leaked key for one tenant doesn't decrypt another.
- API:

```ts
encrypt(tenantId: string, plaintext: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer }
decrypt(tenantId: string, ciphertext: Buffer, iv: Buffer, tag: Buffer): Buffer
```

The `accounts.encrypted_creds` blob stores `iv ‖ ciphertext ‖ tag`
packed (32-byte header for `iv`, then ciphertext, then 16-byte tag).

---

## 7. Reconciler

Phase A: stub. Phase B: cron job every `SLOT_RECONCILE_INTERVAL_MS`
(default 30 000) syncs ledger ↔ broker:

1. Pulls positions from broker via the connector.
2. Compares to local `positions` (derived view).
3. On drift > 0.1 lot OR price > 0.5 %, emits a `reconcile_alert`
   event over WS + writes a row to `reconcile_log`.
4. On drift > 1 lot OR broker rejection → `accounts.status='error'` and
   reject further orders with `503 RECONCILING`.

---

## 8. Deployment

### 8.1 Image

- **Phase A base**: built FROM
  `ghcr.io/alxvarp/akron-mt5-base:mt5-preinstalled` (the existing MT5
  runtime image).
- **Layered on top**: Node.js 20, the slot source, the migration runner.
- **Registry target**: `ghcr.io/alxvarp/akroncloud-slot:<semver>`.
- **Run**: a single `docker run` with the env vars in § 8.2 below.
  Inside, `start.sh` (from the akron-mt5-base layer) brings up MT5 +
  the slot Node.js process. They communicate via local ZMQ
  (`tcp://127.0.0.1:5555`) — no network exposure.

### 8.2 Environment variables

All env vars driven by `--env-file` or the orchestrator. None are
embedded in any image.

| Variable                       | Required | Meaning                                                   |
|--------------------------------|----------|-----------------------------------------------------------|
| `SLOT_TENANT_ID`               | yes      | Tenant that owns this slot (UUID-as-string).              |
| `SLOT_SLOT_ID`                 | yes      | Unique id of this slot (UUID-as-string).                  |
| `SLOT_JWT_SECRET`              | yes      | HS256 secret to validate inbound JWTs. 32+ bytes.        |
| `SLOT_ENCRYPTION_KEY`          | yes      | Base64 of 32 raw bytes. Master key for § 6 HKDF.          |
| `SLOT_BIND`                    | no       | Default `127.0.0.1`. Bind address for Fastify.            |
| `SLOT_PORT`                    | no       | Default `7777`. HTTP + WS port.                           |
| `SLOT_STATE_DB`                | no       | Default `/var/lib/akron-slot/state.db`.                   |
| `SLOT_LOG_LEVEL`               | no       | Default `info` (`trace`/`debug`/`info`/`warn`/`error`).   |
| `SLOT_RECONCILE_INTERVAL_MS`   | no       | Default `30000`.                                          |
| `SLOT_MT5_ZMQ_HOST`            | no       | Default `127.0.0.1`. MT5 ZMQ bridge host.                 |
| `SLOT_MT5_ZMQ_IN_PORT`         | no       | Default `5555`. Subscription port for broker events.      |
| `SLOT_MT5_ZMQ_OUT_PORT`        | no       | Default `5556`. Publish port for outbound commands.       |
| `SLOT_RISK_LIMITS_JSON`        | no       | Default `{"max_position_size":0,"max_daily_loss_pct":100,"kill_switch_active":false}`. JSON-encoded `RiskLimits` (§ 5). |

`SLOT_JWT_SECRET` and `SLOT_ENCRYPTION_KEY` are **mandatory**. The
slot refuses to boot if either is missing or
`< 32 bytes after decoding`.

### 8.3 Build & release

- Tag a release (`vX.Y.Z`) → GitHub Actions build:
  - Lint + typecheck + tests.
  - `docker build` and push to GHCR.
- The bootstrap image name is a build arg
  `BASE_IMAGE=ghcr.io/alxvarp/akron-mt5-base:mt5-preinstalled`, default
  for release builds; overridable for staging.

---

## 9. Failure modes

| Failure                          | Slot behavior (Phase A) |
|----------------------------------|-------------------------|
| Broker MT5 unreachable           | `validate` returns `BROKER_DOWN`; `accounts.status='error'`; `GET /v1/state` exposes it. |
| Slot crash                       | On restart: reload SQLite. Reconciler (Phase B) syncs any missed broker events. |
| JWT secret rotated mid-flight    | All in-flight tokens fail at next request → 401. Clients must re-acquire. |
| Encryption key rotated           | `decrypt` of old blobs fails. Account goes to `error`; admin must re-issue via `POST /v1/accounts`. |
| ZMQ bridge down                  | Connector falls back to throw on next request; WS heartbeats show degraded `state.connector`. (Phase B: reconnect with backoff.) |
| Out-of-memory                    | OS OOM kill; pod restarts; same as "slot crash". |

---

## 10. Out of scope (still)

- **Public-facing API** at `localhost:7777`. The slot has no DNS, no
  TLS, no port forwarding. Public endpoints live in `AkronCloud`.
- **Cross-broker aggregation**. Each slot handles one broker account.
  Aggregation across brokers is done at the cerebro level (Phase C).
- **Order routing across accounts**. Per-tenant routing logic lives in
  `AkronCloud/apps/orchestrator`.
- **Smart order routing (SOR) / "best execution"**. Not in MVP.
- **UI / web frontend**. There is no UI. The cerebro + panel are the
  only human-facing layers.

---

## 11. Versioning + release

This repo uses semver on `package.json`. A release tag (`v0.2.0`)
triggers `release-akroncloud-slot.yml` to build + push
`ghcr.io/alxvarp/akroncloud-slot:0.2.0`.

`AkronCloud-Node/bootstrap.sh` falls back to `:latest` by default and
accepts `--registry=<image>:<tag>`.

Per the grandparent SPEC `AkronCloud/SPEC.md § 16 (Slot-as-a-Service)`.
Major bumps require coordinated updates in `AkronCloud-Node`'s default
registry tag.

---

## 12. Reading order for a new contributor

1. This file.
2. `src/server.ts` — Fastify bootstrap, env loading, migration runner,
   route mount.
3. `src/auth.ts` — JWT validator + scope check, dev-token signer.
4. `src/crypto.ts` — AES-256-GCM with HKDF per-tenant derivation.
5. `src/db/schema.ts` — Drizzle schema for `accounts`/`orders`/`fills`.
6. `src/api/rest.ts` — `/v1/health`, `/v1/accounts`, others.
7. `src/api/ws.ts` — `/v1/stream` upgrade + channel subscription.
8. `src/connectors/base.ts` — `BrokerConnector` interface.
9. `src/connectors/mt5.ts` — MT5 ZMQ bridge impl (Phase B).
10. `src/validator.ts` — async broker-credential validation worker.
11. `src/risk.ts`, `src/ledger.ts`, `src/reconciler.ts` — risk limits,
    fills/positions derivation, ledger-broker reconciliation.
12. `tests/` — vitest unit tests for auth, crypto, schema, REST.
13. `docs/CONNECTORS.md` — how to add another broker.
