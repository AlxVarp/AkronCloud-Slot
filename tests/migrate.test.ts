import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, applyMigrations, openAndMigrate } from '../src/db/migrate';
import { accountsRepo, type NewAccountRow } from '../src/db';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slot-db-'));
  dbPath = join(dir, 'state.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('db: migrations', () => {
  it('opens a DB at the given path, creating parent dirs', () => {
    const db = openDatabase(dbPath);
    expect(db.open).toBeTruthy();
    db.close();
  });

  it('applies 0001_init.sql on first run', () => {
    const db = openAndMigrate(dbPath);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        '_migrations',
        'accounts',
        'orders',
        'fills',
        'reconcile_log',
        'risk_limits',
        'sqlite_sequence',
      ]),
    );
    db.close();
  });

  it('records the applied migration', () => {
    const db = openAndMigrate(dbPath);
    const rows = db
      .prepare(`SELECT name FROM _migrations`)
      .all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['0001_init.sql']);
    db.close();
  });

  it('is idempotent: a second run applies zero new migrations', () => {
    const db1 = openAndMigrate(dbPath);
    db1.close();
    const db2 = openDatabase(dbPath);
    const inserted = applyMigrations(db2);
    expect(inserted).toEqual([]);
    db2.close();
  });

  it('creates the expected accounts indexes', () => {
    const db = openAndMigrate(dbPath);
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'accounts' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as { name: string }[];
    const names = idx.map((i) => i.name).sort();
    expect(names).toEqual(
      expect.arrayContaining(['idx_accounts_status', 'idx_accounts_tenant_id']),
    );
    db.close();
  });
});

describe('db: accountsRepo', () => {
  it('round-trips an insert + read', () => {
    const db = openAndMigrate(dbPath);
    const repo = accountsRepo(db);
    const now = Date.now();
    const row: NewAccountRow = {
      id: 'a-1',
      tenant_id: 'tenant-x',
      slot_id: 'slot-y',
      broker: 'mt5',
      broker_server: 'ICMarkets-Demo',
      broker_login: '12345',
      encrypted_creds: Buffer.from([1, 2, 3, 4]),
      status: 'pending_validation',
      created_at: now,
      updated_at: now,
    };
    repo.insert(row);
    const got = repo.get('tenant-x', 'a-1');
    expect(got).toBeDefined();
    expect(got!.broker_server).toBe('ICMarkets-Demo');
    expect(got!.encrypted_creds.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    db.close();
  });

  it('updates status without dropping credentials', () => {
    const db = openAndMigrate(dbPath);
    const repo = accountsRepo(db);
    const now = Date.now();
    repo.insert({
      id: 'a-2',
      tenant_id: 'tenant',
      slot_id: 'slot',
      broker: 'mt5',
      broker_server: 'X',
      broker_login: '1',
      encrypted_creds: Buffer.from('secret'),
      status: 'pending_validation',
      created_at: now,
      updated_at: now,
    });
    repo.updateStatus('tenant', 'a-2', 'active', now, null, now);
    const got = repo.get('tenant', 'a-2');
    expect(got!.status).toBe('active');
    expect(got!.encrypted_creds.toString('utf8')).toBe('secret');
    db.close();
  });

  it('isolates rows by tenant_id (no cross-tenant reads)', () => {
    const db = openAndMigrate(dbPath);
    const repo = accountsRepo(db);
    const now = Date.now();
    repo.insert({
      id: 'a-3',
      tenant_id: 'tenant-1',
      slot_id: 'slot',
      broker: 'mt5',
      broker_server: 'X',
      broker_login: '1',
      encrypted_creds: Buffer.from('s1'),
      status: 'pending_validation',
      created_at: now,
      updated_at: now,
    });
    repo.insert({
      id: 'a-4',
      tenant_id: 'tenant-2',
      slot_id: 'slot',
      broker: 'mt5',
      broker_server: 'Y',
      broker_login: '2',
      encrypted_creds: Buffer.from('s2'),
      status: 'pending_validation',
      created_at: now,
      updated_at: now,
    });
    expect(repo.get('tenant-2', 'a-3')).toBeUndefined();
    expect(repo.get('tenant-2', 'a-4')).toBeDefined();
    expect(repo.list('tenant-1').map((a) => a.id)).toEqual(['a-3']);
    expect(repo.list('tenant-2').map((a) => a.id)).toEqual(['a-4']);
    db.close();
  });
});
