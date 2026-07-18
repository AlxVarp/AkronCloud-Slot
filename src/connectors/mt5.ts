import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Publisher, Subscriber, type Message } from 'zeromq';
import { z } from 'zod';
import { log } from '../log.js';
import type {
  AccountState,
  AccountEvent,
  BrokerConnector,
  BrokerCreds,
  BrokerEvent,
  Fill,
  NewOrder,
  OrderResult,
  Position,
  Quote,
  SymbolSpec,
  OrderStatus,
} from './base.js';
import type { AccountRow } from '../db/index.js';
import type { Database as DB } from 'better-sqlite3';
import type { Ledger } from '../ledger.js';

/**
 * MT5 broker connector (Phase B).
 *
 * Talks to the embedded MT5 terminal inside the same container
 * via the ZMQ pair documented in SPEC § 4.4:
 *
 *   - **Inbound** (`tcp://127.0.0.1:5557` by default — see
 *     `SLOT_MT5_ZMQ_IN_URL`): the embedded `PublisherZMQEvents.ex5`
 *     publishes fills, order_state changes and account_status to a
 *     ZMQ PUB socket. We SUB and route by `account_login`.
 *
 *   - **Outbound** (`tcp://127.0.0.1:5556` by default — see
 *     `SLOT_MT5_ZMQ_OUT_URL`): we PUB trade commands (login,
 *     place_order, close_position) to be picked up by a future
 *     `SlotCommandEA.mq5` EA that lives on the MT5 chart. That EA
 *     does not exist yet; for the time being outbound messages are
 *     silently dropped by ZMQ (no subscribers) and the connector
 *     synthesises an immediate `broker_order_id` for `openTrade`
 *     without waiting for a fill. The fill pipeline still works:
 *     when the user logs into MT5 via the KasmVNC iframe in
 *     `GET /connect` and trades manually, those fills arrive on
 *     the inbound socket and are persisted + streamed.
 *
 * Architecture: one `Mt5Connector` per slot (singleton via the
 * factory in `index.ts`). It holds per-account state in a Map
 * keyed by the deterministic `accountRef = "mt5-<server>-<login>"`.
 * Multiple accounts can be connected concurrently; each `stream()`
 * call filters events for the requested account.
 *
 * State-of-the-world sources:
 *   - inbound fills come from ZMQ and are persisted to the ledger
 *     by `services/mt5-zmq.ts` (started unconditionally in app.ts)
 *   - this connector runs its OWN additional ZMQ subscriber to
 *     feed its per-account event bus for `stream()`. The duplicate
 *     subscription is intentional: the global one owns persistence,
 *     this one owns fan-out. They're cheap and decoupled.
 *   - `positions()` derives from the ledger (`ledger.positionsFor`)
 *     so it is always consistent with what's been filled.
 */

const IN_URL = process.env.SLOT_MT5_ZMQ_IN_URL ?? 'tcp://127.0.0.1:5557';
const OUT_URL = process.env.SLOT_MT5_ZMQ_OUT_URL ?? 'tcp://127.0.0.1:5556';
const RECONNECT_DELAY_MS = 3_000;
const LOGIN_TIMEOUT_MS = 15_000;

const FillEvent = z.object({
  type: z.literal('fill'),
  account_login: z.union([z.string(), z.number()]).optional(),
  data: z.object({
    broker_order_id: z.string().optional(),
    symbol: z.string(),
    qty: z.number(),
    price: z.number(),
    fee: z.number().optional(),
    ts: z.number().optional(),
    side: z.enum(['buy', 'sell']).optional(),
  }),
});
const OrderStateEvent = z.object({
  type: z.literal('order_state'),
  account_login: z.union([z.string(), z.number()]).optional(),
  data: z.object({
    broker_order_id: z.string(),
    status: z.string(),
  }),
});
const AccountStatusEvent = z.object({
  type: z.literal('account_status'),
  account_login: z.union([z.string(), z.number()]).optional(),
  data: z.object({
    logged_in: z.boolean().optional(),
    balance: z.number().optional(),
    equity: z.number().optional(),
    last_error: z.string().optional(),
  }),
});
const AnyEvent = z.union([FillEvent, OrderStateEvent, AccountStatusEvent]);
type ParsedEvent = z.infer<typeof AnyEvent>;

export type Mt5ConnectorOpts = {
  /** DB handle (used only to resolve broker_login → account_id for positions()). */
  db: DB;
  /** Ledger (used for positions()). */
  ledger: Ledger;
  /** Override inbound URL (mostly for tests). */
  inUrl?: string;
  /** Override outbound URL (mostly for tests). */
  outUrl?: string;
};

