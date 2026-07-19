import type { BrokerConnector } from './base.js';
import { SimConnector, type SimOptions } from './sim.js';
import { Mt5Connector, type Mt5ConnectorOpts } from './mt5.js';
import type { Database as DB } from 'better-sqlite3';
import type { Ledger } from '../ledger.js';

/**
 * Connector registry.
 *
 * The factory pattern lets us lazily load native deps (the real MT5
 * connector pulls in `zeromq` only when actually used).
 *
 * `sim` — in-process simulator, no native deps.
 * `mt5` — real ZMQ-backed connector to the embedded MT5 terminal.
 *   Requires `db` + `ledger` in the opts (see Mt5ConnectorOpts).
 */
export const CONNECTORS: Record<
  string,
  (opts?: unknown) => BrokerConnector
> = {
  sim: (opts) =>
    new SimConnector(((opts ?? {}) as SimOptions) ?? {}),
  mt5: (opts) => {
    const o = (opts ?? {}) as Mt5ConnectorOpts;
    if (!o.db || !o.ledger) {
      throw new Error(
        'mt5 connector requires { db, ledger } in factory opts',
      );
    }
    return new Mt5Connector(o);
  },
};

/** Convenience opts shape passed by app.ts to makeConnector. */
export type ConnectorFactoryOpts = {
  db?: DB;
  ledger?: Ledger;
};

export function makeConnector(
  id: string,
  opts?: ConnectorFactoryOpts,
): BrokerConnector {
  const factory = CONNECTORS[id];
  if (!factory) {
    throw new Error(
      `Unknown connector id=${id}. Registered: ${Object.keys(CONNECTORS).join(', ')}`,
    );
  }
  return factory(opts);
}

export type { SimConnector, SimOptions, Mt5Connector, Mt5ConnectorOpts };
