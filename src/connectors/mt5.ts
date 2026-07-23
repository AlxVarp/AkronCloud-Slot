import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
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
import type { Mt5TcpServer } from '../services/mt5-tcp-server.js';
import type { ParsedEvent } from '../services/mt5-tcp-server.js';

/**
 * MT5 broker connector (Phase C).
 *
 * Talks to the embedded MT5 terminal via the Phase C TCP bridge
 * (`services/mt5-tcp-server.ts`). MQL5 side is `SlotService.mq5`
 * compiled as a `#property service`. No chart-attached EAs, no ZMQ.
 *
 * Wire protocol: newline-delimited JSON over `127.0.0.1:7778`. See
 * `docs/plans/PHASE_C_RTA_B1_TCP_SOCKET.md` §2 for the full spec.
 *
 *   - Outbound commands (login/place_order/close_position) →
 *     `tcp.dispatchCommand({type:"command", action, payload})` →
 *     returns the MQL5 handler's JSON result.
 *
 *   - Inbound events (fills/order_state/account) ←
 *     `tcp.onEvent` callback → forwarded to the per-account bus
 *     for `stream()` consumers.
 *
 * Architecture: one `Mt5Connector` per slot. Holds per-account
 * state in a Map keyed by `accountRef = "mt5-<server>-<login>"`.
 * Multiple accounts can be connected concurrently; each `stream()`
 * call filters events for the requested account.
 *
 * State-of-the-world sources:
 *   - inbound fills come from the TCP server and are persisted to
 *     the ledger by `services/mt5-tcp-server.ts` (which also owns
 *     the on-event callback registration).
 *   - positions() derives from the ledger (`ledger.positionsFor`)
 *     so it is always consistent with what's been filled.
 *   - state() reads from a local cache updated by the TCP server's
 *     account_status events (sent by MQL5 when
 *     `TerminalInfoInteger(TERMINAL_CONNECTED)` flips).
 */

const LOGIN_TIMEOUT_MS = 15_000;

