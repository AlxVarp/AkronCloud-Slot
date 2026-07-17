import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';

import { type AppConfig } from './config.js';
import { log } from './log.js';
import { openAndMigrate } from './db/migrate.js';
import { accountsRepo, type AccountRow } from './db/index.js';
import { restRoutes } from './api/rest.js';
import { wsRoutes, startConnectorStream } from './api/ws.js';
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
  const connector = makeConnector(cfg.connectorId);
  const deps: Deps = {
    cfg,
    db,
    accounts: accountsRepo(db),
    ledger: makeLedger(db),
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
  await app.register(wsRoutes);

  // Start the per-account connector stream. Persists fills into the
  // ledger so /v1/fills and /v1/positions see broker activity
  // whether or not a WS client is currently subscribed.
  startConnectorStream(deps);

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
