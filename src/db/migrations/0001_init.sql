-- 0001_init.sql — AkronCloud-Slot initial schema.
--
-- Forward-only. Idempotent at the table level via CREATE TABLE IF NOT
-- EXISTS. The migrations table itself is created by the migration
-- runner on first apply.

-- Accounts: one row per broker connection provisioned on this slot.
CREATE TABLE IF NOT EXISTS accounts (
  id                 TEXT PRIMARY KEY,            -- UUID v4
  tenant_id          TEXT NOT NULL,
  slot_id            TEXT NOT NULL,
  broker             TEXT NOT NULL,               -- 'mt5' in Phase A
  broker_server      TEXT NOT NULL,
  broker_login       TEXT NOT NULL,
  encrypted_creds    BLOB NOT NULL,               -- AES-256-GCM packed (iv ‖ ct ‖ tag)
  status             TEXT NOT NULL,               -- pending_validation | validating | active | error | disabled
  last_validation_ts INTEGER,                     -- Unix epoch ms
  last_error         TEXT,
  created_at         INTEGER NOT NULL,            -- Unix epoch ms
  updated_at         INTEGER NOT NULL             -- Unix epoch ms
);

CREATE INDEX IF NOT EXISTS idx_accounts_tenant_id ON accounts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_accounts_status    ON accounts (status);

-- Orders: every order ever placed on this account.
CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,              -- UUID v4
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  instrument       TEXT NOT NULL,
  side             TEXT NOT NULL,                 -- 'buy' | 'sell'
  qty              REAL NOT NULL,
  type             TEXT NOT NULL,                 -- 'market' | 'limit' | 'stop'
  price            REAL,
  sl               REAL,
  tp               REAL,
  reduce_qty       REAL,
  status           TEXT NOT NULL,                 -- pending | filled | cancelled | rejected
  broker_order_id  TEXT,
  ts_open          INTEGER,                       -- Unix epoch ms
  ts_close         INTEGER                        -- Unix epoch ms
);

CREATE INDEX IF NOT EXISTS idx_orders_account_ts    ON orders (account_id, ts_open);
CREATE INDEX IF NOT EXISTS idx_orders_status        ON orders (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_broker_id ON orders (broker_order_id) WHERE broker_order_id IS NOT NULL;

-- Fills: every fill on this account.
CREATE TABLE IF NOT EXISTS fills (
  id          TEXT PRIMARY KEY,                    -- UUID v4
  order_id    TEXT REFERENCES orders(id) ON DELETE SET NULL,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  instrument  TEXT NOT NULL,
  qty         REAL NOT NULL,
  price       REAL NOT NULL,
  fee         REAL,
  ts          INTEGER NOT NULL                     -- Unix epoch ms
);

CREATE INDEX IF NOT EXISTS idx_fills_account_ts ON fills (account_id, ts);

-- Reconciler log: Phase B will populate this.
CREATE TABLE IF NOT EXISTS reconcile_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  drift_kind  TEXT NOT NULL,                       -- 'lot_drift' | 'price_drift' | 'broker_reject'
  severity    TEXT NOT NULL,                       -- 'warn' | 'error'
  detail      TEXT NOT NULL
);

-- Risk limits: one row per (tenant_id, slot_id). Phase A seeds from env.
CREATE TABLE IF NOT EXISTS risk_limits (
  tenant_id           TEXT NOT NULL,
  slot_id             TEXT NOT NULL,
  max_position_size   REAL NOT NULL DEFAULT 0,
  max_daily_loss_pct  REAL NOT NULL DEFAULT 100,
  kill_switch_active  INTEGER NOT NULL DEFAULT 0,  -- boolean 0/1
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, slot_id)
);
