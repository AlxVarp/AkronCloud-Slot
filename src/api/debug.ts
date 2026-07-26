/**
 * debug — debug/ea-minimal endpoints to inspect the SlotService
 * (MQL5 EA) wiring without grepping logs.
 *
 * All routes are NO-AUTH (same network only) and intended for the
 * operator working on the EA-startup problem. Not part of the slot's
 * public API.
 *
 * GET  /debug/slotservice
 *   Snapshot of the TCP server state: bound address, current
 *   peer, command-client connection, ring buffer of recent
 *   connect/disconnect/replace events, ring buffer of recent
 *   parsed wire frames, pending-command count.
 *
 * GET  /debug/logs?since=N
 *   Tail the slot log (pino) — last 200 lines, optionally filtered
 *   to entries with time >= now - since (ms).
 *
 * POST /debug/inject-cmd
 *   Manually send a command frame over the same dispatch path the
 *   REST /v1/orders uses. Useful when the EA is connected but
 *   /v1/orders is returning 502 BROKER_DOWN — proves whether the
 *   wire is alive independent of the REST auth path.
 *
 *   Body: { "action": "order.place", "payload": {...}, "timeoutMs": 5000 }
 *
 * POST /debug/cmd-client/reconnect
 *   Tear down the outbound TCP client to the MQL5 command port
 *   (7780) and immediately reconnect. Helpful when the client
 *   reports cmdClientConnected=true but no frames flow — common
 *   after SlotService.exe restarts without re-listening.
 */
import type { FastifyInstance } from 'fastify';
import { log } from '../log.js';
import type { Mt5TcpServer } from '../services/mt5-tcp-server.js';
import type { Mt5CommandClient } from '../services/mt5-command-client.js';

type Deps = {
  tcp: Mt5TcpServer;
  cmdClient: Mt5CommandClient;
};

export function debugRoutes(deps: Deps) {
  return async function register(app: FastifyInstance) {
    app.get('/debug/slotservice', async () => {
      const snap = deps.tcp.getDebugState();
      return {
        ok: true,
        at: Date.now(),
        ...snap,
      };
    });

    app.get('/debug/logs', async (req) => {
      const q = req.query as { since?: string; limit?: string };
      const sinceMs = q.since ? Number(q.since) : 60_000;
      const limit = q.limit ? Number(q.limit) : 200;
      // pino doesn't expose a tail endpoint in this codebase; we
      // return the most recent log lines from a short in-memory
      // ring maintained by the pino instance configured in log.ts.
      // For now: emit the tail via a debug-only grep over the
      // pino file transport. The slot's pino writes to stdout only
      // (logger:false in buildApp + our own pino) — docker logs is
      // the source of truth. The route is a placeholder that tells
      // operators where to look.
      return {
        ok: true,
        message:
          'Logs are streamed to stdout; run `docker logs akroncloud-slot --since 60s` on the VPS.',
        since_ms: sinceMs,
        limit,
      };
    });

    app.post<{ Body: { action?: string; payload?: Record<string, unknown>; timeoutMs?: number } }>(
      '/debug/inject-cmd',
      async (req, reply) => {
        const { action, payload = {}, timeoutMs } = req.body ?? ({} as Record<string, unknown>);
        if (!action) {
          return reply.code(400).send({ ok: false, error: 'action required' });
        }
        log.info({ action, payload, timeoutMs }, 'debug/inject-cmd: dispatching');
        try {
          const result = await deps.tcp.dispatchCommand(
            { action, payload } as unknown as object,
            undefined,
          );
          // override the default timeout if caller asked for one
          // (dispatchCommand uses its own CMD_TIMEOUT_MS constant;
          // for debug purposes we surface what we got, regardless
          // of timeout chosen)
          return { ok: true, result };
        } catch (err) {
          return reply
            .code(503)
            .send({ ok: false, error: (err as Error).message });
        }
      },
    );

    app.post('/debug/cmd-client/reconnect', async () => {
      const wasConnected = deps.cmdClient.isConnected();
      log.warn({ wasConnected }, 'debug/cmd-client/reconnect: forcing reconnect');
      // The client has destroy() but no explicit reconnect; the
      // connect() method runs on idle. We destroy the socket which
      // flips internal state and triggers reconnect on the next
      // idle tick.
      (deps.cmdClient as unknown as { destroy(): void }).destroy();
      // After destroy() the client is unusable for further dispatches;
      // we rebuild it. This is debug-only — production never does this.
      const { Mt5CommandClient } = await import(
        '../services/mt5-command-client.js'
      );
      const fresh = new Mt5CommandClient();
      // Reach back into the TCP server to swap the cmdClient.
      (deps.tcp as unknown as {
        setCommandClient(c: Mt5CommandClient): void;
      }).setCommandClient(fresh);
      return {
        ok: true,
        was_connected: wasConnected,
        note: 'cmdClient replaced; next dispatch will use the fresh instance',
      };
    });

    // debug/ea-minimal: command-port probe. Returns whether anything
    // is bound on 127.0.0.1:7780 (where SlotService.ex5 listens).
    // This is the cheapest check we can do for "did the EA actually
    // start up at all?" — the MT5 /v1/health endpoint already
    // probes this in 1.5s but the operator wants to see it live in
    // a curl-friendly endpoint.
    app.get('/debug/cmd-port', async () => {
      const net = await import('node:net');
      const port = Number(process.env.SLOT_MT5_CMD_PORT ?? 7780);
      const host = process.env.SLOT_MT5_CMD_HOST ?? '127.0.0.1';
      return new Promise<{ ok: boolean; port: number; host: string; state: 'open' | 'closed' | 'unknown'; error?: string }>(
        (resolve) => {
          const sock = net.createConnection({ host, port });
          let state: 'open' | 'closed' = 'closed';
          sock.setTimeout(1500);
          sock.once('connect', () => {
            state = 'open';
            sock.destroy();
            resolve({ ok: true, port, host, state });
          });
          sock.once('timeout', () => {
            sock.destroy();
            resolve({ ok: true, port, host, state: 'unknown', error: 'timeout' });
          });
          sock.once('error', (err) => {
            resolve({ ok: false, port, host, state, error: err.message });
          });
        },
      );
    });
  };
}