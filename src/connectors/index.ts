import type { BrokerConnector } from './base.js';
import { SimConnector, type SimOptions } from './sim.js';
import { Mt5Connector, type Mt5ConnectorOpts } from './mt5.js';
import type { Database as DB } from 'better-sqlite3';
import type { Ledger } from '../ledger.js';
import type { Mt5TcpServer } from '../services/mt5-tcp-server.js';

/**
 * Connector registry.
 *
 * `sim` — in-process simulator, no native deps.
 * `mt5` — TCP-backed connector to the embedded MT5 terminal via
 *   `services/mt5-tcp-server.ts`. Requires `db` + `ledger` + `tcp`.
 */
export const CONNECTORS: Record<
  string,
  (opts?: unknown) => BrokerConnector
> = {
  sim: (opts) =>
    new SimConnector(((opts ?? {}) as SimOptions) ?? {}),
  mt5: (opts) => {
    const o = (opts ?? {}) as Mt5ConnectorOpts;
    if (!o.db || !o.ledger || !o.tcp) {
      throw new Error(
        'mt5 connector requires { db, ledger, tcp } in factory opts',
      );
    }
    return new Mt5Connector(o);
  },
};

/** Convenience opts shape passed by app.ts to makeConnector. */
export type ConnectorFactoryOpts = {
  db?: DB;
  ledger?: Ledger;
  tcp?: Mt5TcpServer;
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