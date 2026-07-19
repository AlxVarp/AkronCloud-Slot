import type { Deps } from './app.js';
import type { AccountRow } from './db/index.js';
import { decrypt } from './crypto.js';

/**
 * Async broker-credential validation worker (SPEC § 1 + § 4.4 + § 7).
 *
 * Phase B implementation:
 *  - decrypts the broker password using SLOT_ENCRYPTION_KEY + tenant salt
 *  - hands the plaintext creds to the configured connector
 *  - on success: opens the broker session, flips status='active'
 *  - on failure: records last_error, flips status='error'
 *
 * The plaintext password buffer is zeroed after use.
 */
export type ValidationOutcome =
  | { kind: 'ok'; accountRef: string }
  | { kind: 'bad_credentials'; detail?: string }
  | { kind: 'broker_down'; detail: string }
  | { kind: 'unknown_error'; detail: string };

export function validateAccount(
  deps: Deps,
  tenantId: string,
  account: AccountRow,
): void {
  setImmediate(() => {
    void runValidation(deps, tenantId, account).catch((err) => {
      deps.log.error(
        { err: (err as Error).message, account_id: account.id },
        'validator crashed',
      );
    });
  });
}

async function runValidation(
  deps: Deps,
  tenantId: string,
  account: AccountRow,
): Promise<void> {
  const now = Date.now();
  let plaintext: Buffer | null = null;
  try {
    plaintext = decrypt(
      deps.cfg.encryptionKey,
      tenantId,
      account.encrypted_creds,
    );
    const creds = {
      server: account.broker_server,
      login: account.broker_login,
      password: plaintext.toString('utf8'),
    };

    const result = await deps.connector.connect(creds);
    // Phase B: the validator only confirms the broker session opens.
    // Phase B-real: openTrade would also key off this accountRef.
    deps.accounts.updateStatus(
      tenantId,
      account.id,
      'active',
      now,
      null,
      now,
    );
    deps.log.info(
      {
        tenant_id: tenantId,
        account_id: account.id,
        accountRef: result.accountRef,
        broker: deps.cfg.connectorId,
      },
      'account validated',
    );
  } catch (e) {
    const msg = (e as Error).message;
    deps.accounts.updateStatus(tenantId, account.id, 'error', null, msg, now);
    deps.log.warn(
      { tenant_id: tenantId, account_id: account.id, err: msg },
      'account validation failed',
    );
  } finally {
    if (plaintext) plaintext.fill(0);
  }
}
