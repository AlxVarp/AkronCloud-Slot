/**
 * mt5-tcp-server — Phase C / Ruta B1. Direct TCP socket for MQL5 ↔ slot.
 *
 * Replaces the file-watcher + ZMQ bridge:
 *   - mt5-zmq.ts (ZMQ subscriber on :5557)
 *   - mt5-bridge-adapter.py (watchdog file watcher → ZMQ pub)
 *   - MQL5/Files/*.json (file-based command/event protocol)
 *
 * The MQL5 side (`SlotService.mq5`) connects on 127.0.0.1:7778 and
 * sends newline-delimited JSON frames. Two frame types arrive here:
 *
 *   { type: "event",   kind: "fill" | "order_state" | "position" |
 *                          "account" | "startup",
 *     data: {...}, ts: 1784494201536 }
 *
 *   { type: "response", id: "<uuid>", ok: true | false,
 *     result: {...} | error: "..." }
 *
 * We forward events to the existing ledger pipeline (same shape as the
 * old ZMQ subscriber) and resolve pending command promises on response
 * frames.
 *
 * Wire protocol: see docs/plans/PHASE_C_RTA_B1_TCP_SOCKET.md §2.
 */
import net from 'node:net';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { log } from '../log.js';
import type { Ledger } from '../ledger.js';
import type { AccountRow } from '../db/index.js';

const BIND_HOST = process.env.SLOT_MT5_TCP_HOST ?? '127.0.0.1';
const BIND_PORT = Number(process.env.SLOT_MT5_TCP_PORT ?? 7778);
const CMD_TIMEOUT_MS = Number(process.env.SLOT_MT5_CMD_TIMEOUT_MS ?? 5_000);
const RECV_BUF_MAX = 65_536;

// --- Frame schemas ---------------------------------------------------

const FillEvent = z.object({
  type: z.literal('event'),
  kind: z.literal('fill'),
  data: z.object({
    broker_order_id: z.string().optional(),
    deal: z.string().optional(),
    symbol: z.string(),
    qty: z.number().optional(),
    price: z.number().optional(),
    volume: z.number().optional(),
  }),
  ts: z.number().optional(),
});

const OrderStateEvent = z.object({
  type: z.literal('event'),
  kind: z.literal('order_state'),
  data: z.object({
    order_id: z.string().optional(),
    broker_order_id: z.string().optional(),
    status: z.string(),
  }),
  ts: z.number().optional(),
});

const PositionEvent = z.object({
  type: z.literal('event'),
  kind: z.literal('position'),
  data: z.object({
    order_id: z.string().optional(),
    symbol: z.string().optional(),
  }),
  ts: z.number().optional(),
});

const AccountEvent = z.object({
  type: z.literal('event'),
  kind: z.literal('account'),
  data: z.record(z.string(), z.unknown()).optional(),
  ts: z.number().optional(),
});

const StartupEvent = z.object({
  type: z.literal('event'),
  kind: z.literal('startup'),
  ts: z.number().optional(),
});

const AnyEvent = z.union([
  FillEvent, OrderStateEvent, PositionEvent, AccountEvent, StartupEvent,
]);

