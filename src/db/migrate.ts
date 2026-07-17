import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

import { log } from '../log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the migrations directory next to this source file.
 * Works under both `tsx` (where __dirname resolves to .ts source) and
 * `tsc`/`node` against compiled JS.
 */
function migrationsDir(): string {
  return join(__dirname, 'migrations');
}

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
 * Apply any unapplied migrations under `migrations/` in lexical order.
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

  const dir = migrationsDir();
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (e) {
    throw new Error(`migrations dir not found: ${dir}`);
  }

  const inserted: string[] = [];
  const insertStmt = db.prepare(
    `INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`,
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      insertStmt.run(file, Date.now());
    });
    try {
      tx();
      log.info({ migration: file }, 'migration applied');
      inserted.push(file);
    } catch (e) {
      log.error({ migration: file, err: (e as Error).message }, 'migration failed');
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
