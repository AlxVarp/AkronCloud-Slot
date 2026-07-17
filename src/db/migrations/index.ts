/**
 * Migration registry. Each migration is a named, idempotent SQL
 * statement bundle. We import them as TS modules so tsc emits them
 * into dist/ alongside migrate.js — no COPY of raw .sql files
 * needed in the Docker image.
 */
import * as m_0001 from './0001_init.js';

export type Migration = {
  name: string;
  sql: string;
};

export const MIGRATIONS: Migration[] = [m_0001];
