import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type Deps } from '../app.js';
import { ProblemError } from '../problem.js';
import type { Scope } from '../auth.js';

/**
 * Trading API — v0.4.
 *
 * JWT-protected REST surface that exposes all 12 SlotService.mq5
 * commands plus a few shape conveniences (close-position-by-id,
 * modify-by-id). Single-account slot: the configured account is
 * implied, callers don't supply it. The cerebro (or any caller with
 * a SLOT_JWT_SECRET-signed token) can drive the slot from outside.
 *
 * Endpoint → SlotService.action mapping:
 *
 *   GET    /v1/symbols               → symbols
 *   GET    /v1/symbols/:symbol       → symbol
 *   GET    /v1/quote                 → quote
 *   GET    /v1/account               → account
 *   GET    /v1/positions             → positions
 *   POST   /v1/positions/:id/close   → close
 *   PATCH  /v1/positions/:id         → modify_position
 *   GET    /v1/orders                → orders
 *   POST   /v1/orders                → open
 *   GET    /v1/orders/:id            → orders (filter by ticket)
 *   DELETE /v1/orders/:id            → cancel
 *   PATCH  /v1/orders/:id            → sltp
 *   GET    /v1/fills                 → history
 *
 * Scopes:
 *   slot:read   — all GET endpoints
 *   slot:write  — POST/PATCH/DELETE
 */

const ReadScope: Scope = 'slot:read';
const WriteScope: Scope = 'slot:write';

const QuerySymbolsSchema = z.object({
  pattern: z.string().optional(),
  market_watch_only: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
});

const QueryQuoteSchema = z.object({
  symbol: z.string().min(1),
});

const QueryFillsSchema = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const PlaceOrderSchema = z.object({
  side: z.enum(['buy', 'sell']),
  instrument: z.string().min(1),
  qty: z.number().positive(),
  type: z.enum(['market', 'limit', 'stop']).default('market'),
  price: z.number().positive().optional(),
  sl: z.number().positive().optional(),
  tp: z.number().positive().optional(),
  client_order_id: z.string().optional(),
  comment: z.string().max(64).optional(),
});

const ClosePositionSchema = z.object({
  volume: z.number().positive().optional(),
});

const ModifyPositionSchema = z
  .object({
    sl: z.number().nullable().optional(),
    tp: z.number().nullable().optional(),
  })
  .refine((v) => v.sl !== undefined || v.tp !== undefined, {
    message: 'at least one of sl, tp must be provided',
  });

const ModifyOrderSchema = z
  .object({
    sl: z.number().nullable().optional(),
    tp: z.number().nullable().optional(),
  })
  .refine((v) => v.sl !== undefined || v.tp !== undefined, {
    message: 'at least one of sl, tp must be provided',
  });

/**
 * Resolve the single configured account for this slot. The slot is
 * single-tenant; the first active account under `cfg.tenantId` wins.
 * Throws ProblemError(404) if no account exists yet — callers must
 * onboard via the mobile wrapper first.
 */
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
        'through the mobile wrapper to provision one, then retry.',
    });
  }
  const accountRef = `${deps.connector.id}-${row.broker_server}-${row.broker_login}`;
  return { accountRef, brokerLogin: row.broker_login };
}

/**
 * Wrap a connector call so dispatch failures surface as Problem+JSON
 * 502 (broker down) instead of raw stack traces. The connector throws
 * plain Errors; we map known patterns to structured responses.
 */
async function withBrokerErrors<T>(
  req: FastifyRequest,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = (e as Error).message ?? 'broker_error';
    if (
      msg.includes('mt5_disconnected')
      || msg.includes('mt5_socket_not_connected')
      || msg.includes('mt5_timeout')
    ) {
      throw new ProblemError({
        status: 502,
        code: 'BROKER_DOWN',
        title: 'Broker unreachable',
        detail: msg,
      });
    }
    req.log.warn({ err: msg }, 'trading: broker dispatch failed');
    throw new ProblemError({
      status: 502,
      code: 'BROKER_DOWN',
      title: 'Broker dispatch failed',
      detail: msg,
    });
  }
}

/**
 * Build the auth pre-handler for a given scope. Runs before every
 * protected route. Returns 401/403 Problem+JSON on failure.
 */
function requireScope(deps: Deps, scope: Scope) {
  return async (req: FastifyRequest) => {
    const token = deps.auth.extractBearer(
      req.headers.authorization as string | undefined,
    );
    if (!token) {
      throw new ProblemError({
        status: 401,
        code: 'UNAUTHENTICATED',
        title: 'Missing bearer token',
        detail: 'Authorization: Bearer <token> header required',
      });
    }
    await deps.auth.verifyToken(token, {
      secret: deps.cfg.jwtSecret,
      expectedTenantId: deps.cfg.tenantId,
      expectedSlotId: deps.cfg.slotId,
      requiredScopes: [scope],
    });
  };
}

