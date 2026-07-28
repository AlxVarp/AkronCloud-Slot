import type { FastifyInstance } from 'fastify';

import type { Deps } from '../app.js';
import { validateAccount } from '../validator.js';
import { lockVisualSession, unlockVisualSession } from '../services/visual-session-lock.js';

// The mobile and desktop wrappers both sync on RFB connect, and browsers can
// briefly reconnect more than once while KasmVNC settles. Avoid launching
// duplicate Wine/MT5 validations for the same account in that short window.
const SYNC_COOLDOWN_MS = 5_000;
const lastSyncByAccount = new Map<string, number>();

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
   * Read-only visual-session gate. This intentionally exposes no account
   * identifiers or balances: the web VNC wrapper only needs to know whether
   * a validated MT5 account is operational before it detaches its canvas.
   */
  app.get('/internal/operational', async (req) => {
    const deps = (req.server as unknown as { deps: Deps }).deps;
    const accounts = deps.accounts.list(deps.cfg.tenantId);
    const active = accounts.find((account) => account.status === 'active');
    if (!active) {
      unlockVisualSession();
      return { operational: false, checked_at: Date.now() };
    }
    // A persisted DB status can outlive an MT5 restart. Confirm that the
    // live command bridge can still read the account before closing VNC.
    try {
      const accountRef = `${deps.connector.id}-${active.broker_server}-${active.broker_login}`;
      const live = await deps.connector.getAccount(accountRef);
      const operational = String(live.login ?? '') === active.broker_login;
      if (operational) lockVisualSession();
      else unlockVisualSession();
      return { operational, checked_at: Date.now() };
    } catch {
      unlockVisualSession();
      return { operational: false, checked_at: Date.now() };
    }
  });

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
    const skipped: string[] = [];
    const now = Date.now();
    for (const row of accounts) {
      if (row.status === 'disabled') continue;
      const previousSync = lastSyncByAccount.get(row.id) ?? 0;
      if (now - previousSync < SYNC_COOLDOWN_MS) {
        skipped.push(row.id);
        continue;
      }
      lastSyncByAccount.set(row.id, now);
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
      skipped_account_ids: skipped,
      hint:
        accounts.length === 0
          ? 'No accounts yet. Hit Login in /mobile to provision one.'
          : 'Re-validator dispatched for every account. SlotService.mq5 will emit account_status + fills over TCP 127.0.0.1:7778 within seconds.',
    };
  });
}
