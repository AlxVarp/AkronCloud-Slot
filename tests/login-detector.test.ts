import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startLoginDetector, readSlotState } from '../src/services/login-detector.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slot-state-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readSlotState', () => {
  it('returns pending_login when no state file exists', () => {
    expect(readSlotState()).toBe('pending_login');
  });

  it('returns operational when state file says operational', () => {
    const f = join(dir, 'state');
    writeFileSync(f, 'operational\n');
    expect(readSlotState(f)).toBe('operational');
  });

  it('returns pending_login when state file says pending_login', () => {
    const f = join(dir, 'state');
    writeFileSync(f, 'pending_login\n');
    expect(readSlotState(f)).toBe('pending_login');
  });

  it('returns unknown for unrecognized content', () => {
    const f = join(dir, 'state');
    writeFileSync(f, 'something else\n');
    expect(readSlotState(f)).toBe('unknown');
  });
});

describe('startLoginDetector with an already-operational state file', () => {
  it('does not run a watcher if the state file is already operational', () => {
    const f = join(dir, 'state');
    writeFileSync(f, 'operational\n');
    let transitions = 0;
    const stop = startLoginDetector({
      stateFile: f,
      onTransition: () => {
        transitions += 1;
      },
    });
    expect(transitions).toBe(1);
    expect(readSlotState(f)).toBe('operational');
    stop();
  });
});
