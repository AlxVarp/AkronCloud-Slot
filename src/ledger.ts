import type { Database as DB, Statement } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

/**
 * Ledger — concrete orders + fills persistence, with positions
 * derived from the two tables on every read. SPEC § 3.
 *
 * Stored fields line up 1:1 with src/db/migrations/0001_init.sql.
 */

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';
export type OrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected';

export type NewOrderRow = {
  id?: string;
  account_id: string;
  instrument: string;
  side: OrderSide;
  qty: number;
  type: OrderType;
  price?: number | null;
  sl?: number | null;
  tp?: number | null;
  reduce_qty?: number | null;
  status: OrderStatus;
  broker_order_id?: string | null;
  ts_open?: number | null;
  ts_close?: number | null;
};

export type OrderRow = Required<NewOrderRow> & {
  id: string;
  created_at: number;
};

export type FillRow = {
  id: string;
  order_id: string | null;
  account_id: string;
  instrument: string;
  qty: number;
  price: number;
  fee: number | null;
  ts: number;
};

export type Position = {
  instrument: string;
  side: 'long' | 'short';
  qty: number;
  avg_price: number;
};

const SQL_INSERT_ORDER = `
  INSERT INTO orders (
    id, account_id, instrument, side, qty, type, price, sl, tp,
    reduce_qty, status, broker_order_id, ts_open, ts_close
  ) VALUES (
    @id, @account_id, @instrument, @side, @qty, @type, @price, @sl, @tp,
    @reduce_qty, @status, @broker_order_id, @ts_open, @ts_close
  )
`;

const SQL_GET_ORDER = `SELECT * FROM orders WHERE id = ? AND account_id = ?`;
const SQL_LIST_ORDERS_BY_ACCOUNT = `
  SELECT * FROM orders
   WHERE account_id = ?
   ORDER BY ts_open DESC
   LIMIT ?
`;
const SQL_UPDATE_ORDER_STATUS = `
  UPDATE orders
     SET status = @status,
         broker_order_id = COALESCE(@broker_order_id, broker_order_id),
         ts_close = COALESCE(@ts_close, ts_close)
   WHERE id = @id AND account_id = @account_id
`;

const SQL_INSERT_FILL = `
  INSERT INTO fills (id, order_id, account_id, instrument, qty, price, fee, ts)
  VALUES (@id, @order_id, @account_id, @instrument, @qty, @price, @fee, @ts)
`;
const SQL_LIST_FILLS_BY_ACCOUNT = `
  SELECT * FROM fills WHERE account_id = ? ORDER BY ts DESC LIMIT ?
`;
const SQL_FILLS_FOR_ORDER = `SELECT * FROM fills WHERE order_id = ?`;

export type Ledger = {
  insertOrder: (row: NewOrderRow) => OrderRow;
  getOrder: (account_id: string, id: string) => OrderRow | undefined;
  getOrderByBrokerId: (
    account_id: string,
    broker_order_id: string,
  ) => OrderRow | undefined;
  listOrders: (
    account_id: string,
    limit?: number,
  ) => OrderRow[];
  updateOrderStatus: (
    account_id: string,
    id: string,
    status: OrderStatus,
    brokerOrderId?: string | null,
    tsClose?: number | null,
  ) => void;

  insertFill: (row: Omit<FillRow, 'id'>) => FillRow;
  listFills: (account_id: string, limit?: number) => FillRow[];
  fillsForOrder: (order_id: string) => FillRow[];

  /**
   * Derive open positions from orders+fills. Net long/short per
   * instrument, weighted-average price over the open fills.
   */
  positionsFor: (account_id: string) => Position[];
};

