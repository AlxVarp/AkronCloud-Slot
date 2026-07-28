import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';

type Stored = { fingerprint: string; response: unknown };

export function makeIdempotency(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  return async function once<T>(key: string | undefined, fingerprint: unknown, run: () => Promise<T>): Promise<T> {
    if (!key) return run();
    const digest = createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
    const row = db.prepare('SELECT fingerprint, response_json FROM idempotency_keys WHERE key=?').get(key) as { fingerprint: string; response_json: string } | undefined;
    if (row) {
      if (row.fingerprint !== digest) throw new Error('idempotency_key_mismatch');
      return JSON.parse(row.response_json) as T;
    }
    const response = await run();
    db.prepare('INSERT OR IGNORE INTO idempotency_keys(key,fingerprint,response_json,created_at) VALUES(?,?,?,?)')
      .run(key, digest, JSON.stringify(response), Date.now());
    return response;
  };
}
