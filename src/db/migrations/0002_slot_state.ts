/**
 * 0002_slot_state — bookkeeping for the bootstrap flow.
 *
 * Phase B-real adds:
 *   - accounts.broker_login (so we can look up by login, not just id)
 *   - bootstrap_tickets table: short-lived UUIDs the slot hands out so
 *     the user can SSH-tunnel into a VNC-backed noVNC frame, log into
 *     MT5, and then submit the broker creds via the slot's REST.
 */
export const name = '0002_slot_state';

export const sql = `
ALTER TABLE accounts ADD COLUMN broker_login TEXT;

CREATE TABLE IF NOT EXISTS bootstrap_tickets (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  slot_id       TEXT NOT NULL,
  state         TEXT NOT NULL,        -- 'pending_login' | 'logged_in' | 'disabled'
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bootstrap_tickets_tenant
  ON bootstrap_tickets (tenant_id);
`;
