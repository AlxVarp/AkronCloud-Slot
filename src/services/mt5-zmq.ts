/**
 * mt5-zmq — ZMQ subscriber to the slot's embedded MT5 (running inside
 * the same container). The parent Akron mt5-base ships
 * `PublisherZMQEvents.ex5` which publishes trade events to a ZMQ PUB
 * socket (default `tcp://mt5-orchestrator:5557` — we override the
 * EA's `PublishEndpoint` to `tcp://127.0.0.1:5557` at chart-load time
 * and listen on 5557 here).
 *
 * Events are JSON strings of the form
 *   { "type": "fill" | "order_state" | "account_status" | "heartbeat" | ...,
 *     "account_login": "<broker login>",
 *     "data": { ... } }
 *
 * The handler:
 *   - "fill"          → ledger.insertFill + broadcast to WS subscribers
 *   - "order_state"   → ledger.updateOrderStatus + WS broadcast
 *   - "account_status"→ nothing (login detector does that already)
 *   - others          → log and ignore
 *
 * The connector is broker-agnostic: it just trusts whatever the EA
 * sends. The slot is broker-agnostic by design (SPEC §4).
 */
import { Subscriber, type Message } from 'zeromq';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { log } from '../log.js';
import type { Ledger } from '../ledger.js';
import type { AccountRow } from '../db/index.js';

const ZMQ_DEFAULT_URL = process.env.SLOT_MT5_ZMQ_URL ?? 'tcp://127.0.0.1:5557';
const RECONNECT_DELAY_MS = 3_000;

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

const AnyEvent = z.union([FillEvent, OrderStateEvent]);
type ParsedEvent = z.infer<typeof AnyEvent>;

export type StartMt5ZmqOpts = {
  ledger: Ledger;
  /** Find an account row by its broker_login field. */
  resolveAccount: (brokerLogin: string) => AccountRow | undefined;
  /** Called for each parsed fill or order_state, after persistence. */
  onEvent?: (evt: ParsedEvent, account: AccountRow) => void;
  /** Override ZMQ URL (mostly for tests). */
  zmqUrl?: string;
};

/**
 * Start the ZMQ subscriber. Returns a stop() function that closes the
 * socket and cancels reconnect attempts. Reconnects on any error.
 */
export function startMt5Zmq(opts: StartMt5ZmqOpts): () => void {
  let stopped = false;
  let sub: Subscriber | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const url = opts.zmqUrl ?? ZMQ_DEFAULT_URL;
  log.info({ url }, 'starting MT5 ZMQ subscriber');

  const onMessage = (raw: Buffer): void => {
    const text = raw.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      log.warn({ text: text.slice(0, 200) }, 'malformed ZMQ event JSON');
      return;
    }
    const result = AnyEvent.safeParse(parsed);
    if (!result.success) {
      // Heartbeat / account_status / init / unknown — log + skip
      const type = (parsed as { type?: string }).type ?? 'unknown';
      log.debug({ type }, 'ignoring ZMQ event');
      return;
    }
    const evt = result.data;
    const brokerLogin = String(evt.account_login ?? '');
    const account = opts.resolveAccount(brokerLogin);
    if (!account) {
      log.warn(
        { brokerLogin, type: evt.type },
        'ZMQ event for unknown account',
      );
      return;
    }
    if (evt.type === 'fill') {
      const orderRow = evt.data.broker_order_id
        ? opts.ledger.getOrderByBrokerId(account.id, evt.data.broker_order_id)
        : undefined;
      opts.ledger.insertFill({
        order_id: orderRow?.id ?? null,
        account_id: account.id,
        instrument: evt.data.symbol,
        qty: evt.data.qty,
        price: evt.data.price,
        fee: evt.data.fee ?? null,
        ts: evt.data.ts ?? Date.now(),
      });
      if (orderRow) {
        opts.ledger.updateOrderStatus(
          account.id,
          orderRow.id,
          'filled',
          orderRow.broker_order_id,
          evt.data.ts ?? Date.now(),
        );
      }
      log.info(
        { account: account.id, symbol: evt.data.symbol, qty: evt.data.qty },
        'fill persisted from ZMQ',
      );
    } else if (evt.type === 'order_state') {
      const orderRow = opts.ledger.getOrderByBrokerId(
        account.id,
        evt.data.broker_order_id,
      );
      if (orderRow) {
        opts.ledger.updateOrderStatus(
          account.id,
          orderRow.id,
          evt.data.status as 'pending' | 'filled' | 'cancelled' | 'rejected',
          orderRow.broker_order_id,
          Date.now(),
        );
      }
    }
    if (opts.onEvent) {
      try {
        opts.onEvent(evt, account);
      } catch (e) {
        log.error({ err: (e as Error).message }, 'onEvent callback failed');
      }
    }
  };

  const connectOnce = async (): Promise<void> => {
    if (stopped) return;
    try {
      const sock = new Subscriber();
      await sock.connect(url);
      await sock.subscribe('');
      sub = sock;
      log.info({ url }, 'ZMQ subscriber connected');
      void (async (): Promise<void> => {
        while (!stopped) {
          try {
            const [msg] = await sock.receive();
            onMessage(msg as Buffer);
          } catch (e) {
            log.warn(
              { err: (e as Error).message },
              'ZMQ receive error, will reconnect',
            );
            break;
          }
        }
      })();
    } catch (e) {
      log.warn(
        { err: (e as Error).message, url },
        'ZMQ connect failed, will retry',
      );
      sub = null;
      if (!stopped) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void connectOnce();
        }, RECONNECT_DELAY_MS);
      }
    }
  };

  // The EA takes a few seconds to attach + start publishing. Wait
  // before initial connect so we don't churn.
  setTimeout(() => {
    void connectOnce();
  }, 5_000);

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (sub) {
      try {
        sub.close();
      } catch {
        /* ignore */
      }
    }
  };
}
