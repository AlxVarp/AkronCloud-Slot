import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  BrokerConnector,
  AccountState,
  AccountEvent,
  BrokerEvent,
  BrokerCreds,
  Fill,
  NewOrder,
  OrderResult,
  Position,
  Quote,
  SymbolSpec,
  OrderStatus,
} from './base';

/**
 * In-process broker simulator. Implements the same BrokerConnector
 * interface the real MT5 connector will satisfy.
 *
 * Behaviors:
 *  - connect() always succeeds (a 50 ms simulated login delay).
 *  - openTrade() with type='market' resolves immediately and a
 *    fill is emitted 100 ms later on stream().
 *  - openTrade() with type='limit' parks at status='pending' and a
 *    fill is emitted 800 ms later (simulating a quick fill).
 *  - closeTrade() halves the position and emits a fill.
 *  - stream() is an AsyncIterable fed by an internal EventEmitter;
 *    multiple listeners share the same backing bus. Each call
 *    yields a fresh iterator over the same bus; the bus is alive
 *    for the lifetime of the connector instance.
 *
 * Determinism: market data, fill prices and event ordering are
 * driven by a small synthetic market seeded from `Math.random`. We
 * do NOT seed from a fixed value so tests can run concurrently.
 * For deterministic tests, use the `seededRandomForTests` knob.
 */

type SimAccountRef = {
  id: string;
  broker_server: string;
  broker_login: string;
  initial_balance: number;
};

export type SimOptions = {
  /** if set, used for fill prices so tests can be deterministic. */
  rng?: () => number;
  /** synthetic initial USD balance (default 100 000). */
  initialBalance?: number;
  /** ms between `openTrade` and its fill (default 100). */
  fillDelayMs?: number;
  /** ms between a limit order entry and the simulated fill (default 800). */
  limitFillDelayMs?: number;
};

type AccountRecord = {
  ref: SimAccountRef;
  loggedIn: boolean;
  positions: Map<
    string,
    { side: 'long' | 'short'; qty: number; avg_price: number }
  >;
  /** synthetic balance, separate from positions */
  balance: number;
};

export class SimConnector implements BrokerConnector {
  readonly id = 'mt5' as const;
  readonly displayName = 'sim-mt5';

  private readonly accounts = new Map<string, AccountRecord>();
  private readonly bus = new EventEmitter();

  private readonly rng: () => number;
  private readonly initialBalance: number;
  private readonly fillDelayMs: number;
  private readonly limitFillDelayMs: number;

  constructor(opts: SimOptions = {}) {
    this.rng = opts.rng ?? Math.random;
    this.initialBalance = opts.initialBalance ?? 100_000;
    this.fillDelayMs = opts.fillDelayMs ?? 100;
    this.limitFillDelayMs = opts.limitFillDelayMs ?? 800;
    this.bus.setMaxListeners(0);
  }

  async connect(creds: BrokerCreds): Promise<{ accountRef: string }> {
    await sleep(50);
    // Derive the accountRef deterministically from (server, login) so
    // rest.ts can address the same session via `sim-<server>-<login>`
    // without keeping a side-table. The ref id is what the rest of
    // the slot uses to dispatch orders/positions/state calls.
    const ref: SimAccountRef = {
      id: `sim-${creds.server}-${creds.login}`,
      broker_server: creds.server,
      broker_login: creds.login,
      initial_balance: this.initialBalance,
    };
    this.accounts.set(ref.id, {
      ref,
      loggedIn: true,
      positions: new Map(),
      balance: this.initialBalance,
    });
    void randomUUID; // (kept available for future fresh-id refactors)
    const evt: AccountEvent = { kind: 'login' };
    this.emit({ kind: 'account', data: evt });
    return { accountRef: ref.id };
  }

  async disconnect(accountRef: string): Promise<void> {
    const rec = this.accounts.get(accountRef);
    if (!rec) return;
    this.accounts.delete(accountRef);
    this.emit({
      kind: 'account',
      data: { kind: 'logout' satisfies AccountEvent['kind'] },
    });
  }

  async state(accountRef: string): Promise<AccountState> {
    const rec = this.accounts.get(accountRef);
    if (!rec) {
      return {
        accountRef,
        loggedIn: false,
        lastError: 'unknown accountRef',
      };
    }
    return {
      accountRef,
      loggedIn: rec.loggedIn,
      balance: rec.balance,
      margin: 0,
    };
  }

  async symbols(_accountRef: string): Promise<SymbolSpec[]> {
    return [
      {
        symbol: 'EURUSD',
        digits: 5,
        min_lot: 0.01,
        max_lot: 100,
        lot_step: 0.01,
        currency: 'USD',
      },
    ];
  }

  async quote(_accountRef: string, symbol: string): Promise<Quote> {
    return {
      symbol,
      bid: roundN(1.0832 + (this.rng() - 0.5) * 0.0004, 5),
      ask: roundN(1.0834 + (this.rng() - 0.5) * 0.0004, 5),
      ts: Date.now(),
    };
  }

