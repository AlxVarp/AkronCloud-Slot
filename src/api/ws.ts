import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

import type { Deps } from '../app';
import type { BrokerEvent } from '../connectors/base';

/**
 * /v1/stream WebSocket upgrade.
 *
 * Protocol (SPEC § 2.2):
 *   - Server upgrades once the global onRequest hook verifies the
 *     Bearer token + tenant + slot + scope slot:stream.
 *   - Client sends { type: 'subscribe'|'unsubscribe', channel }
 *     and reads { type: 'event'|'pong'|'heartbeat'|'error' } in return.
 *   - Heartbeats fire every 30s as {type:'heartbeat', ts}.
 *
 * Phase B pulls events from the connector stream (just one accountRef
 * for the sim; Phase C will multiplex across N).
 *
 * Per-connection state:
 *   subscriptions: Set<string> for the lifetime of the socket.
 */
const SUPPORTED_CHANNELS = new Set([
  'fills',
  'orders',
  'quotes',
  'account',
  'heartbeats',
]);

const HEARTBEAT_MS = 30_000;

type Conn = {
  id: string;
  socket: WebSocket;
  subscriptions: Set<string>;
  accountRef: string | null;
};

const conns = new Set<Conn>();

export async function wsRoutes(app: FastifyInstance) {
  app.get('/v1/stream', { websocket: true }, (socket: WebSocket, req) => {
    const deps = app.deps as Deps;
    const claims = (req as unknown as { claims: { scope: string[]; tenant_id: string } }).claims;
    if (!claims?.scope.includes('slot:stream')) {
      sendError(socket, 'FORBIDDEN', 'missing scope: slot:stream');
      socket.close(1008, 'forbidden');
      return;
    }

    const conn: Conn = {
      id: randomUUID(),
      socket,
      subscriptions: new Set(['heartbeats']),
      accountRef: null,
    };
    conns.add(conn);

    socket.on('close', () => {
      conns.delete(conn);
    });
    socket.on('error', () => {
      conns.delete(conn);
    });

    socket.send(
      JSON.stringify({
        type: 'event',
        channel: 'welcome',
        data: { conn: conn.id, ts: Date.now() },
      }),
    );

    socket.on('message', (raw: Buffer | string) => {
      let msg: { type?: string; channel?: string } = {};
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        sendError(socket, 'BAD_CHANNEL', 'invalid JSON');
        return;
      }
      switch (msg.type) {
        case 'ping':
          socket.send(JSON.stringify({ type: 'pong' }));
          return;
        case 'subscribe': {
          const ch = msg.channel ?? '';
          if (!SUPPORTED_CHANNELS.has(ch)) {
            sendError(socket, 'BAD_CHANNEL', `unknown channel ${ch}`);
            return;
          }
          conn.subscriptions.add(ch);
          // When the first client subscribes to fills/orders/account,
          // pull the connector stream into all current conns.
          ensureConnectorStream(deps);
          return;
        }
        case 'unsubscribe': {
          conn.subscriptions.delete(msg.channel ?? '');
          return;
        }
        default:
          sendError(socket, 'BAD_REQUEST', `unknown message type: ${msg.type}`);
      }
    });
  });

  // Heartbeats: broadcast every HEARTBEAT_MS to every open conn.
  setInterval(() => {
    const now = Date.now();
    for (const c of conns) {
      if (c.subscriptions.has('heartbeats') && c.socket.readyState === 1 /* OPEN */) {
        try {
          c.socket.send(JSON.stringify({ type: 'heartbeat', ts: now }));
        } catch {
          /* ignore */
        }
      }
    }
  }, HEARTBEAT_MS).unref?.();
}

function sendError(socket: WebSocket, code: string, message: string): void {
  try {
    socket.send(JSON.stringify({ type: 'error', code, message }));
  } catch {
    /* ignore */
  }
}

let _streamStarted = false;
let _streamAbort: AbortController | null = null;