export type Mt5ConnectorOpts = {
  /** DB handle (used only to resolve broker_login → account_id for positions()). */
  db: DB;
  /** Ledger (used for positions()). */
  ledger: Ledger;
  /** Phase C TCP server (replaces ZMQ PUB/SUB). */
  tcp: Mt5TcpServer;
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
  private readonly db: DB;
  private readonly ledger: Ledger;
  private readonly tcp: Mt5TcpServer;

  constructor(opts: Mt5ConnectorOpts) {
    this.db = opts.db;
    this.ledger = opts.ledger;
    this.tcp = opts.tcp;
    this.bus.setMaxListeners(0);

    // Wire into the TCP server's event stream. The TCP server already
    // dispatches fills to the ledger; we only need per-account
    // fan-out for stream() consumers.
    this.tcp.onEvent = (evt: ParsedEvent, _account: AccountRow | undefined) => {
      this.handleEvent(evt);
    };
    log.info({ url: 'tcp://127.0.0.1:7778' }, 'mt5 connector bound to TCP bridge');
  }

  // ────────────────────── lifecycle ──────────────────────

  async connect(creds: BrokerCreds): Promise<{ accountRef: string }> {
    const ref = refFor(creds);
    // BUG FIX: previous version created a fresh AccountRecord with
    // loggedIn=false / balance=0 every time connect() was called,
    // and `this.accounts.set(ref, rec)` overwrote any existing state.
    // Effect: every POST /v1/sync (which calls validateAccount →
    // connect) wiped the connector's view of the user's logged-in
    // account and reset /v1/state.connector to loggedIn:false /
    // balance:0 until the next MQL5 publisher publish recovered it
    // (which could take 15s+ depending on init retries).
    //
    // Correct behavior: only create a fresh record if we don't
    // already know about this account. Preserve the existing
    // loggedIn / balance / equity so concurrent sync triggers
    // don't clobber the MQL5 publisher's just-published state.
    const existing = this.accounts.get(ref);
    const rec: AccountRecord = existing ?? {
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
      'mt5 connect: requesting broker login via TCP',
    );

    // Notify MQL5 that this slot wants to track this account. MQL5
    // doesn't actually do the login (the user does it via KasmVNC),
    // but having the server/login in scope lets MQL5 emit the right
    // account_status events when the connection state flips. The
    // command may fail with `mt5_disconnected` if the TCP server
    // isn't up yet; that's fine — we just wait for the event.
    this.tcp.dispatchCommand({
      type: 'command',
      action: 'login',
      payload: { server: creds.server, login: creds.login },
    }).catch(() => { /* server may be down; the account_status event still wins */ });

    // Emit a synthetic account=login event optimistically; the real
    // account_status from MQL5 (if/when it arrives) will overwrite.
    const evt: AccountEvent = { kind: 'login' };
    this.emitToBus({ kind: 'account', data: evt }, ref);

    // Best-effort: wait briefly for an account_status event that
    // confirms the real login. If it doesn't arrive (e.g. the user
    // hasn't logged into MT5 yet via VNC) we still return the ref so
    // the rest of the slot can address this account; the TCP event
    // stream + login detector will flip the state later.
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
      await this.tcp.dispatchCommand({
        type: 'command',
        action: 'logout',
        payload: { server: rec.broker_server, login: rec.broker_login },
      });
    } catch (e) {
      log.warn(
        { accountRef, err: (e as Error).message },
        'mt5 disconnect: TCP dispatch failed',
      );
    }
    this.emitToBus(
      { kind: 'account', data: { kind: 'logout' } },
      accountRef,
    );
  }

  async stop(): Promise<void> {
    // The TCP server is owned by app.ts and stopped there; we just
    // detach our onEvent callback so it doesn't fire into a closed
    // connector.
    this.tcp.onEvent = undefined;
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
    // v0: hardcoded EURUSD. Phase C-real: dispatchCommand({action:"symbols"})
    // returning SymbolInfo* results from MQL5. Deferred — same as Phase B.
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
    // v0: synthetic bid/ask. Phase C-real: dispatchCommand({action:"quote"})
    // returning SymbolInfoDouble(MODE_BID/ASK) from MQL5. Deferred.
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
      const r = await this.tcp.dispatchCommand({
        type: 'command',
        action: 'open',
        id: clientOrderId,
        payload: {
          account_id: rec.broker_login,
          instrument: order.instrument,
          side: order.side,
          qty: order.qty,
          type: order.type,
          price: order.price,
          sl: order.sl,
          tp: order.tp,
        },
      });
      if (!r.ok) {
        return { ok: false, reason: r.error ?? 'unknown_error' };
      }
      // The MQL5 handler returns {order_id, broker_order_id} or
      // {error, retcode}. Both come back as the result object.
      const result = r.result as { order_id?: string; broker_order_id?: string }
        | undefined;
      const brokerOrderId = result?.broker_order_id
        ?? result?.order_id
        ?? `pending-${clientOrderId}`;
      this.emitToBus(
        {
          kind: 'order_state',
          data: { order_id: brokerOrderId, status: 'pending' as OrderStatus },
        },
        accountRef,
      );
      return {
        ok: true,
        order_id: result?.order_id ?? clientOrderId,
        broker_order_id: brokerOrderId,
      };
    } catch (e) {
      return {
        ok: false,
        reason: `TCP dispatch failed: ${(e as Error).message}`,
      };
    }
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
      const r = await this.tcp.dispatchCommand({
        type: 'command',
        action: 'close',
        id: clientOrderId,
        payload: {
          account_id: rec.broker_login,
          position_id: positionId,
          qty,
        },
      });
      if (!r.ok) {
        return { ok: false, reason: r.error ?? 'unknown_error' };
      }
      const result = r.result as { closed_ticket?: string; broker_order_id?: string }
        | undefined;
      const brokerOrderId = result?.broker_order_id
        ?? result?.closed_ticket
        ?? `pending-${clientOrderId}`;
      this.emitToBus(
        {
          kind: 'order_state',
          data: { order_id: brokerOrderId, status: 'pending' as OrderStatus },
        },
        accountRef,
      );
      return {
        ok: true,
        order_id: clientOrderId,
        broker_order_id: brokerOrderId,
      };
    } catch (e) {
      return {
        ok: false,
        reason: `TCP dispatch failed: ${(e as Error).message}`,
      };
    }
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

  private handleEvent(evt: ParsedEvent): void {
    // Map TCP events to broker events, filtered by account_login.
    // Phase C: TCP server's onEvent is called once per MQL5 frame.
    // We resolve account_login → accountRef from the registered
    // accounts (since #property service is single-account-per-slot,
    // there's typically only one).
    if (evt.kind === 'startup') {
      log.info('mt5 TCP: MQL5 service reports startup');
      return;
    }
    if (evt.kind !== 'fill'
     && evt.kind !== 'order_state'
     && evt.kind !== 'account') {
      log.debug({ kind: evt.kind }, 'mt5 TCP: unhandled event');
      return;
    }
    // For Phase C we use a heuristic: pick the first registered
    // accountRef. Phase C-real will route by account_login once the
    // connector tracks multiple accounts.
    const ref = this.firstRef();
    if (!ref) {
      log.debug({ kind: evt.kind, evt }, 'mt5 TCP: no account registered');
      return;
    }
    const rec = this.accounts.get(ref);

    if (evt.kind === 'fill') {
      const fill: Fill = {
        broker_order_id: evt.data.broker_order_id ?? '',
        symbol: evt.data.symbol,
        qty: evt.data.qty ?? evt.data.volume ?? 0,
        price: evt.data.price ?? 0,
        ts: evt.ts ?? Date.now(),
      };
      this.emitToBus({ kind: 'fill', data: fill }, ref);
      return;
    }

    if (evt.kind === 'order_state') {
      this.emitToBus(
        {
          kind: 'order_state',
          data: {
            order_id: evt.data.broker_order_id
                   ?? evt.data.order_id
                   ?? '',
            status: evt.data.status as OrderStatus,
          },
        },
        ref,
      );
      return;
    }

    if (evt.kind === 'account') {
      const d = evt.data as {
        logged_in?: boolean;
        login?: string | number;
        server?: string;
        balance?: number;
        equity?: number;
        last_error?: string;
      };
      if (rec) {
        if (typeof d.logged_in === 'boolean') rec.loggedIn = d.logged_in;
        if (typeof d.balance === 'number') rec.balance = d.balance;
        if (typeof d.equity === 'number') rec.equity = d.equity;
        if (typeof d.last_error === 'string') rec.lastError = d.last_error;
      }
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
          { kind: 'account', data: { kind: 'error', detail: d.last_error } },
          ref,
        );
      }
    }
  }

  private firstRef(): string | undefined {
    const it = this.accounts.keys();
    const n = it.next();
    return n.done ? undefined : n.value;
  }

  private emitToBus(e: BrokerEvent, ref: string): void {
    this.bus.emit('event', e, ref);
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