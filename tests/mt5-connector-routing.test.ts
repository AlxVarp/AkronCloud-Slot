import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openAndMigrate } from '../src/db/migrate';
import { accountsRepo } from '../src/db';
import { makeLedger } from '../src/ledger';
import { Mt5TcpServer } from '../src/services/mt5-tcp-server';
import { Mt5Connector } from '../src/connectors/mt5';
import type { AccountRow } from '../src/db';

const TENANT = 'tenant-a';

/**
 * Regression: `Mt5Connector.handleEvent` used `firstRef()` as a heuristic
 * to pick the target account when an event arrived. If two accounts were
 * registered and MT5 was logged into the SECOND one, events from MT5
 * would still update the FIRST account's record — making /v1/state
 * report the wrong broker_login as logged in.
 *
 * Root-cause fix: forward the resolved `AccountRow` from the TCP
 * server's `onEvent` callback into the connector's handleEvent, so the
 * event lands on the account whose `broker_login` matches the event
 * payload. Falls back to `findRefByLogin(payload.login)` for events
 * where the upstream resolver returned undefined; legacy fills with no
 * payload login fall back to `firstRef()`.
 */

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'slot-mt5-routing-'));
  const dbPath = join(dir, 'state.db');
  const db = openAndMigrate(dbPath);
  const ledger = makeLedger(db);
  const repo = accountsRepo(db);

  const tcp = new Mt5TcpServer({
    ledger,
    resolveAccount: (brokerLogin: string) => {
      return repo
        .list(TENANT)
        .find((r) => r.broker_login === brokerLogin);
    },
  });

  const connector = new Mt5Connector({ db, ledger, tcp });
  connector.id = 'mt5';

  // Insert two accounts via the repo so resolveAccount() works the
  // way it does in production (via accountsRepo.list).
  const demo: AccountRow = {
    id: 'acc-demo-32141235',
    tenant_id: TENANT,
    slot_id: 'slot-1',
    broker: 'mt5',
    broker_server: 'Deriv-Demo',
    broker_login: '32141235',
    encrypted_creds: Buffer.alloc(0),
    status: 'active',
    created_at: 1,
    updated_at: 1,
    last_validation_ts: null,
    last_error: null,
  };
  const real: AccountRow = {
    id: 'acc-real-32324375',
    tenant_id: TENANT,
    slot_id: 'slot-1',
    broker: 'mt5',
    broker_server: 'Deriv-Server-02',
    broker_login: '32324375',
    encrypted_creds: Buffer.alloc(0),
    status: 'active',
    created_at: 2,
    updated_at: 2,
    last_validation_ts: null,
    last_error: null,
  };
  repo.insert({ ...demo });
  repo.insert({ ...real });

  return { db, ledger, tcp, connector, demo, real };
}

describe('Mt5Connector.handleEvent — root-cause routing fix', () => {
  let env: ReturnType<typeof setup>;

  beforeEach(() => {
    env = setup();
  });

  it('updates only the matching account when an account event for Deriv-Demo arrives', () => {
    const { connector, demo, real, tcp } = env;

    // Register both accounts in the connector's Map (the connect() side
    // effect of validateAccount()).
    void connector.connect({
      server: demo.broker_server,
      login: demo.broker_login,
      password: 'x',
    });
    void connector.connect({
      server: real.broker_server,
      login: real.broker_login,
      password: 'y',
    });

    // The TCP server calls onEvent(evt, resolvedAccount) where
    // resolvedAccount comes from resolveAccount(login). Simulate that
    // contract by calling onEvent directly with the demo row resolved.
    tcp.onEvent?.(
      {
        kind: 'account',
        ts: Date.now(),
        data: {
          logged_in: true,
          login: demo.broker_login,
          server: demo.broker_server,
          balance: 100.5,
          equity: 100.5,
        },
      },
      demo,
    );

    const accounts = (connector as unknown as { accounts: Map<string, { loggedIn: boolean; balance: number; equity: number; broker_login: string }> }).accounts;
    const demoRec = accounts.get('mt5-Deriv-Demo-32141235');
    const realRec = accounts.get('mt5-Deriv-Server-02-32324375');

    expect(demoRec).toBeDefined();
    expect(demoRec?.loggedIn).toBe(true);
    expect(demoRec?.balance).toBe(100.5);
    expect(demoRec?.equity).toBe(100.5);

    // The other registered account must NOT have been touched.
    expect(realRec).toBeDefined();
    expect(realRec?.loggedIn).toBe(false);
    expect(realRec?.balance).toBe(0);
    expect(realRec?.equity).toBe(0);
  });

  it('updates only Deriv-Server-02 when an event for that login arrives', () => {
    const { connector, demo, real, tcp } = env;

    void connector.connect({
      server: demo.broker_server,
      login: demo.broker_login,
      password: 'x',
    });
    void connector.connect({
      server: real.broker_server,
      login: real.broker_login,
      password: 'y',
    });

    // First, mark Deriv-Demo as logged in via one event.
    tcp.onEvent?.(
      {
        kind: 'account',
        ts: Date.now(),
        data: { logged_in: true, login: demo.broker_login, balance: 100, equity: 100 },
      },
      demo,
    );

    // Then, an event for Deriv-Server-02 arrives. The demo account
    // must keep its 100 balance — only the real account changes.
    tcp.onEvent?.(
      {
        kind: 'account',
        ts: Date.now(),
        data: { logged_in: true, login: real.broker_login, balance: 9999, equity: 9999 },
      },
      real,
    );

    const accounts = (connector as unknown as { accounts: Map<string, { loggedIn: boolean; balance: number; equity: number; broker_login: string }> }).accounts;
    const demoRec = accounts.get('mt5-Deriv-Demo-32141235');
    const realRec = accounts.get('mt5-Deriv-Server-02-32324375');

    expect(demoRec?.balance).toBe(100);
    expect(realRec?.balance).toBe(9999);
    expect(realRec?.loggedIn).toBe(true);
  });

  it('falls back to firstRef() only when there is no login in the event payload and no resolved account', () => {
    const { connector, tcp } = env;

    void connector.connect({
      server: 'Deriv-Server-02',
      login: '32324375',
      password: 'x',
    });

    // Legacy event: no resolved account AND no login in payload. The
    // fallback to firstRef() is the documented legacy behaviour — we
    // assert it still works for compatibility with v54 publisher.
    tcp.onEvent?.(
      {
        kind: 'account',
        ts: Date.now(),
        // no data.login
        data: { logged_in: true, balance: 50, equity: 50 },
      } as unknown as Parameters<NonNullable<typeof tcp.onEvent>>[0],
      undefined,
    );

    const accounts = (connector as unknown as { accounts: Map<string, { loggedIn: boolean; balance: number; equity: number }> }).accounts;
    const rec = accounts.get('mt5-Deriv-Server-02-32324375');
    expect(rec?.loggedIn).toBe(true);
    expect(rec?.balance).toBe(50);
  });
});