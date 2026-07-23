import type { FastifyInstance } from 'fastify';

import type { Deps } from '../app.js';
import { validateAccount } from '../validator.js';

/**
 * Internal endpoints — same-origin only, no JWT required.
 *
 * The /mobile wrapper is served by this same Fastify instance, so the
 * in-browser JS can call /internal/* directly without minting a JWT.
 * These routes are intentionally NOT mounted under /v1 (which is the
 * JWT-protected public surface) and contain no discovery info a
 * stranger could weaponise - worst case the caller learns that the
 * slot exists.
 *
 * If the slot is ever fronted by a separate reverse proxy, put this
 * prefix behind a network ACL (e.g. nginx `allow 127.0.0.1;`) so it
 * stays internal.
 */
export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/internal/ping', async () => ({ ok: true, ts: Date.now() }));

  /**
   * POST /internal/sync — re-validate every active account against the
   * live MT5 session. Same effect as POST /v1/sync but skips the JWT
   * check and operates on the slot's configured tenant.
   *
   * This is what the /mobile Sync button calls, both automatically on
   * RFB connect and when the user taps the button.
   */
  app.post('/internal/sync', async (req) => {
    const deps = (req.server as unknown as { deps: Deps }).deps;
    const tenantId = deps.cfg.tenantId;
    deps.log.info(
      { ip: req.ip, ua: req.headers['user-agent']?.slice(0,40) },
      '/internal/sync called',
    );
    const accounts = deps.accounts.list(tenantId);
    const triggered: Array<{
      id: string;
      broker_server: string;
      broker_login: string;
      previous_status: string;
    }> = [];
    for (const row of accounts) {
      if (row.status === 'disabled') continue;
      triggered.push({
        id: row.id,
        broker_server: row.broker_server,
        broker_login: row.broker_login,
        previous_status: row.status,
      });
      validateAccount(deps, tenantId, row);
    }
    return {
      triggered_at: Date.now(),
      accounts: triggered,
      hint:
        accounts.length === 0
          ? 'No accounts yet. Hit Login in /mobile to provision one.'
          : 'Re-validator dispatched for every account. SlotService.mq5 will emit account_status + fills over TCP 127.0.0.1:7778 within seconds.',
    };
  });
}