export async function tradingRoutes(app: FastifyInstance): Promise<void> {
  const deps = app.deps as Deps;

  // ─────── READ endpoints (slot:read) ───────

  app.get(
    '/v1/symbols',
    { preHandler: requireScope(deps, ReadScope) },
    async (req) => {
      const q = QuerySymbolsSchema.parse(req.query ?? {});
      const { accountRef } = resolveAccountRef(deps);
      return withBrokerErrors(req, () =>
        deps.connector.symbols(accountRef, {
          pattern: q.pattern,
          marketWatchOnly: q.market_watch_only,
        }).then((symbols) => ({ count: symbols.length, symbols })),
      );
    },
  );

  app.get<{ Params: { symbol: string } }>(
    '/v1/symbols/:symbol',
    { preHandler: requireScope(deps, ReadScope) },
    async (req) => {
      const { accountRef } = resolveAccountRef(deps);
      return withBrokerErrors(req, async () => {
        const detail = await deps.connector.getSymbol(
          accountRef,
          req.params.symbol,
        );
        return { ...detail, symbol: req.params.symbol };
      });
    },
  );

  app.get(
    '/v1/quote',
    { preHandler: requireScope(deps, ReadScope) },
    async (req) => {
      const q = QueryQuoteSchema.parse(req.query ?? {});
      const { accountRef } = resolveAccountRef(deps);
      return withBrokerErrors(req, () =>
        deps.connector.quote(accountRef, q.symbol),
      );
    },
  );

  app.get(
    '/v1/account',
    { preHandler: requireScope(deps, ReadScope) },
    async (req) => {
      const { accountRef } = resolveAccountRef(deps);
      return withBrokerErrors(req, () =>
        deps.connector.getAccount(accountRef),
      );
    },
  );

  app.get(
    '/v1/positions',
    { preHandler: requireScope(deps, ReadScope) },
    async (req) => {
      const { accountRef } = resolveAccountRef(deps);
      return withBrokerErrors(req, async () => {
        const positions = await deps.connector.getPositions(accountRef);
        return { count: positions.length, positions };
      });
    },
  );

  app.get(
    '/v1/orders',
    { preHandler: requireScope(deps, ReadScope) },
    async (req) => {
      const { accountRef } = resolveAccountRef(deps);
      return withBrokerErrors(req, async () => {
        const orders = await deps.connector.getOrders(accountRef);
        return { count: orders.length, orders };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/orders/:id',
    { preHandler: requireScope(deps, ReadScope) },
    async (req) => {
      const { accountRef } = resolveAccountRef(deps);
      const orderId = req.params.id;
      return withBrokerErrors(req, async () => {
        const orders = await deps.connector.getOrders(accountRef);
        const found = orders.find(
          (o) => String(o.ticket) === String(orderId),
        );
        if (!found) {
          throw new ProblemError({
            status: 404,
            code: 'NOT_FOUND',
            title: 'Order not found',
            detail: `no pending order with ticket=${orderId}`,
          });
        }
        return found;
      });
    },
  );

  app.get(
    '/v1/fills',
    { preHandler: requireScope(deps, ReadScope) },
    async (req) => {
      const q = QueryFillsSchema.parse(req.query ?? {});
      const { accountRef } = resolveAccountRef(deps);
      return withBrokerErrors(req, async () => {
        const deals = await deps.connector.getHistory(accountRef, {
          from: q.from,
          to: q.to,
          limit: q.limit,
        });
        return { count: deals.length, history: deals };
      });
    },
  );

  // ─────── WRITE endpoints (slot:write) ───────

  app.post(
    '/v1/orders',
    { preHandler: requireScope(deps, WriteScope) },
    async (req) => {
      const body = PlaceOrderSchema.parse(req.body ?? {});
      const { accountRef } = resolveAccountRef(deps);
      const result = await withBrokerErrors(req, () =>
        deps.connector.openTrade(accountRef, {
          instrument: body.instrument,
          side: body.side,
          qty: body.qty,
          type: body.type,
          price: body.price,
          sl: body.sl,
          tp: body.tp,
        }),
      );
      return result;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/positions/:id/close',
    { preHandler: requireScope(deps, WriteScope) },
    async (req) => {
      const body = ClosePositionSchema.parse(req.body ?? {});
      const { accountRef } = resolveAccountRef(deps);
      const result = await withBrokerErrors(req, () =>
        deps.connector.closeTrade(accountRef, req.params.id, body.volume),
      );
      return result;
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/v1/positions/:id',
    { preHandler: requireScope(deps, WriteScope) },
    async (req) => {
      const body = ModifyPositionSchema.parse(req.body ?? {});
      const { accountRef } = resolveAccountRef(deps);
      return withBrokerErrors(req, () =>
        deps.connector.modifyPosition(
          accountRef,
          req.params.id,
          body.sl ?? null,
          body.tp ?? null,
        ),
      );
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/v1/orders/:id',
    { preHandler: requireScope(deps, WriteScope) },
    async (req) => {
      const body = ModifyOrderSchema.parse(req.body ?? {});
      const { accountRef } = resolveAccountRef(deps);
      return withBrokerErrors(req, () =>
        deps.connector.modifyOrder(
          accountRef,
          req.params.id,
          body.sl ?? null,
          body.tp ?? null,
        ),
      );
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/orders/:id',
    { preHandler: requireScope(deps, WriteScope) },
    async (req) => {
      const { accountRef } = resolveAccountRef(deps);
      return withBrokerErrors(req, () =>
        deps.connector.cancelOrder(accountRef, req.params.id),
      );
    },
  );
}