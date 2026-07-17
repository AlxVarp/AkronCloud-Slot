/**
 * Ledger — orders + fills persistence, positions derived view (SPEC § 3).
 *
 * Phase A: scaffold only. Phase B wires the MT5 connector's fill/order
 * events through these stores and feeds the reconciler.
 */

export type LedgerStore = {
  // Insert an order row, returning the persisted id (matches what we
  // passed in for Phase A; Phase B may swap to a different shape).
  recordOrder: (order: {
    account_id: string;
    instrument: string;
    side: 'buy' | 'sell';
    qty: number;
    type: 'market' | 'limit' | 'stop';
  }) => string;

  recordFill: (fill: {
    order_id: string;
    account_id: string;
    instrument: string;
    qty: number;
    price: number;
    fee?: number;
    ts: number;
  }) => string;

  // Compute open positions from orders + fills on demand.
  positionsFor: (account_id: string) => Array<{
    instrument: string;
    side: 'long' | 'short';
    qty: number;
    avg_price: number;
  }>;
};