export const makeLedger = (db: DB): Ledger => {
  const insertOrderStmt: Statement = db.prepare(SQL_INSERT_ORDER);
  const getOrderStmt = db.prepare(SQL_GET_ORDER);
  const listOrdersStmt = db.prepare(SQL_LIST_ORDERS_BY_ACCOUNT);
  const updateOrderStatusStmt = db.prepare(SQL_UPDATE_ORDER_STATUS);
  const insertFillStmt = db.prepare(SQL_INSERT_FILL);
  const listFillsStmt = db.prepare(SQL_LIST_FILLS_BY_ACCOUNT);
  const fillsForOrderStmt = db.prepare(SQL_FILLS_FOR_ORDER);
  const getOrderByBrokerIdStmt = db.prepare(
    `SELECT * FROM orders WHERE broker_order_id = ? AND account_id = ?`,
  );

  return {
    insertOrder(row: NewOrderRow): OrderRow {
      const now = Date.now();
      const r: OrderRow = {
        id: row.id ?? randomUUID(),
        account_id: row.account_id,
        instrument: row.instrument,
        side: row.side,
        qty: row.qty,
        type: row.type,
        price: row.price ?? null,
        sl: row.sl ?? null,
        tp: row.tp ?? null,
        reduce_qty: row.reduce_qty ?? null,
        status: row.status,
        broker_order_id: row.broker_order_id ?? null,
        ts_open: row.ts_open ?? now,
        ts_close: row.ts_close ?? null,
        created_at: now,
      };
      insertOrderStmt.run(r);
      return r;
    },

    getOrder(account_id: string, id: string): OrderRow | undefined {
      return getOrderStmt.get(id, account_id) as OrderRow | undefined;
    },

    getOrderByBrokerId(
      account_id: string,
      broker_order_id: string,
    ): OrderRow | undefined {
      return getOrderByBrokerIdStmt.get(broker_order_id, account_id) as
        | OrderRow
        | undefined;
    },

    listOrders(account_id: string, limit = 100): OrderRow[] {
      return listOrdersStmt.all(account_id, limit) as OrderRow[];
    },

    updateOrderStatus(
      account_id: string,
      id: string,
      status: OrderStatus,
      brokerOrderId?: string | null,
      tsClose?: number | null,
    ): void {
      updateOrderStatusStmt.run({
        id,
        account_id,
        status,
        broker_order_id: brokerOrderId ?? null,
        ts_close: tsClose ?? null,
      });
    },

    insertFill(row: Omit<FillRow, 'id'>): FillRow {
      const id = randomUUID();
      const f: FillRow = { id, ...row };
      insertFillStmt.run(f);
      return f;
    },

    listFills(account_id: string, limit = 200): FillRow[] {
      return listFillsStmt.all(account_id, limit) as FillRow[];
    },

    fillsForOrder(order_id: string): FillRow[] {
      return fillsForOrderStmt.all(order_id) as FillRow[];
    },

    positionsFor(account_id: string): Position[] {
      // Use the FILL stream as ground truth for qty/avg-price, since
      // partial fills are the common case. We net by instrument.
      const rows = db
        .prepare(
          `SELECT instrument,
                  qty, price, side, order_id, ts
             FROM fills
            WHERE account_id = ?
            ORDER BY ts ASC`,
        )
        .all(account_id) as Array<{
        instrument: string;
        qty: number;
        price: number;
        side: OrderSide;
        order_id: string;
        ts: number;
      }>;

      // Net lots per instrument. Buy +qty, sell -qty.
      const lots = new Map<string, number>();
      const sumPx = new Map<string, number>();
      for (const f of rows) {
        const sign = f.side === 'buy' ? 1 : -1;
        lots.set(
          f.instrument,
          (lots.get(f.instrument) ?? 0) + sign * f.qty,
        );
        sumPx.set(
          f.instrument,
          (sumPx.get(f.instrument) ?? 0) + sign * f.qty * f.price,
        );
      }
      const positions: Position[] = [];
      for (const [instrument, qty] of lots) {
        if (Math.abs(qty) < 1e-9) continue;
        const avg = (sumPx.get(instrument) ?? 0) / qty;
        positions.push({
          instrument,
          side: qty > 0 ? 'long' : 'short',
          qty: Math.abs(qty),
          avg_price: avg,
        });
      }
      return positions;
    },
  };
};
