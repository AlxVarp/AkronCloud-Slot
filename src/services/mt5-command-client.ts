import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { log } from '../log.js';

/**
 * Outbound TCP client that connects to the SlotService.mq5 command
 * server (127.0.0.1:7779 inside the slot container).
 *
 * In v2.10 of SlotService.mq5 the slot shared its single inbound
 * socket on port 7778 with the Python account-publisher for both
 * events AND commands. That worked when nothing else connected to
 * 7778 but became flaky once both SlotService.ex5 and the Python
 * publisher were competing for the slot's listener (the slot's TCP
 * server only accepts one client at a time — the most recent
 * connect wins and the previous one is destroyed). The result was
 * `mt5_timeout` on REST dispatch whenever the publisher connected
 * mid-request.
 *
 * v2.11 of SlotService.mq5 splits the wire: events still go over
 * 7778 (shared with the Python publisher — multiple event sources
 * are fine because they only push), but commands go over a new
 * 7779 port where MQL5 listens and the slot opens a single
 * persistent outbound connection. No more contention.
 *
 * Wire protocol on 7779: newline-delimited JSON. Same shape as
 * the events socket's "command"/"response" frames, just over a
 * dedicated socket.
 *
 *   slot -> MQL5:
 *     {"type":"command","id":"<uuid>","action":"...","payload":{...}}
 *   MQL5 -> slot:
 *     {"type":"response","id":"<uuid>","ok":true|false,"result":{...}|"error":"..."}
 */

const COMMAND_HOST = process.env.SLOT_MT5_CMD_HOST ?? '127.0.0.1';
const COMMAND_PORT = Number(process.env.SLOT_MT5_CMD_PORT ?? 7780);
const CONNECT_TIMEOUT_MS = 3_000;
const IDLE_RECONNECT_MS = 2_000;

export type CommandResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
  id?: string;
};

export type DispatchOptions = {
  timeoutMs?: number;
};

export class Mt5CommandClient {
  private sock: net.Socket | null = null;
  private recvBuf = '';
  private readonly pending = new Map<
    string,
    { resolve: (r: CommandResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private destroyed = false;

  constructor(
    private readonly host: string = COMMAND_HOST,
    private readonly port: number = COMMAND_PORT,
  ) {
    this.connect();
  }

  /**
   * Send a command to MQL5 and await the matching response.
   * Resolves with the parsed result or rejects with a TimeoutError /
   * socket error if MQL5 doesn't reply in time.
   */
  async dispatch<T = unknown>(
    action: string,
    payload: Record<string, unknown>,
    opts: DispatchOptions = {},
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const id = randomUUID();
    const frame = JSON.stringify({
      type: 'command',
      id,
      action,
      payload,
    }) + '\n';

    if (this.destroyed) {
      throw new Error('MT5 command client destroyed');
    }

    await this.ensureConnected();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('mt5_cmd_timeout'));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          if (!r.ok) {
            reject(new Error(r.error ?? 'mt5_cmd_failed'));
          } else {
            resolve(r.result as T);
          }
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });

      this.sock!.write(frame, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  destroy(): void {
    this.destroyed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('MT5 command client destroyed'));
    }
    this.pending.clear();
    if (this.sock) {
      this.sock.destroy();
      this.sock = null;
    }
  }

  private connect(): void {
    if (this.destroyed) return;
    const s = net.createConnection({ host: this.host, port: this.port });
    s.setTimeout(CONNECT_TIMEOUT_MS);

    s.once('connect', () => {
      s.setTimeout(0);
      log.info({ host: this.host, port: this.port }, 'mt5 command client connected');
    });

    // Closure flag: tracks whether the 'error' handler ran for THIS
    // socket. The destroyed-socket 'close' fires after 'error'; clean
    // peer disconnects fire 'close' without 'error'. The flag lets
    // 'close' know whether reconnect has already been scheduled, so we
    // don't double-schedule (which previously caused a busy loop on
    // fresh deploys where MQL5 wasn't listening yet).
    let connectFailed = false;

    s.once('error', (err) => {
      // debug-level: the slot retries every IDLE_RECONNECT_MS until
      // MQL5 starts listening. At warn this would flood the log
      // (30 entries/minute) and starve the HTTP server. The first
      // ECONNREFUSED in a fresh deploy is normal — only a sustained
      // outage deserves operator attention.
      log.debug({ err: err.message, host: this.host, port: this.port },
        'mt5 command client connect error');
      connectFailed = true;
      this.failPending(err);
      s.destroy();
      this.sock = null;
      this.scheduleReconnect();
    });

    s.on('data', (chunk: Buffer) => {
      this.recvBuf += chunk.toString('utf8');
      let idx: number;
      while ((idx = this.recvBuf.indexOf('\n')) >= 0) {
        const frame = this.recvBuf.slice(0, idx);
        this.recvBuf = this.recvBuf.slice(idx + 1);
        this.dispatchFrame(frame);
      }
      if (this.recvBuf.length > 65_536) {
        log.warn('mt5 command client recv buffer overflow, reconnecting');
        s.destroy();
      }
    });

    s.on('close', () => {
      log.debug('mt5 command client disconnected');
      this.failPending(new Error('MT5 command socket closed'));
      // If 'error' already ran for this socket, reconnect was
      // scheduled from there — don't double-schedule (the previous
      // bug here caused a tight CPU-spinning reconnect storm).
      // Otherwise this is a clean disconnect and we need to
      // schedule ourselves.
      if (connectFailed) return;
      if (this.destroyed) return;
      this.sock = null;
      this.scheduleReconnect();
    });

    this.sock = s;
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    setTimeout(() => {
      if (!this.destroyed) this.connect();
    }, IDLE_RECONNECT_MS).unref();
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private dispatchFrame(frame: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(frame);
    } catch (e) {
      log.warn({ frame: frame.slice(0, 200) }, 'mt5 command client bad JSON frame');
      return;
    }
    if (parsed?.type !== 'response') return;
    const id = parsed.id;
    const pending = this.pending.get(id);
    if (!pending) {
      log.warn({ id }, 'mt5 command client got response for unknown id');
      return;
    }
    this.pending.delete(id);
    pending.resolve({
      ok: !!parsed.ok,
      result: parsed.result,
      error: parsed.error,
      id,
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.sock && !this.sock.destroyed) return;
    // wait up to 1s for the connect to complete
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      if (this.sock && !this.sock.destroyed) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('MT5 command socket not connected');
  }
}