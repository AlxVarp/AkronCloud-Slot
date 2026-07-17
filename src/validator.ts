import type { Deps } from './app';
import type { AccountRow } from './db';

/**
 * Async broker-credential validation worker (SPEC § 1 + § 4.4 + § 7).
 *
 * Phase A: scaffold only. The framework contract is in place so the
 * REST POST /v1/accounts handler can publish a 'validate' job without
 * blocking; Phase B hooks up the real MT5 login via the connector
 * and updates the row to `active` / `error`.
 *
 * Public surface:
 *   validateAccount(deps, tenantId, accountId): kicks a background
 *     validator. The promise resolves when the worker has scheduled
 *     the job — *not* when the credentials have been confirmed.
 *     Subscribers watch the row's `status` (`status` transitions
 *     emit a WS event in Phase B).
 */

export type ValidationOutcome =
  | { kind: 'ok' }
  | { kind: 'bad_credentials' }
  | { kind: 'broker_down'; detail: string }
  | { kind: 'unknown_error'; detail: string };

export function validateAccount(
  deps: Deps,
  tenantId: string,
  account: AccountRow,
): void {
  // Fire-and-forget. Real impl (Phase B) starts the broker session,
  // updates accountsRepo.updateStatus on completion.
  setImmediate(() => {
    const now = Date.now();
    deps.log.info({ tenant_id: tenantId, account_id: account.id }, 'validateAccount stub');
    // Phase A leaves the row in pending_validation. Real impl flips
    // it to active / error and emits a WS account event.
    void now;
  });
}
