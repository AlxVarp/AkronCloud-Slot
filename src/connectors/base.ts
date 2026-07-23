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

/** Optional filter for `symbols()`. MQL5 SlotService.action='symbols'. */
export type SymbolsQueryOpts = {
  /** Glob-style pattern (e.g. "EUR*", "*USD"). Empty = all. */
  pattern?: string;
  /** Only symbols currently in Market Watch (vs all server symbols). */
  marketWatchOnly?: boolean;
};

/** Optional filter for `history()`. MQL5 SlotService.action='history'. */
export type HistoryQueryOpts = {
  /** Lower bound (epoch ms). Undefined = server default. */
  from?: number;
  /** Upper bound (epoch ms). Undefined = server default. */
  to?: number;
  /** Max rows (server applies its own cap if larger). */
  limit?: number;
};

/** Minimal symbol spec shape returned by MQL5 `symbol` action. Fields are
 *  optional because the broker may not fill all of them. */
export type SymbolDetail = {
  symbol: string;
  digits?: number;
  point?: number;
  min_lot?: number;
  max_lot?: number;
  lot_step?: number;
  currency_base?: string;
  currency_profit?: string;
  currency_margin?: string;
  description?: string;
  path?: string;
  [k: string]: unknown;
};

/** Minimal broker order shape returned by MQL5 `orders` action. */
export type BrokerOrder = {
  ticket: number | string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop';
  volume: number;
  price_open?: number;
  sl?: number;
  tp?: number;
  state?: string;
  ts_open?: number;
  ts_close?: number | null;
  comment?: string;
  [k: string]: unknown;
};

/** Minimal broker position shape returned by MQL5 `positions` action. */
export type BrokerPosition = {
  ticket: number | string;
  symbol: string;
  side: 'buy' | 'sell';
  volume: number;
  price_open: number;
  price_current?: number;
  sl?: number;
  tp?: number;
  profit?: number;
  swap?: number;
  commission?: number;
  ts_open?: number;
  magic?: number;
  comment?: string;
  [k: string]: unknown;
};

/** Minimal deal/history shape returned by MQL5 `history` action. */
export type BrokerDeal = {
  ticket: number | string;
  order_ticket?: number | string;
  symbol: string;
  side: 'buy' | 'sell';
  type?: string;
  volume: number;
  price: number;
  profit?: number;
  commission?: number;
  swap?: number;
  fee?: number;
  ts: number;
  comment?: string;
  [k: string]: unknown;
};

/** Account summary returned by MQL5 `account` action. */
export type AccountInfo = {
  login: number | string;
  server?: string;
  currency?: string;
  leverage?: number;
  balance?: number;
  equity?: number;
  margin?: number;
  margin_free?: number;
  margin_level?: number;
  profit?: number;
  name?: string;
  company?: string;
  trade_allowed?: boolean;
  [k: string]: unknown;
};

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
  symbols(accountRef: string, opts?: SymbolsQueryOpts): Promise<SymbolSpec[]>;
  quote(accountRef: string, symbol: string): Promise<Quote>;
  positions(accountRef: string): Promise<Position[]>;

  openTrade(accountRef: string, order: NewOrder): Promise<OrderResult>;
  closeTrade(
    accountRef: string,
    positionId: string,
    qty?: number,
  ): Promise<OrderResult>;

  // ── v0.4 query/manage methods (MT5 SlotService 12 actions) ──

  /** MQL5 action='account' → AccountInfo. */
  getAccount(accountRef: string): Promise<AccountInfo>;

  /** MQL5 action='positions' → raw broker positions (MT5-truth). */
  getPositions(accountRef: string): Promise<BrokerPosition[]>;

  /** MQL5 action='symbol' → full SymbolDetail. */
  getSymbol(accountRef: string, symbol: string): Promise<SymbolDetail>;

  /** MQL5 action='orders' → pending orders on this account. */
  getOrders(accountRef: string): Promise<BrokerOrder[]>;

  /** MQL5 action='history' → deals in range. */
  getHistory(
    accountRef: string,
    opts?: HistoryQueryOpts,
  ): Promise<BrokerDeal[]>;

  /** MQL5 action='sltp' → modify SL/TP of a pending order. */
  modifyOrder(
    accountRef: string,
    orderId: string,
    sl: number | null,
    tp: number | null,
  ): Promise<{ ok: boolean; reason?: string }>;

  /** MQL5 action='modify_position' → modify SL/TP of an open position. */
  modifyPosition(
    accountRef: string,
    positionId: string,
    sl: number | null,
    tp: number | null,
  ): Promise<{ ok: boolean; reason?: string }>;

  /** MQL5 action='cancel' → cancel a pending order. */
  cancelOrder(
    accountRef: string,
    orderId: string,
  ): Promise<{ ok: boolean; reason?: string }>;

  stream(accountRef: string, signal: AbortSignal): AsyncIterable<BrokerEvent>;
}