type AccountRecord = {
  ref: string;
  broker_server: string;
  broker_login: string;
  loggedIn: boolean;
  balance: number;
  equity: number;
  lastError?: string;
};

function refFor(creds: BrokerCreds): string {
  return `mt5-${creds.server}-${creds.login}`;
}

export class Mt5Connector implements BrokerConnector {
  readonly id = 'mt5' as const;
  readonly displayName = 'mt5';

  private readonly accounts = new Map<string, AccountRecord>();
  private readonly bus = new EventEmitter();
  private readonly pub: Publisher;
  private readonly inUrl: string;
  private readonly outUrl: string;
  private readonly db: DB;
  private readonly ledger: Ledger;

  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private sub: Subscriber | null = null;

  constructor(opts: Mt5ConnectorOpts) {
    this.inUrl = opts.inUrl ?? IN_URL;
    this.outUrl = opts.outUrl ?? OUT_URL;
    this.db = opts.db;
    this.ledger = opts.ledger;
    this.pub = new Publisher();
    this.bus.setMaxListeners(0);
    void this.startOutbound();
    void this.startInbound();
  }

  // ────────────────────── lifecycle ──────────────────────

  async connect(creds: BrokerCreds): Promise<{ accountRef: string }> {
    const ref = refFor(creds);
    const rec: AccountRecord = {
      ref,
      broker_server: creds.server,
      broker_login: creds.login,
      loggedIn: false,
      balance: 0,
      equity: 0,
    };
    this.accounts.set(ref, rec);

    log.info(
      { ref, server: creds.server, login: creds.login },
      'mt5 connect: requesting broker login',
    );

    // Publish the login command. If no MQL5 subscriber EA is
    // attached yet this is dropped silently — the user is expected
    // to also have logged into MT5 via the KasmVNC form, in which
    // case the account_status event from PublisherZMQEvents will
    // arrive on the inbound socket and flip `loggedIn` below.
    try {
      await this.pub.send(
        JSON.stringify({
          type: 'login',
          server: creds.server,
          login: creds.login,
          password: creds.password,
          ts: Date.now(),
        }),
      );
    } catch (e) {
      log.warn(
        { ref, err: (e as Error).message },
        'mt5 outbound publish failed (no subscriber?)',
      );
    }

    // Emit a synthetic account=login event optimistically; the
    // real account_status from MT5 (if it arrives) will overwrite.
    const evt: AccountEvent = { kind: 'login' };
    this.emitToBus({ kind: 'account', data: evt }, ref);

    // Best-effort: wait briefly for an account_status event that
    // confirms the real login. If it doesn't arrive (e.g. the user
    // hasn't logged into MT5 yet via VNC) we still return the ref so
    // the rest of the slot can address this account; the login
    // detector + account_status events will flip the state later.
    const start = Date.now();
    while (Date.now() - start < LOGIN_TIMEOUT_MS) {
      if (rec.loggedIn) break;
      await sleep(250);
    }
    if (!rec.loggedIn) {
      log.warn(
        { ref, timeout_ms: LOGIN_TIMEOUT_MS },
        'mt5 connect timed out waiting for account_status (user may not have logged into MT5 yet)',
      );
    }
    return { accountRef: ref };
  }

  async disconnect(accountRef: string): Promise<void> {
    const rec = this.accounts.get(accountRef);
    if (!rec) return;
    this.accounts.delete(accountRef);
    try {
      await this.pub.send(
        JSON.stringify({
          type: 'logout',
          server: rec.broker_server,
          login: rec.broker_login,
          ts: Date.now(),
        }),
      );
    } catch (e) {
      log.warn(
        { accountRef, err: (e as Error).message },
        'mt5 outbound publish failed during disconnect',
      );
    }
    this.emitToBus(
      { kind: 'account', data: { kind: 'logout' } },
      accountRef,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sub) {
      try {
        await this.sub.close();
      } catch {
        /* ignore */
      }
    }
    try {
      await this.pub.close();
    } catch {
      /* ignore */
    }
  }

