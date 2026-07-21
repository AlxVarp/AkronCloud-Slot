import type { FastifyInstance } from 'fastify';

import { type Deps } from '../app.js';
import { validateAccount } from '../validator.js';

/**
 * REST routes - single-broker / single-desktop mode.
 *
 * v0.x of this slot exposed a JWT-protected multi-tenant API
 * (GET /connect mints a bootstrap token, /v1/accounts CRUDs N
 * brokers, /v1/orders/fills/positions/balance report per-account
 * state, /v1/stream pushes a WS feed). That surface was the
 * cerebro-orchestration API.
 *
 * The cerebro isn't part of the deployment we run today, so the
 * surface is reduced to the three endpoints the wrapper actually
 * uses:
 *
 *   GET  /v1/health   - unauthenticated liveness check
 *   GET  /v1/state    - unauthenticated single-account state read
 *   POST /v1/sync     - unauthenticated single-account sync trigger
 *
 * All three operate on the single account that the slot was
 * configured with. tenant_id is still read from cfg so the DB
 * queries land on the right row, but no caller has to send it.
 *
 * /internal/* (same-origin, no JWT) is in src/api/internal.ts -
 * the mobile wrapper uses those, not /v1/*.
 */
export async function restRoutes(app: FastifyInstance): Promise<void> {
  const deps = app.deps as Deps;

  // GET /v1/health - unauthenticated. Used by anything that wants
  // to know the slot is alive: the cerebro (if it's reattached
  // later), the mobile wrapper, kubernetes probes, etc.
  app.get('/v1/health', async () => ({
    status: 'ok',
    uptime_s: Math.floor(process.uptime()),
    version: '0.2.0',
    service: 'akroncloud-slot',
    slot_id: deps.cfg.slotId,
    connector: deps.cfg.connectorId,
  }));

  // GET /v1/state - the single configured account. Read-only.
  // Returns the account row + the live connector state. No
  // auth (slot bound to localhost-only or reverse-proxied
  // upstream).
  app.get('/v1/state', async () => {
    const tenantId = deps.cfg.tenantId;
    const accounts = deps.accounts.list(tenantId);
    const acct = accounts[0];
    if (!acct) {
      return {
        ok: false,
        reason: 'no account yet - login through the mobile wrapper first',
        accounts: [],
      };
    }
    const accountRef = `${deps.connector.id}-${acct.broker_server}-${acct.broker_login}`;
    let connectorState: unknown;
    try {
      connectorState = await deps.connector.state(accountRef);
    } catch (e) {
      connectorState = { error: (e as Error).message };
    }
    return {
      ok: true,
      account: {
        id: acct.id,
        broker: acct.broker,
        broker_server: acct.broker_server,
        broker_login: acct.broker_login,
        status: acct.status,
        created_at: acct.created_at,
      },
      connector: connectorState,
    };
  });

  // POST /v1/sync - re-validate the single configured account.
  // Triggers a fresh login frame to SlotService.mq5 over TCP
  // 127.0.0.1:7778 so the connector picks up any account_status
  // event that happened while the slot was idle.
  app.post('/v1/sync', async () => {
    const tenantId = deps.cfg.tenantId;
    const row = deps.accounts.list(tenantId)[0];
    if (!row) {
      return {
        ok: false,
        reason: 'no account yet - login through the mobile wrapper first',
      };
    }
    validateAccount(deps, tenantId, row);
    return {
      ok: true,
      account: {
        id: row.id,
        broker_server: row.broker_server,
        broker_login: row.broker_login,
      },
      hint:
        'Re-validator dispatched. The MT5 connector sent a login ' +
        'frame to SlotService.mq5 over TCP 127.0.0.1:7778. MQL5 ' +
        'will emit account_status + fills via the same socket. If ' +
        'events do not arrive, ensure you are logged into MT5 and ' +
        'the #property service is running.',
    };
  });
}
