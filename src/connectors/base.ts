/**
 * BrokerConnector — pluggable MT5 / IBKR / Alpaca bridge. Phase A
 * ships only the interface; the MT5 impl lands in Phase B (see
 * SPEC.md § 4).
 *
 * All methods take an opaque `accountRef` returned by `connect()` so
 * the connector can hold its own state per account. Callers should
 * not assume anything about its shape.
 */

export type Quote = {
  symbol: string;
  bid: number;
  ask: number;
  ts: number;
};

export type SymbolSpec = {
  symbol: string;
  digits: number;
  min_lot: number;
  max_lot: number;
  lot_step: number;
  currency: string;
};

export type Position = {
  id: string;
  account_id: string;
  instrument: string;
  side: 'long' | 'short';
  qty: number;
  avg_price: number;
  mark_price?: number;
  unrealized_pnl?: number;
};

export type NewOrder = {
  instrument: string;
  side: 'buy' | 'sell';
  qty: number;
  type: 'market' | 'limit' | 'stop';
  price?: number;
  sl?: number;
  tp?: number;
  reduce_qty?: number;
};

export type OrderResult =
  | { ok: true; order_id: string; broker_order_id: string }
  | { ok: false; reason: string };

export type OrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected';

export type BrokerCreds = {
  server: string;
  login: string;
  /** plaintext in memory; ciphertext lives in the slot DB. */
  password: string;
};

export type Fill = {
  broker_order_id: string;
  symbol: string;
  qty: number;
  price: number;
  fee?: number;
  ts: number;
};

export type AccountEvent = {
  kind: 'login' | 'logout' | 'margin_call' | 'password_reset' | 'error';
  detail?: string;
};

export type BrokerEvent =
  | { kind: 'fill'; data: Fill }
  | { kind: 'order_state'; data: { order_id: string; status: OrderStatus } }
  | { kind: 'account'; data: AccountEvent };

export type AccountState = {
  accountRef: string;
  loggedIn: boolean;
  equity?: number;
  balance?: number;
  margin?: number;
  lastError?: string;
};

export interface BrokerConnector {
  readonly id: 'mt5';
  readonly displayName: string;

  connect(creds: BrokerCreds): Promise<{ accountRef: string }>;
  disconnect(accountRef: string): Promise<void>;

  state(accountRef: string): Promise<AccountState>;
  symbols(accountRef: string): Promise<SymbolSpec[]>;
  quote(accountRef: string, symbol: string): Promise<Quote>;
  positions(accountRef: string): Promise<Position[]>;

  openTrade(accountRef: string, order: NewOrder): Promise<OrderResult>;
  closeTrade(
    accountRef: string,
    positionId: string,
    qty?: number,
  ): Promise<OrderResult>;

  stream(accountRef: string, signal: AbortSignal): AsyncIterable<BrokerEvent>;
}
