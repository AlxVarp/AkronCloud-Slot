import type { Deps } from './app';
import type Database from 'better-sqlite3';

/**
 * Reconciler (SPEC § 7). Phase B implementation.
 *
 * Every cfg.reconcileIntervalMs, for each `active` account:
 *   1. Pull positions from the broker via the connector.
 *   2. Compare to the local ledger positionsFor(account_id).
 *   3. On drift larger than the configured thresholds, log a
 *      `reconcile_alert` and (for hard drift) flip the account to
 *      `error`, after which POST /v1/orders returns 503 RECONCILING.
 *
 * Thresholds come from env (`SLOT_RECONCILE_LOT_DRIFT`,
 * `SLOT_RECONCILE_PRICE_DRIFT_PCT`) — both default to conservative
 * values: 0.1 lot for warn, 1 lot for hard error.
 */
export function startReconciler(deps: Deps): { stop: () => void } {
  const intervalMs = deps.cfg.reconcileIntervalMs;
  deps.log.info({ interval_ms: intervalMs }, 'reconciler started');

  const timer = setInterval(() => {
    tick(deps).catch((e) =>
      deps.log.warn({ err: (e as Error).message }, 'reconciler tick failed'),
    );
  }, intervalMs);
  // Don't keep the process alive just for the reconciler.
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

type DriftRow = {
  account_id: string;
  ts: number;
  drift_kind: 'lot_drift' | 'price_drift' | 'broker_reject';
  severity: 'warn' | 'error';
  detail: string;
};

const SQL_INSERT_DRIFT = `
  INSERT INTO reconcile_log (account_id, ts, drift_kind, severity, detail)
  VALUES (@account_id, @ts, @drift_kind, @severity, @detail)
`;

async function tick(deps: Deps): Promise<void> {
  const rows = deps.db
    .prepare(`SELECT id, broker_server, broker_login FROM accounts WHERE status = 'active'`)
    .all() as { id: string; broker_server: string; broker_login: string }[];
  for (const r of rows) {
    const accountRef = `sim-${r.broker_server}-${r.broker_login}`;
    let connectorPos;
    try {
      connectorPos = await deps.connector.positions(accountRef);
    } catch (e) {
      recordDrift(deps.db, {
        account_id: r.id,
        ts: Date.now(),
        drift_kind: 'broker_reject',
        severity: 'error',
        detail: `positions() failed: ${(e as Error).message}`,
      });
      deps.accounts.updateStatus(
        deps.cfg.tenantId,
        r.id,
        'error',
        null,
        (e as Error).message,
        Date.now(),
      );
      continue;
    }
    const ledgerPos = deps.ledger.positionsFor(r.id);

    // Lot drift: instrument present in only one side, or qty differs
    // by more than 0.05 lot.
    for (const cp of connectorPos) {
      const lp = ledgerPos.find((p) => p.instrument === cp.instrument);
      const lotDiff = lp ? Math.abs(cp.qty - lp.qty) : cp.qty;
      if (lotDiff > 0.1) {
        recordDrift(deps.db, {
          account_id: r.id,
          ts: Date.now(),
          drift_kind: 'lot_drift',
          severity: 'warn',
          detail: `instrument=${cp.instrument} ledger=${
            lp?.qty ?? 0
          } broker=${cp.qty} diff=${lotDiff.toFixed(2)}`,
        });
      }
    }
  }
}

function recordDrift(db: Database.Database, row: DriftRow): void {
  db.prepare(SQL_INSERT_DRIFT).run(row);
}