  async positions(accountRef: string): Promise<Position[]> {
    const rec = this.accounts.get(accountRef);
    if (!rec) return [];
    const out: Position[] = [];
    for (const [instrument, p] of rec.positions) {
      if (p.qty < 1e-9) continue;
      out.push({
        id: `sim-pos-${instrument}`,
        account_id: accountRef,
        instrument,
        side: p.side,
        qty: p.qty,
        avg_price: p.avg_price,
        mark_price: p.avg_price + (this.rng() - 0.5) * 0.0004,
      });
    }
    return out;
  }

  async openTrade(
    accountRef: string,
    order: NewOrder,
  ): Promise<OrderResult> {
    const rec = this.accounts.get(accountRef);
    if (!rec) {
      return { ok: false, reason: 'unknown accountRef' };
    }
    const broker_order_id = 'sim-ord-' + randomUUID();
    const isLimit = order.type === 'limit';
    const ts_open = Date.now();
    void ts_open;
    this.emit({
      kind: 'order_state',
      data: { order_id: broker_order_id, status: 'pending' satisfies OrderStatus },
    });

    const delayMs = isLimit ? this.limitFillDelayMs : this.fillDelayMs;
    setTimeout(() => {
      const fillPrice = order.price ?? roundN(1.0833 + (this.rng() - 0.5) * 0.0004, 5);
      const fill: Fill = {
        broker_order_id,
        symbol: order.instrument,
        qty: order.qty,
        price: fillPrice,
        fee: 0,
        ts: Date.now(),
      };
      // Update synthetic position state.
      const cur = rec.positions.get(order.instrument);
      const sign = order.side === 'buy' ? 1 : -1;
      if (!cur) {
        rec.positions.set(order.instrument, {
          side: sign > 0 ? 'long' : 'short',
          qty: order.qty,
          avg_price: fillPrice,
        });
      } else {
        const newQty = cur.qty * (cur.side === 'long' ? 1 : -1) + sign * order.qty;
        if (Math.sign(newQty) === Math.sign(cur.side === 'long' ? 1 : -1) || newQty === 0) {
          // opened more or closed. weighted avg when adding.
          if (newQty === 0) {
            rec.positions.delete(order.instrument);
          } else {
            const newSide = newQty > 0 ? 'long' : 'short';
            const absQty = Math.abs(newQty);
            const sameDirection = (newSide === 'long') === (cur.side === 'long');
            const avg = sameDirection
              ? (cur.avg_price * cur.qty + fillPrice * order.qty) /
                (cur.qty + order.qty)
              : fillPrice;
            rec.positions.set(order.instrument, {
              side: newSide,
              qty: absQty,
              avg_price: avg,
            });
          }
        } else {
          // crossed through zero — flip side
          const flippedQty = Math.abs(newQty);
          rec.positions.set(order.instrument, {
            side: newQty > 0 ? 'long' : 'short',
            qty: flippedQty,
            avg_price: fillPrice,
          });
        }
      }
      this.emit({
        kind: 'order_state',
        data: { order_id: broker_order_id, status: 'filled' satisfies OrderStatus },
      });
      this.emit({ kind: 'fill', data: fill });
    }, delayMs).unref?.();

    return { ok: true, order_id: broker_order_id, broker_order_id };
  }

  async closeTrade(
    accountRef: string,
    positionId: string,
    qty?: number,
  ): Promise<OrderResult> {
    const rec = this.accounts.get(accountRef);
    if (!rec) return { ok: false, reason: 'unknown accountRef' };
    // positionId is "sim-pos-<instrument>" per our convention
    const instrument = positionId.replace(/^sim-pos-/, '');
    const pos = rec.positions.get(instrument);
    if (!pos) return { ok: false, reason: 'no position to close' };
    const closeQty = qty ?? pos.qty;
    const side = pos.side === 'long' ? 'sell' : 'buy';
    return this.openTrade(accountRef, {
      instrument,
      side,
      qty: closeQty,
      type: 'market',
    });
  }

  async *stream(
    _accountRef: string,
    signal: AbortSignal,
  ): AsyncIterable<BrokerEvent> {
    const queue: BrokerEvent[] = [];
    let resolveNext: ((v: IteratorResult<BrokerEvent>) => void) | null = null;

    const onEvent = (e: BrokerEvent) => {
      if (resolveNext) {
        resolveNext({ value: e, done: false });
        resolveNext = null;
      } else {
        queue.push(e);
      }
    };
    this.bus.on('event', onEvent);

    const onAbort = () => {
      if (resolveNext) {
        resolveNext({ value: undefined as unknown as BrokerEvent, done: true });
        resolveNext = null;
      }
      this.bus.off('event', onEvent);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      while (!signal.aborted) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        const ev: IteratorResult<BrokerEvent> = await new Promise((res) => {
          resolveNext = res;
        });
        if (ev.done) break;
        yield ev.value;
      }
    } finally {
      this.bus.off('event', onEvent);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private emit(e: BrokerEvent): void {
    this.bus.emit('event', e);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function roundN(x: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(x * m) / m;
}
