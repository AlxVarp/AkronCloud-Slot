import type { BrokerConnector } from './base.js';
import { SimConnector, type SimOptions } from './sim.js';

/**
 * Connector registry. Phase B ships the in-process `sim` connector
 * and keeps the real `mt5` entry as a stub that throws once Phase
 * B-real lands against the akron-mt5-base runtime's ZMQ bridge.
 *
 * The factory pattern lets us lazily load native deps (the real MT5
 * connector pulls in `zeromq` only when actually used).
 */
export const CONNECTORS: Record<
  string,
  (opts?: unknown) => BrokerConnector
> = {
  sim: (opts) =>
    new SimConnector(((opts ?? {}) as SimOptions) ?? {}),
  mt5: () => {
    throw new Error(
      'mt5 connector is not yet wired — see src/PHASE_B_TODO.ts. ' +
        'Set SLOT_CONNECTOR=sim for now.',
    );
  },
};

export function makeConnector(id: string, opts?: unknown): BrokerConnector {
  const factory = CONNECTORS[id];
  if (!factory) {
    throw new Error(
      `Unknown connector id=${id}. Registered: ${Object.keys(CONNECTORS).join(', ')}`,
    );
  }
  return factory(opts);
}

export type { SimConnector, SimOptions };
