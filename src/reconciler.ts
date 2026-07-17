/**
 * Reconciler (SPEC § 7).
 *
 * Phase A: scaffold only. Phase B: every cfg.reconcileIntervalMs,
 * pull positions from the connector, compare to the local ledger
 * (positionsFor), emit drift events over WS, and (on >1 lot drift or
 * broker rejection) flip accounts.status='error' and reject new
 * orders with 503 RECONCILING.
 */
export function startReconciler(): { stop: () => void } {
  return {
    stop() {
      /* no-op until Phase B */
    },
  };
}
