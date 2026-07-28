import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const LOCK_FILE = '/var/lib/akron-slot/visual.lock';

export function visualSessionLocked(): boolean {
  return existsSync(LOCK_FILE);
}

export function lockVisualSession(): void {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  writeFileSync(LOCK_FILE, 'synced\n', { mode: 0o600 });
}

export function unlockVisualSession(): void {
  rmSync(LOCK_FILE, { force: true });
}
