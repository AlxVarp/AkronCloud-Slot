/**
 * 0001_init — initial schema for accounts / orders / fills /
 * reconcile_log / risk_limits.
 *
 * We embed the SQL as a TS string so tsc emits it into dist/db/migrations
 * (we don't depend on COPY'ing .sql files into the Docker image).
 */
export const name = '0001_init';

export const sql = `
-- 0001_init.sql -- AkronCloud-Slot initial schema.

-- Accounts: one row per broker connection provisioned on this slot.
CREATE TABLE IF NOT EXISTS accounts (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  slot_id            TEXT NOT NULL,
  broker             TEXT NOT NULL,
  broker_server      TEXT NOT NULL,
  broker_login       TEXT NOT NULL,
  encrypted_creds    BLOB NOT NULL,
  status             TEXT NOT NULL,
  last_validation_ts INTEGER,
  last_error         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_tenant_id ON accounts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_accounts_status    ON accounts (status);

-- Orders: every order ever placed on this account.
CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  instrument       TEXT NOT NULL,
  side             TEXT NOT NULL,
  qty              REAL NOT NULL,
  type             TEXT NOT NULL,
  price            REAL,
  sl               REAL,
  tp               REAL,
  reduce_qty       REAL,
  status           TEXT NOT NULL,
  broker_order_id  TEXT,
  ts_open          INTEGER,
  ts_close         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_orders_account_ts    ON orders (account_id, ts_open);
CREATE INDEX IF NOT EXISTS idx_orders_status        ON orders (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_broker_id ON orders (broker_order_id) WHERE broker_order_id IS NOT NULL;

-- Fills: every fill on this account.
CREATE TABLE IF NOT EXISTS fills (
  id          TEXT PRIMARY KEY,
  order_id    TEXT REFERENCES orders(id) ON DELETE SET NULL,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  instrument  TEXT NOT NULL,
  qty         REAL NOT NULL,
  price       REAL NOT NULL,
  fee         REAL,
  ts          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fills_account_ts ON fills (account_id, ts);

-- Reconciler log: populated by src/reconciler.ts (Phase B).
CREATE TABLE IF NOT EXISTS reconcile_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  drift_kind  TEXT NOT NULL,
  severity    TEXT NOT NULL,
  detail      TEXT NOT NULL
);

-- Risk limits: one row per (tenant_id, slot_id).
CREATE TABLE IF NOT EXISTS risk_limits (
  tenant_id           TEXT NOT NULL,
  slot_id             TEXT NOT NULL,
  max_position_size   REAL NOT NULL DEFAULT 0,
  max_daily_loss_pct  REAL NOT NULL DEFAULT 100,
  kill_switch_active  INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, slot_id)
);
`;
