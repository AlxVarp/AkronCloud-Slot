import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

import { log } from '../log.js';
import { MIGRATIONS, type Migration } from './migrations/index.js';

/**
 * Open the SQLite database at `dbPath`, ensuring its parent dir
 * exists. The returned handle is ready for reads + writes.
 */
export function openDatabase(dbPath: string): DB {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Apply any unapplied migrations from `MIGRATIONS` in declared order.
 * Records each applied file in `_migrations` (created on first run).
 *
 * Returns the list of migrations that were applied (in order). Safe
 * to call repeatedly.
 */
export function applyMigrations(db: DB): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare(`SELECT name FROM _migrations`)
      .all()
      .map((r) => (r as { name: string }).name),
  );

  const insertStmt = db.prepare(
    `INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`,
  );

  const inserted: string[] = [];
  for (const m of MIGRATIONS as Migration[]) {
    if (applied.has(m.name)) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      insertStmt.run(m.name, Date.now());
    });
    try {
      tx();
      log.info({ migration: m.name }, 'migration applied');
      inserted.push(m.name);
    } catch (e) {
      log.error(
        { migration: m.name, err: (e as Error).message },
        'migration failed',
      );
      throw e;
    }
  }
  return inserted;
}

/**
 * Convenience: open + run all pending migrations on a single call.
 * Returns the same DB handle for further use.
 */
export function openAndMigrate(dbPath: string): DB {
  const db = openDatabase(dbPath);
  applyMigrations(db);
  return db;
}