const ResponseFrame = z.object({
  type: z.literal('response'),
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

const AnyFrame = z.union([AnyEvent, ResponseFrame]);

// --- Public types ----------------------------------------------------

export type ParsedEvent = z.infer<typeof AnyEvent>;

export type CommandResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type StartMt5TcpOpts = {
  ledger: Ledger;
  resolveAccount: (brokerLogin: string) => AccountRow | undefined;
  onEvent?: (evt: ParsedEvent, account: AccountRow | undefined) => void;
  host?: string;
  port?: number;
};

// --- Server implementation -------------------------------------------

type PendingCommand = {
  resolve: (r: CommandResult) => void;
  timer: NodeJS.Timeout;
};

export class Mt5TcpServer {
  private server?: net.Server;
  private sock?: net.Socket;
  private recvBuf = '';
  private pending = new Map<string, PendingCommand>();
  private ledger: Ledger;
  private resolveAccount: (brokerLogin: string) => AccountRow | undefined;
  public onEvent?: (evt: ParsedEvent, account: AccountRow | undefined) => void;
  private host: string;
  private port: number;

  constructor(opts: StartMt5TcpOpts) {
    this.ledger = opts.ledger;
    this.resolveAccount = opts.resolveAccount;
    this.onEvent = opts.onEvent;
    this.host = opts.host ?? BIND_HOST;
    this.port = opts.port ?? BIND_PORT;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer({ allowHalfOpen: false }, (sock) => {
        this.handleConnection(sock);
      });
      this.server.on('error', reject);
      this.server.listen(this.port, this.host, () => {
        log.info({ host: this.host, port: this.port }, 'MT5 TCP server listening');
        resolve();
      });
    });
  }

  /**
   * Send a command frame to MT5 and await the response. Generates a UUID,
   * registers a pending promise, writes the frame, and resolves on the
   * matching response or timeout.
   */
  dispatchCommand(cmd: object, id?: string): Promise<CommandResult> {
    if (!this.sock || this.sock.destroyed) {
      return Promise.reject(new Error('MT5 socket not connected'));
    }
    const cmdId = id ?? randomUUID();
    const frame = JSON.stringify({ ...cmd, id: cmdId }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmdId);
        resolve({ ok: false, error: 'mt5_timeout' });
      }, CMD_TIMEOUT_MS);
      this.pending.set(cmdId, { resolve, timer });
      this.sock!.write(frame, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(cmdId);
          reject(err);
        }
      });
    });
  }

  isConnected(): boolean {
    return !!this.sock && !this.sock.destroyed;
  }

  async stop(): Promise<void> {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'mt5_server_stopping' });
    }
    this.pending.clear();
    if (this.sock) this.sock.destroy();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  private handleConnection(sock: net.Socket): void {
    if (this.sock) {
      log.warn('MT5 TCP: replacing existing connection');
      this.sock.destroy();
    }
    this.sock = sock;
    this.recvBuf = '';
    log.info({ remote: sock.remoteAddress, port: sock.remotePort },
             'MT5 TCP: connected');

    sock.on('data', (chunk: Buffer) => this.onData(chunk));
    sock.on('close', () => this.onClose());
    sock.on('error', (err) => log.warn({ err: err.message }, 'MT5 TCP: socket error'));
  }

  private onData(chunk: Buffer): void {
    this.recvBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.recvBuf.indexOf('\n')) >= 0) {
      const frame = this.recvBuf.slice(0, idx);
      this.recvBuf = this.recvBuf.slice(idx + 1);
      try {
        this.dispatch(JSON.parse(frame));
      } catch (err) {
        log.warn({ err: (err as Error).message, frame: frame.slice(0, 200) },
                 'MT5 TCP: bad frame');
      }
    }
    if (this.recvBuf.length > RECV_BUF_MAX) {
      log.warn('MT5 TCP: recv buffer overflow, dropping');
      this.recvBuf = '';
    }
  }

  private dispatch(frame: unknown): void {
    const result = AnyFrame.safeParse(frame);
    if (!result.success) {
      log.warn({ frame: JSON.stringify(frame).slice(0, 200) },
               'MT5 TCP: schema mismatch');
      return;
    }
    const f = result.data;
    if (f.type === 'response') {
      const p = this.pending.get(f.id);
      if (!p) {
        log.warn({ id: f.id }, 'MT5 TCP: response for unknown id');
        return;
      }
      clearTimeout(p.timer);
      this.pending.delete(f.id);
      p.resolve({
        ok: f.ok,
        ...(f.result !== undefined ? { result: f.result } : {}),
        ...(f.error !== undefined ? { error: f.error } : {}),
      });
      return;
    }
    this.handleEvent(f);
  }

  private handleEvent(evt: ParsedEvent): void {
    if (evt.kind === 'startup') {
      log.info({ ts: evt.ts }, 'MT5 service reported startup');
      return;
    }
    // Account resolution: the slot's #property service runs in a
    // single-account context, so we resolve by the slot's primary
    // account. Future: support multiple accounts via SLOTS_PER_TENANT.
    const account = this.resolveAccount('');
    if (!account) {
      log.warn({ kind: evt.kind }, 'MT5 TCP: no account resolved');
      return;
    }
    if (evt.kind === 'fill') {
      const orderRow = evt.data.broker_order_id
        ? this.ledger.getOrderByBrokerId(account.id, evt.data.broker_order_id)
        : undefined;
      try {
        this.ledger.insertFill({
          order_id: orderRow?.id ?? null,
          account_id: account.id,
          instrument: evt.data.symbol,
          qty: evt.data.qty ?? evt.data.volume ?? 0,
          price: evt.data.price ?? 0,
          fee: null,
          ts: evt.ts ?? Date.now(),
        });
        if (orderRow) {
          this.ledger.updateOrderStatus(
            account.id, orderRow.id, 'filled',
            orderRow.broker_order_id, evt.ts ?? Date.now(),
          );
        }
        log.info({ account: account.id, symbol: evt.data.symbol },
                 'fill persisted from TCP');
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'MT5 TCP: fill persistence failed');
      }
    } else if (evt.kind === 'order_state') {
      const orderRow = evt.data.broker_order_id
        ? this.ledger.getOrderByBrokerId(account.id, evt.data.broker_order_id)
        : undefined;
      if (orderRow) {
        try {
          this.ledger.updateOrderStatus(
            account.id, orderRow.id,
            evt.data.status as 'pending' | 'filled' | 'cancelled' | 'rejected',
            orderRow.broker_order_id, Date.now(),
          );
        } catch (err) {
          log.warn({ err: (err as Error).message },
                   'MT5 TCP: order_state persistence failed');
        }
      }
    }
    try {
      this.onEvent?.(evt, account);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'onEvent callback failed');
    }
  }

  private onClose(): void {
    log.warn('MT5 TCP: disconnected');
    this.sock = undefined;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'mt5_disconnected' });
      this.pending.delete(id);
    }
  }
}

/** Convenience constructor. */
export async function startMt5TcpServer(opts: StartMt5TcpOpts): Promise<Mt5TcpServer> {
  const srv = new Mt5TcpServer(opts);
  await srv.start();
  return srv;
}