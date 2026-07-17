import type { BrokerConnector } from './base';

/**
 * Connector registry. Phase A has no concrete connector; Phase B
 * registers `mt5` here.
 *
 * The "factory" pattern lets us lazily load native deps (e.g., the
 * MT5 ZMQ bridge) only when the connector is actually used.
 */
export const CONNECTORS: Record<string, () => Promise<BrokerConnector>> = {
  // 'mt5': () => import('./mt5').then((m) => new m.Mt5Connector()),
};

export async function makeConnector(id: string): Promise<BrokerConnector> {
  const factory = CONNECTORS[id];
  if (!factory) {
    throw new Error(
      `Unknown connector id=${id}. Registered: ${Object.keys(CONNECTORS).join(', ')}`,
    );
  }
  return factory();
}
