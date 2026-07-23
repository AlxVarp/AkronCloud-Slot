import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

import { type Deps } from '../app.js';
import { ProblemError } from '../problem.js';

/**
 * WebSocket routes — v0.4.
 *
 * GET /v1/stream — JWT-protected stream of broker events for the
 * slot's configured account. WebSocket clients can't set the
 * `Authorization` header easily, so the token is accepted via
 * `?token=<jwt>` query param instead.
 *
 * Wire format (server → client):
 *
 *   { "type": "event",
 *     "kind": "fill" | "order_state" | "account",
 *     "data": { ... },
 *     "ts":   <epoch ms> }
 *
 *   { "type": "ping",   "ts": <epoch ms> }   // 30s keepalive
 *   { "type": "error",  "code": "BROKER_DOWN", ... }  // rare
 *
 * The cerebro (or any external listener) can use this stream to
 * observe fills / order state changes / account events in real
 * time, regardless of whether the originating action came from
 * the cerebro, the mobile wrapper, or MT5 itself.
 *
 * Known limitation: the MT5 TCP socket (127.0.0.1:7778) accepts
 * exactly one client at a time. While a WS subscriber holds the
 * stream open, REST write endpoints that share that socket (POST
 * /v1/orders etc.) may queue or 502 if the cerebro connection is
 * displaced. See docs/sessions/2026-07-23-v0.4-trading-api-handoff.md
 * for the multi-connection TODO.
 */

const PING_INTERVAL_MS = 30_000;

/**
 * Authenticate a WS upgrade using `?token=<jwt>`. Throws
 * ProblemError on failure so the socket can close cleanly with a
 * JSON error frame before any data is sent.
 */
async function authenticate(
  deps: Deps,
  req: FastifyRequest,
): Promise<void> {
  const url = req.raw.url ?? '';
  const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  const params = new URLSearchParams(qs);
  const token = params.get('token');
  if (!token) {
    throw new ProblemError({
      status: 401,
      code: 'UNAUTHENTICATED',
      title: 'Missing token',
      detail: 'WebSocket auth: ?token=<jwt> query parameter required',
    });
  }
  await deps.auth.verifyToken(token, {
    secret: deps.cfg.jwtSecret,
    expectedTenantId: deps.cfg.tenantId,
    expectedSlotId: deps.cfg.slotId,
    requiredScopes: ['slot:stream'],
  });
}

/** Resolve the configured accountRef for the streaming session. */
function resolveAccountRef(deps: Deps): {
  accountRef: string;
  brokerLogin: string;
} {
  const tenantId = deps.cfg.tenantId;
  const row = deps.accounts.list(tenantId)[0];
  if (!row || row.status === 'disabled') {
    throw new ProblemError({
      status: 404,
      code: 'NOT_FOUND',
      title: 'No active broker account',
      detail:
        'The slot has no active broker account configured. Log in ' +
        'through the mobile wrapper to provision one, then reconnect.',
    });
  }
  const accountRef = `${deps.connector.id}-${row.broker_server}-${row.broker_login}`;
  return { accountRef, brokerLogin: row.broker_login };
}

export async function wsRoutes(app: FastifyInstance): Promise<void> {
  const deps = app.deps as Deps;

  app.get('/v1/stream', { websocket: true }, async (socket, req) => {
    const ws = socket as unknown as WebSocket;

    // Authenticate before any frames are exchanged. We open the
    // upgrade on auth failure only long enough to send a single
    // error frame, then close.
    let accountRef: string;
    try {
      await authenticate(deps, req);
      accountRef = resolveAccountRef(deps).accountRef;
    } catch (e) {
      const p = e instanceof ProblemError
        ? e.problem
        : {
            type: 'about:blank',
            title: 'WS auth failed',
            status: 401,
            code: 'UNAUTHENTICATED' as const,
            detail: (e as Error).message,
          };
      try {
        ws.send(JSON.stringify({ type: 'error', ...p }));
      } catch {
        /* socket may already be torn down */
      }
      ws.close(1011, 'auth_failed');
      return;
    }

    req.log.info({ accountRef }, 'ws: /v1/stream connected');

    // Abort controller wires the AsyncIterable's lifecycle to the
    // socket's close event. When the client disconnects we tear
    // down the stream so the connector releases its bus listener.
    const ac = new AbortController();
    const cleanup = () => {
      if (!ac.signal.aborted) ac.abort();
    };
    ws.on('close', cleanup);
    ws.on('error', (err: Error) => {
      req.log.warn({ err: err.message }, 'ws: socket error');
      cleanup();
    });

    // Keepalive ping. ws library handles the wire-level PING/PONG
    // itself; we send an app-level frame every PING_INTERVAL_MS so
    // clients can render liveness in their UI.
    const pingTimer = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        } catch {
          /* socket may have closed mid-flight */
        }
      }
    }, PING_INTERVAL_MS);
    pingTimer.unref?.();

    try {
      for await (const evt of deps.connector.stream(accountRef, ac.signal)) {
        if (ws.readyState !== ws.OPEN) break;
        const frame = JSON.stringify({
          type: 'event',
          kind: evt.kind,
          data: 'data' in evt ? evt.data : evt,
          ts: Date.now(),
        });
        try {
          ws.send(frame);
        } catch (err) {
          req.log.warn(
            { err: (err as Error).message },
            'ws: send failed, closing stream',
          );
          break;
        }
      }
    } catch (err) {
      req.log.warn(
        { err: (err as Error).message },
        'ws: stream() iterator threw',
      );
    } finally {
      clearInterval(pingTimer);
      cleanup();
      try {
        if (ws.readyState === ws.OPEN) ws.close(1000, 'stream_done');
      } catch {
        /* already closed */
      }
      req.log.info({ accountRef }, 'ws: /v1/stream disconnected');
    }
  });
}