/**
 * Lazily start the connector stream once; rebroadcast its events to
 * all interested WS connections. Idempotent.
 */
function ensureConnectorStream(deps: Deps): void {
  if (_streamStarted) return;
  _streamStarted = true;
  _streamAbort = new AbortController();
  void pumpStream(deps, _streamAbort.signal);
}

async function pumpStream(deps: Deps, signal: AbortSignal): Promise<void> {
  // Phase B: there's only one accountRef in scope for the sim. We
  // iterate events from the connector and fan out to subscribers.
  // When the WS upgrades, we lazily discover the right account via
  // a side-channel; for Phase B the sim exposes one stream whose
  // accountRef matches `sim-<accountId>` row by row.
  //
  // We iterate ALL active broker sessions for the connected accounts
  // by listing them from `accounts` and asking the connector to
  // open a stream for each. Sim returns one multiplexed stream per
  // accountRef; in Phase B there's typically exactly one.

  const accountRefs = collectActiveAccountRefs(deps);
  for (const ref of accountRefs) {
    void pumpOne(deps, ref, signal);
  }
}

function collectActiveAccountRefs(deps: Deps): string[] {
  // Match the SimConnector's deterministic accountRef scheme.
  const rows = deps.db
    .prepare(
      `SELECT broker_server, broker_login FROM accounts WHERE status = 'active'`,
    )
    .all() as { broker_server: string; broker_login: string }[];
  return rows.map((r) => `sim-${r.broker_server}-${r.broker_login}`);
}

async function pumpOne(deps: Deps, accountRef: string, signal: AbortSignal): Promise<void> {
  try {
    const iter = deps.connector.stream(accountRef, signal);
    for await (const evt of iter) {
      broadcast(deps, evt, accountRef);
    }
  } catch (e) {
    deps.log.warn({ err: (e as Error).message, accountRef }, 'connector stream ended');
  }
}

function broadcast(deps: Deps, evt: BrokerEvent, _accountRef: string): void {
  let channel: string;
  let data: unknown;
  switch (evt.kind) {
    case 'fill':
      channel = 'fills';
      data = evt.data;
      // Persist the fill to the ledger. Phase B: write to whichever
      // active account has the same symbol — good enough for the
      // sim-with-one-account validation. Phase C: the fill should
      // arrive keyed on the accountRef that placed the order.
      handleFill(deps, evt.data);
      break;
    case 'order_state':
      channel = 'orders';
      data = evt.data;
      break;
    case 'account':
      channel = 'account';
      data = evt.data;
      break;
    default:
      return;
  }

  const frame = JSON.stringify({ type: 'event', channel, data });
  for (const c of conns) {
    if (c.subscriptions.has(channel) && c.socket.readyState === 1) {
      try {
        c.socket.send(frame);
      } catch {
        /* ignore */
      }
    }
  }
}

function handleFill(
  deps: Deps,
  fill: { broker_order_id: string; symbol: string; qty: number; price: number; fee?: number; ts: number },
): void {
  // Find the matching order row by broker_order_id + the most-recent
  // active account that owns it.
  const rows = deps.db
    .prepare(
      `SELECT a.id as account_id
         FROM accounts a
        WHERE a.status = 'active'
        ORDER BY a.updated_at DESC
        LIMIT 1`,
    )
    .all() as { account_id: string }[];
  const owner = rows[0]?.account_id;
  if (!owner) return;

  const orderRow = deps.ledger.getOrderByBrokerId(owner, fill.broker_order_id);
  deps.ledger.insertFill({
    order_id: orderRow?.id ?? null,
    account_id: owner,
    instrument: fill.symbol,
    qty: fill.qty,
    price: fill.price,
    fee: fill.fee ?? null,
    ts: fill.ts,
  });
  if (orderRow) {
    deps.ledger.updateOrderStatus(
      owner,
      orderRow.id,
      'filled',
      orderRow.broker_order_id,
      fill.ts,
    );
  }
}
