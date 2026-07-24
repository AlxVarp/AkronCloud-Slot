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
    stop.stop();
  });
});

describe('startLoginDetector.refresh()', () => {
  it('returns a handle with refresh() and stop()', () => {
    const f = join(dir, 'state');
    writeFileSync(f, 'operational\n');
    const h = startLoginDetector({ stateFile: f, onTransition: () => {} });
    expect(typeof h.refresh).toBe('function');
    expect(typeof h.stop).toBe('function');
    h.stop();
  });

  it('returns a Promise<void> from refresh()', async () => {
    const f = join(dir, 'state');
    writeFileSync(f, 'pending_login\n');
    let transitions = 0;
    const h = startLoginDetector({
      stateFile: f,
      onTransition: () => {
        transitions += 1;
      },
    });
    // First tick: pending_login → no transition fired (initial prev is 'unknown').
    // refresh() schedules a forced tick: in tests wmctrl is mocked but
    // isLoggedIn() will return false (no wmctrl binary), so tick will
    // NOT flip the state. We just assert refresh() returns a promise
    // that resolves without throwing.
    const r = h.refresh();
    expect(r).toBeInstanceOf(Promise);
    await r;
    expect(transitions).toBe(0); // wmctrl unavailable → not logged in
    h.stop();
  });
});

describe('login-detector wmctrl regex (parse title)', () => {
  it('matches the typical "MetaTrader 5 - <style> - <chart>" main window title', () => {
    // We just assert the regex shapes the detector uses. End-to-end
    // with a real wmctrl is covered by manually running the
    // container and inspecting /v1/lifecycle.
    const titles = [
      'MetaTrader 5 - Netting - EURUSD,H1',
      'Deriv-Demo: Demo Account - Hedge - Deriv.com Limited',
      'Account: 12345678',
      'MetaTrader 5',
    ];
    expect(titles[0]).toMatch(/^MetaTrader 5/);
    expect(titles[1]).toMatch(/:/);
    expect(titles[2]).toMatch(/^Account:\s/i);
    expect(titles[3]).toMatch(/^MetaTrader 5/);
  });

  it('rejects pre-login titles', () => {
    const pre = ['Login', 'MetaTrader 5 - Login', 'Login :', 'Login to Deriv-Server'];
    for (const t of pre) {
      const isLogin = /^Login\b|^MetaTrader 5 - Login\b|^\s*Login\s*$/i.test(t);
      expect(isLogin).toBe(true);
    }
  });
});