  // ────────────────────── queries ──────────────────────

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
      equity: rec.equity,
      lastError: rec.lastError,
    };
  }

  async symbols(_accountRef: string): Promise<SymbolSpec[]> {
    // v0: hardcoded EURUSD. Phase B-real will pull Symbols from MT5
    // via SymbolsTotal()/SymbolSelect()/SymbolInfoDouble().
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
    // v0: synthetic bid/ask. Phase B-real will read SymbolInfoDouble
    // on the MT5 side and emit a quote event on the inbound ZMQ.
    return {
      symbol,
      bid: 1.0832,
      ask: 1.0834,
      ts: Date.now(),
    };
  }

  async positions(accountRef: string): Promise<Position[]> {
    const row = this.lookupAccountRow(accountRef);
    if (!row) return [];
    // The ledger is the source of truth for what we know has been
    // filled. Map ledger.Position (subset) → connector.Position
    // (adds id + account_id, optional mark/unrealized).
    const positions = this.ledger.positionsFor(row.id);
    return positions.map((p, idx) => ({
      id: `pos-${row.id}-${p.instrument}-${idx}`,
      account_id: row.id,
      instrument: p.instrument,
      side: p.side,
      qty: p.qty,
      avg_price: p.avg_price,
    }));
  }

  async openTrade(
    accountRef: string,
    order: NewOrder,
  ): Promise<OrderResult> {
    const rec = this.accounts.get(accountRef);
    if (!rec) {
      return { ok: false, reason: 'unknown accountRef' };
    }
    const clientOrderId = randomUUID();
    try {
      await this.pub.send(
        JSON.stringify({
          type: 'place_order',
          client_order_id: clientOrderId,
          server: rec.broker_server,
          login: rec.broker_login,
          instrument: order.instrument,
          side: order.side,
          qty: order.qty,
          order_type: order.type,
          price: order.price,
          sl: order.sl,
          tp: order.tp,
          ts: Date.now(),
        }),
      );
    } catch (e) {
      return {
        ok: false,
        reason: `outbound publish failed: ${(e as Error).message}`,
      };
    }
    // v0: synthesise a broker_order_id. If a SlotCommandEA is
    // eventually attached it should include the real broker_order_id
    // in its ack (order_state event). For now, the user is expected
    // to place orders manually in MT5; this just queues the intent.
    const brokerOrderId = `pending-${clientOrderId}`;
    this.emitToBus(
      {
        kind: 'order_state',
        data: {
          order_id: brokerOrderId,
          status: 'pending' satisfies OrderStatus,
        },
      },
      accountRef,
    );
    return { ok: true, order_id: clientOrderId, broker_order_id: brokerOrderId };
  }

  async closeTrade(
    accountRef: string,
    positionId: string,
    qty?: number,
  ): Promise<OrderResult> {
    const rec = this.accounts.get(accountRef);
    if (!rec) {
      return { ok: false, reason: 'unknown accountRef' };
    }
    const clientOrderId = randomUUID();
    try {
      await this.pub.send(
        JSON.stringify({
          type: 'close_position',
          client_order_id: clientOrderId,
          server: rec.broker_server,
          login: rec.broker_login,
          position_id: positionId,
          qty,
          ts: Date.now(),
        }),
      );
    } catch (e) {
      return {
        ok: false,
        reason: `outbound publish failed: ${(e as Error).message}`,
      };
    }
    const brokerOrderId = `pending-${clientOrderId}`;
    this.emitToBus(
      {
        kind: 'order_state',
        data: {
          order_id: brokerOrderId,
          status: 'pending' satisfies OrderStatus,
        },
      },
      accountRef,
    );
    return { ok: true, order_id: clientOrderId, broker_order_id: brokerOrderId };
  }

  // ────────────────────── stream ──────────────────────

  async *stream(
    accountRef: string,
    signal: AbortSignal,
  ): AsyncIterable<BrokerEvent> {
    const queue: BrokerEvent[] = [];
    let resolveNext:
      | ((v: IteratorResult<BrokerEvent>) => void)
      | null = null;

    const onEvent = (e: BrokerEvent) => {
      if (resolveNext) {
        resolveNext({ value: e, done: false });
        resolveNext = null;
      } else {
        queue.push(e);
      }
    };
    const listener = (e: BrokerEvent, ref: string) => {
      if (ref !== accountRef) return;
      onEvent(e);
    };
    this.bus.on('event', listener);

    const onAbort = () => {
      if (resolveNext) {
        resolveNext({
          value: undefined as unknown as BrokerEvent,
          done: true,
        });
        resolveNext = null;
      }
      this.bus.off('event', listener);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      while (!signal.aborted) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        const ev: IteratorResult<BrokerEvent> = await new Promise(
          (res) => {
            resolveNext = res;
          },
        );
        if (ev.done) break;
        yield ev.value;
      }
    } finally {
      this.bus.off('event', listener);
      signal.removeEventListener('abort', onAbort);
    }
  }

  // ────────────────────── internals ──────────────────────

  private async startOutbound(): Promise<void> {
    try {
      await this.pub.bind(this.outUrl);
      log.info({ url: this.outUrl }, 'mt5 outbound publisher bound');
    } catch (e) {
      log.warn(
        { url: this.outUrl, err: (e as Error).message },
        'mt5 outbound bind failed (will retry on next send)',
      );
    }
  }

  private startInbound(): void {
    setTimeout(() => {
      void this.connectInbound();
    }, 1_000);
  }

  private async connectInbound(): Promise<void> {
    if (this.stopped) return;
    try {
      const sock = new Subscriber();
      await sock.connect(this.inUrl);
      await sock.subscribe('');
      this.sub = sock;
      log.info({ url: this.inUrl }, 'mt5 inbound subscriber connected');
      void (async (): Promise<void> => {
        while (!this.stopped) {
          try {
            const [msg] = (await sock.receive()) as [Message];
            this.handleMessage(msg);
          } catch (e) {
            log.warn(
              { err: (e as Error).message },
              'mt5 inbound receive error, will reconnect',
            );
            break;
          }
        }
      })();
    } catch (e) {
      log.warn(
        { url: this.inUrl, err: (e as Error).message },
        'mt5 inbound connect failed, will retry',
      );
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          void this.connectInbound();
        }, RECONNECT_DELAY_MS);
      }
    }
  }

  private handleMessage(raw: Message): void {
    const buf = Array.isArray(raw) ? raw[0] : raw;
    if (!buf) return;
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const result = AnyEvent.safeParse(parsed);
    if (!result.success) {
      const t =
        (parsed as { type?: string } | null)?.type ?? 'unknown';
      log.debug({ t }, 'mt5 inbound: ignoring event');
      return;
    }
    const evt = result.data;
    const brokerLogin = String(evt.account_login ?? '');
    if (!brokerLogin) {
      log.debug({ evt }, 'mt5 inbound: missing account_login');
      return;
    }
    const ref = this.findRefByLogin(brokerLogin);
    if (!ref) {
      log.debug(
        { brokerLogin, type: evt.type },
        'mt5 inbound: unknown account',
      );
      return;
    }
    const rec = this.accounts.get(ref);
    if (rec) this.applyEventToRecord(rec, evt);
    this.forwardEventToBus(evt, ref);
  }

  private applyEventToRecord(rec: AccountRecord, evt: ParsedEvent): void {
    if (evt.type === 'account_status') {
      const d = evt.data;
      if (typeof d.logged_in === 'boolean') rec.loggedIn = d.logged_in;
      if (typeof d.balance === 'number') rec.balance = d.balance;
      if (typeof d.equity === 'number') rec.equity = d.equity;
      if (typeof d.last_error === 'string') rec.lastError = d.last_error;
    }
  }

  private forwardEventToBus(evt: ParsedEvent, ref: string): void {
    if (evt.type === 'fill') {
      const fill: Fill = {
        broker_order_id: evt.data.broker_order_id ?? '',
        symbol: evt.data.symbol,
        qty: evt.data.qty,
        price: evt.data.price,
        fee: evt.data.fee,
        ts: evt.data.ts ?? Date.now(),
      };
      this.emitToBus({ kind: 'fill', data: fill }, ref);
    } else if (evt.type === 'order_state') {
      this.emitToBus(
        {
          kind: 'order_state',
          data: {
            order_id: evt.data.broker_order_id,
            status: evt.data.status as OrderStatus,
          },
        },
        ref,
      );
    } else if (evt.type === 'account_status') {
      const d = evt.data;
      if (typeof d.logged_in === 'boolean') {
        this.emitToBus(
          {
            kind: 'account',
            data: { kind: d.logged_in ? 'login' : 'logout' },
          },
          ref,
        );
      } else if (d.last_error) {
        this.emitToBus(
          {
            kind: 'account',
            data: { kind: 'error', detail: d.last_error },
          },
          ref,
        );
      }
    }
  }

  private emitToBus(e: BrokerEvent, ref: string): void {
    this.bus.emit('event', e, ref);
  }

  private findRefByLogin(brokerLogin: string): string | undefined {
    for (const rec of this.accounts.values()) {
      if (rec.broker_login === brokerLogin) return rec.ref;
    }
    return undefined;
  }

  private lookupAccountRow(accountRef: string): AccountRow | undefined {
    const rec = this.accounts.get(accountRef);
    if (!rec) return undefined;
    return this.db
      .prepare(
        `SELECT * FROM accounts
         WHERE broker_server = ? AND broker_login = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(rec.broker_server, rec.broker_login) as AccountRow | undefined;
  }
}
