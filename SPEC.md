# AkronCloud-Slot — Slot Service Specification

> **Source of truth** for the slot-service component. Update on every commit that changes the API contract. Pares to `AkronCloud/SPEC.md § 16 (Slot-as-a-Service)` which explains why this exists; this doc explains **how** it works.

---

## 1. What this is

The slot service runs on each tenant VPS. It:

- Connects to **one** broker via a pluggable `BrokerConnector`.
- Maintains an **internal ledger** (truth source for that slot's orders, fills, positions), persisted in a local SQLite file so the slot survives restarts.
- Exposes a **unified trading API** over REST + WebSocket.
- Authenticates callers via short-lived JWTs signed by the AkronCloud cerebro.

The cerebro (in `AkronCloud/apps/orchestrator`) talks to the slot through a NetBird peer-to-peer link. The slot has **no public-facing surface** — no DNS, no TLS cert, no port forwarding. It only listens on a NetBird-internal IP.

There is **no web UI.** No login page. No visual. The only entry point is the REST/WS API authenticated by a cerebro-issued JWT.

---

## 2. API surface

### 2.1 REST (Fastify)

| Method | Path | Description | Auth |
|---|---|---|---|
| GET  | `/v1/health`  | Liveness probe (no broker checks). | none |
| GET  | `/v1/state`   | Full slot state: connection status, uptime, last fill ts, ledger drift. | JWT |
| GET  | `/v1/balance` | Account balances per currency. | JWT |
| GET  | `/v1/positions` | Open positions with last mark price. | JWT |
| POST | `/v1/orders`  | Place / close / modify an order. | JWT |
| GET  | `/v1/orders/:id` | Get one order by id. | JWT |
| GET  | `/v1/fills?from=&to=` | Recent fills in range. | JWT |
| GET  | `/v1/pnl?range=` | Realized + unrealized P&L over 1d / 7d / 30d / custom. | JWT |
| GET  | `/v1/stream`  | Upgrade to WebSocket (see §2.2). | JWT in handshake |

All paths return JSON. Errors are RFC 7807 (`Problem+JSON`).

### 2.2 WebSocket streams (`GET /v1/stream` upgrades to `101 Switching Protocols`)

Authenticated once at handshake (JWT in `Sec-WebSocket-Protocol` header, format `jwt.<token>`). After upgrade, client sends `subscribe`/`unsubscribe` messages:

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

Channels:

- `fills` — order executions (any order on this account).
- `orders` — order state transitions (placed, filled, cancelled).
- `quotes:<SYMBOL>` — top-of-book price ticks (one subscription per symbol).
- `account` — account-level events (margin call, login, password reset, broker-dependent).
- `heartbeats` — every 30s, server-emitted only (`type: heartbeat` + `ts`).

### 2.3 Auth (slot-service JWT)

Issued by the AkronCloud cerebro. JWT claims:

- `sub` — service name (e.g., `cerebro`).
- `tenant_id` — string.
- `slot_id` — string.
- `exp` — Unix epoch. Max 1h.
- `scope` — array of permission strings, e.g., `["orders:write","positions:read","stream:subscribe"]`.

Slot validates HS256-signed with a per-tenant secret stored in the cerebro's `tenants.risk_limits` record (or wherever the cerebro keeps tenant secrets — design TBD).

Slot refuses any request with `exp` in the past, with an unknown `tenant_id`, or with a `scope` that doesn't include the requested operation.

### 2.4 Error codes

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | Schema validation failed. |
| 401 | `UNAUTHENTICATED` | Missing / bad JWT. |
| 403 | `FORBIDDEN` | JWT's scope doesn't permit. |
| 404 | `NOT_FOUND` | Order / position not found. |
| 409 | `RISK_BLOCKED` | Pre-trade risk rejected the order. |
| 502 | `BROKER_DOWN` | Connector can't reach broker. |
| 503 | `RECONCILING` | Ledger out of sync with broker; orders paused. |

---

## 3. Data model (local SQLite)

The slot persists its own state in a local SQLite file (`/var/lib/akron-slot/state.db` by default, configurable via `SLOT_STATE_DB`). Survives restarts.

Tables:

- `accounts` — one row per broker connection. Columns: `id uuid`, `broker text`, `encrypted_creds blob`, `status text` (active/paused/error), `last_sync_ts`, `created_at`.
- `orders` — every order ever placed on this account. Columns: `id uuid`, `account_id uuid`, `instrument text`, `side text`, `qty numeric`, `type text` (market/limit/stop), `price numeric?`, `sl numeric?`, `tp numeric?`, `reduce_qty numeric?`, `status text` (pending/filled/cancelled/rejected), `broker_order_id text`, `ts_open int`, `ts_close int`.
- `fills` — every fill on this account. Columns: `id uuid`, `order_id uuid`, `instrument text`, `qty numeric`, `price numeric`, `fee numeric`, `ts int`.
- `positions` — **derived view**, recomputed from `orders` + `fills` on every read. No separate persistence.

ORM: Drizzle. Migrations in `src/db/migrations/`.

---

## 4. Broker connector interface

Each broker has a `BrokerConnector`. Implementation in `src/connectors/<broker>.ts`.

```ts
interface BrokerConnector {
  id: string;                       // 'deriv' | 'mt5' | 'ibkr' | ...
  displayName: string;
  connect(creds: unknown): Promise<AccountRef>;
  disconnect(accountId: string): Promise<void>;
  quote(symbol: string): Promise<Quote>;
  positions(accountId: string): Promise<Position[]>;
  openTrade(accountId: string, order: NewOrder): Promise<OrderResult>;
  closeTrade(accountId: string, positionId: string, qty?: number): Promise<OrderResult>;
  stream(accountId: string): AsyncIterable<BrokerEvent>;
}
```

Where:

```ts
type Quote = { symbol: string; bid: number; ask: number; ts: number };

type Position = {
  id: string;
  account_id: string;
  instrument: string;
  side: 'long' | 'short';
  qty: number;
  avg_price: number;
  mark_price?: number;
  unrealized_pnl?: number;
};

type NewOrder = {
  instrument: string;
  side: 'buy' | 'sell';
  qty: number;
  type: 'market' | 'limit' | 'stop';
  price?: number;
  sl?: number;
  tp?: number;
  reduce_qty?: number;
};

type OrderResult =
  | { ok: true; order_id: string; broker_order_id: string }
  | { ok: false; reason: string };

type BrokerEvent =
  | { kind: 'fill'; data: Fill }
  | { kind: 'order_state'; data: { order_id: string; status: OrderStatus } }
  | { kind: 'account'; data: AccountEvent };
```

### 4.1 Initial connectors (MVP)

- **`deriv`** — DerivAPI native WebSocket. Implemented from scratch per their protocol. ~300 LOC. No external SDK.

### 4.2 Future connectors (post-MVP)

- **`mt5`** — MT5 via MetaTrader5 Python SDK in-process + Wine on Linux (or via MetaAPI as an optional remote connector).
- **`ibkr`** — Interactive Brokers TWS API.
- **`alpaca`** — REST.

Adding a new connector = implement `BrokerConnector` interface + register in `src/connectors/index.ts`. See `docs/CONNECTORS.md`.

---

## 5. Risk engine

Pre-trade validator on the `POST /v1/orders` path reads `risk_limits` (managed by AkronCloud cerebro via `PATCH /v1/risk-limits/{slot_id}` — this endpoint is on the slot; the cerebro is the only authorized caller).

Defaults (set by AkronCloud cerebro at slot registration):

- `max_position_size` per instrument.
- `max_daily_loss_pct` of allocated balance.
- `kill_switch_active` — when true, slot rejects all orders.

On reject, slot returns `409 RISK_BLOCKED` with details and writes to the local audit log.

---

## 6. Reconciler

Cron job (every 30s by default, configurable via `SLOT_RECONCILE_INTERVAL_MS`) syncs ledger ↔ broker:

1. Pulls positions from broker via the connector.
2. Compares to local ledger positions (derived view).
3. On drift > 0.1 lot OR price > 0.5%, emits a `reconcile_alert` event (sent over WS + persisted to a `reconcile_log` table for audit).
4. On drift > 1 lot OR on rejection by broker, marks `accounts.status='error'` and rejects further orders with `503 RECONCILING`.

---

## 7. Failure modes

| Failure | Slot behavior |
|---|---|
| Broker API down | Retries with exponential backoff up to 5 min. Marks account `status='error'`. Cerebro alerted on next `/v1/state` poll. |
| Disconnect mid-order | Local ledger has `status='pending'` orders. On reconnect, replays them via the connector. Duplicates are detected via `broker_order_id` uniqueness. |
| Slot crash | On restart, slot reloads SQLite state. Reconciler runs immediately, syncs any broker state that was missed while down. |
| Cerebro disconnects | Slot keeps running; orders continue. WS streams are buffered briefly (1k events) until reconnect. |
| Concurrent JWT conflicts | Last write wins on `tenants.risk_limits`; slot emits an audit event on risk-limit override. |
| Time skew between slot and broker | Reconciler catches within `SLOT_RECONCILE_INTERVAL_MS` and emits drift event. |

---

## 8. Deployment

- **Image**: built from `Dockerfile` at the repo root (scaffolded now, real content in follow-up PRs as impl lands).
- **Registry**: `ghcr.io/alxvarp/akroncloud-slot:<semver>`.
- **Consumed by**: `AkronCloud-Node/bootstrap.sh` which does `docker pull <registry>:<tag>` + runs the image.

### 8.1 Environment variables (slot-side, all `.env`-driven)

| Variable | Required | Meaning |
|---|---|---|
| `SLOT_TENANT_ID` | yes | Which tenant owns this slot. |
| `SLOT_SLOT_ID` | yes | Unique id of this slot (assigned by Akron-cloud at registration). |
| `SLOT_JWT_SECRET` | yes | HS256 secret to validate `cerebro` JWTs. Per-tenant. |
| `SLOT_BIND` | optional | Default `127.0.0.1` (NetBird internal). |
| `SLOT_PORT` | optional | Default `7777`. |
| `SLOT_STATE_DB` | optional | Default `/var/lib/akron-slot/state.db`. |
| `SLOT_LOG_LEVEL` | optional | Default `info`. |
| `SLOT_CONNECTORS` | yes | Comma-separated list of `id`s the slot uses (e.g., `deriv`). |
| `SLOT_DEFAULT_BROKER` | yes | The broker connector to use for the default account. |
| `SLOT_RECONCILE_INTERVAL_MS` | optional | Default `30000`. |

No secret is ever hard-coded; everything comes from `.env` or the cerebro via the registration API.

---

## 9. Out of scope

- **Public-facing API**. The slot has no DNS, no TLS cert, no port forwarding. The cerebro's public endpoints (for the panel) are entirely separate and live in `AkronCloud`.
- **Cross-broker aggregation**. Each slot handles one broker. Aggregation across brokers is done at the cerebro level.
- **Order routing across accounts**. Per-tenant routing logic lives in `AkronCloud/apps/orchestrator`.
- **Smart order routing (SOR)** / "best execution". Out of scope for MVP.
- **UI / web frontend**. There is no UI. The slot is a pure API service. The cerebro + panel are the only human-facing layers.
- **Persistent order history across reboots** beyond the local SQLite. The cerebro owns long-term analytics from the slot's reported fills.

---

## 10. Versioning + release

This repo uses semver on `package.json`. A release tag (`v0.1.0`) triggers:

- Build of the Docker image (`ghcr.io/alxvarp/akroncloud-slot:0.1.0`).
- The `AkronCloud-Node` bootstrap pulls `:latest` by default and falls back to a pinned tag if `--registry=<registry>:<tag>` is specified.

Per the grandparent SPEC `AkronCloud/SPEC.md § 16 (Slot-as-a-Service)`. Major bumps require coordinated updates in `AkronCloud-Node`'s default registry tag.

---

## 11. Reading order for a new contributor

1. This file.
2. `src/server.ts` (entry point — wires Fastify + WS + auth + reconciles + connectors).
3. `src/api/rest.ts` + `src/api/ws.ts` (the protocol surface).
4. `src/connectors/base.ts` (the connector interface).
5. `src/connectors/deriv.ts` (the MVP connector — `deriv` is what we ship first).
6. `src/ledger.ts` + `src/reconciler.ts` (the trust model).
7. `docs/CONNECTORS.md` (how to add another broker).
