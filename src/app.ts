import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';

import { type AppConfig } from './config.js';
import { log } from './log.js';
import { openAndMigrate } from './db/migrate.js';
import { accountsRepo, type AccountRow } from './db/index.js';
import { restRoutes } from './api/rest.js';
import { tradingRoutes } from './api/trading.js';
import { wsRoutes } from './api/ws.js';
import { internalRoutes } from './api/internal.js';
import { registerMobileRoutes } from './web/mobile.js';
import { encrypt, decrypt } from './crypto.js';
import { verifyToken, extractBearer } from './auth.js';
import { ProblemError, type Problem, CODE_TO_STATUS, type ProblemCode } from './problem.js';
import type { BrokerConnector } from './connectors/base.js';
import { makeConnector } from './connectors/index.js';
import { makeLedger, type Ledger } from './ledger.js';

/**
 * Lightweight dependency container shared by routes + workers.
 *
 * Constructed once per Fastify app, attached as `app.deps`. Routes
 * pull this in via `request.server.deps` — no module-level globals.
 */
export type Deps = {
  cfg: AppConfig;
  db: ReturnType<typeof openAndMigrate>;
  accounts: ReturnType<typeof accountsRepo>;
  ledger: Ledger;
  connector: BrokerConnector;
  crypto: { encrypt: typeof encrypt; decrypt: typeof decrypt };
  auth: { verifyToken: typeof verifyToken; extractBearer: typeof extractBearer };
  log: typeof log;
};

export async function buildApp(cfg: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // we use our own pino
    disableRequestLogging: true,
    genReqId: () =>
      // 16 hex chars
      Array.from({ length: 16 }, () =>
        Math.floor(Math.random() * 16).toString(16),
      ).join(''),
  });

  const db = openAndMigrate(cfg.stateDb);
  const ledger = makeLedger(db);

  // Phase C / Ruta B1: always bring up the TCP server. The MT5
  // connector needs it. The legacy ZMQ/file bridge is no longer
  // supported — SlotService.mq5 is TCP-only.
  const { startMt5TcpServer } = await import('./services/mt5-tcp-server.js');
  const mt5Tcp = await startMt5TcpServer({
    ledger,
    resolveAccount: (brokerLogin) => {
      // Phase A: single-account slot. Two fallback levels:
      //
      // 1. Exact match by broker_login when the event includes one
      //    (the v55 MQL5 AccountReporter includes it; the v54 Python
      //    publisher sends events without one, falling through to #2).
      //
      // 2. First active account by created_at when no exact match is
      //    found. This handles two real cases observed in production:
      //    (a) event arrives without a brokerLogin (Python publisher
      //        fallback for Finding C failure)
      //    (b) brokerLogin from MT5 doesn't match the DB row — happens
      //        when the user re-uses the slot image with a different
      //        MT5 login than the one provisioned by the cerebro. The
      //        slot is single-tenant so falling back to the only active
      //        account is the right behavior.
      //
      // The alternative (drop on floor with "no account resolved")
      // was v54's actual behavior and is what the user is trying to
      // escape from.
      if (brokerLogin) {
        const exact = db
          .prepare(
            `SELECT * FROM accounts WHERE broker_login = ? AND status != 'disabled' LIMIT 1`,
          )
          .get(brokerLogin) as AccountRow | undefined;
        if (exact) return exact;
      }
      return db
        .prepare(
          `SELECT * FROM accounts WHERE status != 'disabled' ORDER BY created_at ASC LIMIT 1`,
        )
        .get() as AccountRow | undefined;
    },
  });

  const connector = makeConnector(cfg.connectorId, { db, ledger, tcp: mt5Tcp });
  const deps: Deps = {
    cfg,
    db,
    accounts: accountsRepo(db),
    ledger,
    connector,
    crypto: { encrypt, decrypt },
    auth: { verifyToken, extractBearer },
    log,
  };
  app.decorate('deps', deps);

  await app.register(websocket);

  // Problem+JSON error handler. Always returns RFC 7807 shape, never
  // a stack trace.
  app.setErrorHandler((err, _req, reply) => {
    const req = _req as unknown as { id: string };
    if (err instanceof ProblemError) {
      const p = err.problem;
      if (!p.code) {
        return reply
          .status(p.status ?? 500)
          .send({ ...p, code: 'INTERNAL' as ProblemCode, instance: req.id });
      }
      return reply
        .status(p.status ?? CODE_TO_STATUS[p.code] ?? 500)
        .send({ ...p, instance: req.id });
    }
    // ZodError 400 BAD_REQUEST
    if (err.name === 'ZodError') {
      return reply.status(400).send({
        type: 'about:blank',
        title: 'Validation failed',
        status: 400,
        code: 'BAD_REQUEST' as ProblemCode,
        detail: (err as Error).message,
        instance: req.id,
      });
    }
    // Unknown / 5xx
    log.error({ err: (err as Error).message, stack: (err as Error).stack }, 'unhandled');
    return reply.status(500).send({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      code: 'INTERNAL' as ProblemCode,
      detail: (err as Error).message,
      instance: req.id,
    });
  });

  await app.register(restRoutes);
  await app.register(tradingRoutes);
  await app.register(wsRoutes);
  await app.register(internalRoutes);
  await app.register(registerMobileRoutes);

  // Login detector: watches MT5's window via xdotool, transitions
  // the slot to 'operational' on broker login, kills the VNC chain.
  // Only runs in the combined container image (where xdotool/Xvnc
  // exist). In dev (no MT5) it's a no-op.
  const { startLoginDetector, readSlotState } = await import(
    './services/login-detector.js'
  );

  startLoginDetector({
    onTransition: async () => {
      log.info({ evt: 'login_detected' }, 'slot transitioned to operational');
    },
    // v53: feed {kind:'account', data:{logged_in}} events into the
    // same TCP server the SlotService.ex5 would have used. The
    // detector is the "fast path" until/unless MQL5 services get
    // autostart-able again (see v52 handoff).
    tcp: mt5Tcp,
  });

  // Expose the slot lifecycle state for the /v1/state endpoint.
  // We decorate a getter so the value is re-read on every /v1/state
  // request (the state file is updated by the login detector).
  app.decorate('slot_state', () => readSlotState());

  return app;
}

/** Helper: same shape as a DB AccountRow but expressing the public
 *  view — never include `encrypted_creds`. */
export type PublicAccount = Omit<AccountRow, 'encrypted_creds'>;

export function toPublicAccount(row: AccountRow): PublicAccount {
  const { encrypted_creds: _omit, ...rest } = row;
  return rest;
}

// Augment Fastify with our deps type.
declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps;
  }
}

// Convenience re-export so callers can `import { Problem } from './app.js'`.
export type { Problem };
