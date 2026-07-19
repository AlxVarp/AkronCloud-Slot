import type { Database as DB } from 'better-sqlite3';

/**
 * Domain row types. Kept narrow on purpose — fields like broker_password
 * are intentionally absent; you read them via a separate decrypt call
 * in src/accounts.ts (Phase B). Only non-secret columns here.
 */

export type AccountRow = {
  id: string;
  tenant_id: string;
  slot_id: string;
  broker: string;
  broker_server: string;
  broker_login: string;
  encrypted_creds: Buffer;
  status:
    | 'pending_validation'
    | 'validating'
    | 'active'
    | 'error'
    | 'disabled';
  last_validation_ts: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

export type NewAccountRow = {
  id: string;
  tenant_id: string;
  slot_id: string;
  broker: string;
  broker_server: string;
  broker_login: string;
  encrypted_creds: Buffer;
  status: AccountRow['status'];
  created_at: number;
  updated_at: number;
};

/**
 * Tiny typed query helpers. For Phase A we stay hand-written so the
 * SQL stays close to the schema. Drizzle-orm is in deps for later
 * adoption if we want a query builder.
 */

const SQL_INSERT_ACCOUNT = `
  INSERT INTO accounts (
    id, tenant_id, slot_id, broker, broker_server, broker_login,
    encrypted_creds, status, created_at, updated_at
  ) VALUES (
    @id, @tenant_id, @slot_id, @broker, @broker_server, @broker_login,
    @encrypted_creds, @status, @created_at, @updated_at
  )
`;

const SQL_GET_ACCOUNT = `SELECT * FROM accounts WHERE id = ? AND tenant_id = ?`;
const SQL_LIST_ACCOUNTS = `SELECT * FROM accounts WHERE tenant_id = ? ORDER BY created_at DESC`;
const SQL_UPDATE_ACCOUNT_STATUS = `
  UPDATE accounts
     SET status = @status,
         last_validation_ts = @last_validation_ts,
         last_error = @last_error,
         updated_at = @updated_at
   WHERE id = @id AND tenant_id = @tenant_id
`;

export const accountsRepo = (db: DB) => ({
  insert(row: NewAccountRow): void {
    db.prepare(SQL_INSERT_ACCOUNT).run(row);
  },
  get(tenantId: string, id: string): AccountRow | undefined {
    const r = db
      .prepare(SQL_GET_ACCOUNT)
      .get(id, tenantId) as AccountRow | undefined;
    return r;
  },
  list(tenantId: string): AccountRow[] {
    return db.prepare(SQL_LIST_ACCOUNTS).all(tenantId) as AccountRow[];
  },
  updateStatus(
    tenantId: string,
    id: string,
    status: AccountRow['status'],
    lastValidationTs: number | null,
    lastError: string | null,
    updatedAt: number,
  ): void {
    db.prepare(SQL_UPDATE_ACCOUNT_STATUS).run({
      id,
      tenant_id: tenantId,
      status,
      last_validation_ts: lastValidationTs,
      last_error: lastError,
      updated_at: updatedAt,
    });
  },
});
