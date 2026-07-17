import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import { ProblemError } from '../problem';
import { toPublicAccount, type Deps } from '../app';
import { validateAccount } from '../validator';
import { enforcePreTrade } from '../risk';
import { startReconciler } from '../reconciler';
import type { NewOrder } from '../connectors/base';

/**
 * REST routes. See SPEC.md § 2.1.
 *
 * Auth: a single onRequest hook verifies Bearer + tenant_id +
 * slot_id and stashes `claims` on the request. Per-route scope
 * checks happen inside handlers.
 */

const NewOrderBody = z.object({
  account_id: z.string().uuid(),
  instrument: z.string().min(1).max(32),
  side: z.enum(['buy', 'sell']),
  qty: z.number().positive(),
  type: z.enum(['market', 'limit', 'stop']).default('market'),
  price: z.number().positive().optional(),
  sl: z.number().positive().optional(),
  tp: z.number().positive().optional(),
  reduce_qty: z.number().positive().optional(),
});

const AccountCreateBody = z.object({
  broker: z.literal('mt5').default('mt5'),
  broker_server: z.string().min(1).max(128),
  broker_login: z.string().min(1).max(128),
  broker_password: z.string().min(1).max(512),
});

const AccountIdParam = z.object({
  id: z.string().uuid(),
});

const StateQuery = z.object({
  account_id: z.string().uuid(),
});

const ListQuery = z.object({
  account_id: z.string().uuid(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

export type RouteClaims = {
  sub: string;
  tenant_id: string;
  slot_id: string;
  exp: number;
  scope: ('slot:read' | 'slot:write' | 'slot:stream')[];
};

export async function restRoutes(app: FastifyInstance) {
  const deps = app.deps as Deps;

  // GET /v1/health — unauthenticated.
  app.get('/v1/health', async () => ({
    status: 'ok',
    uptime_s: Math.floor(process.uptime()),
    version: '0.2.0',
    service: 'akroncloud-slot',
    slot_id: deps.cfg.slotId,
    connector: deps.cfg.connectorId,
  }));

  // All /v1/* (except /v1/health) require authentication.
  app.addHook('onRequest', async (req, _reply) => {
    if (req.url === '/v1/health') return;

    const token = deps.auth.extractBearer(
      req.headers.authorization as string | undefined,
    );
    if (!token) {
      throw new ProblemError({
        status: 401,
        code: 'UNAUTHENTICATED',
        title: 'Missing Authorization header',
      });
    }
    const claims = (await deps.auth.verifyToken(token, {
      secret: deps.cfg.jwtSecret,
      expectedTenantId: deps.cfg.tenantId,
      expectedSlotId: deps.cfg.slotId,
    })) as RouteClaims;
    (req as unknown as { claims: RouteClaims }).claims = claims;
  });

  // ────────────── accounts ──────────────

  // POST /v1/accounts — provision + async-validate.
  app.post('/v1/accounts', async (req, reply) => {
    requireScope(req, 'slot:write');
    const body = AccountCreateBody.parse(
      (req as unknown as { body: unknown }).body,
    );
    const c = getClaims(req);

    const id = randomUUID();
    const now = Date.now();

    const packed = deps.crypto.encrypt(
      deps.cfg.encryptionKey,
      c.tenant_id,
      Buffer.from(body.broker_password, 'utf8'),
    );

    deps.accounts.insert({
      id,
      tenant_id: c.tenant_id,
      slot_id: deps.cfg.slotId,
      broker: body.broker,
      broker_server: body.broker_server,
      broker_login: body.broker_login,
      encrypted_creds: packed.packed,
      status: 'validating',
      created_at: now,
      updated_at: now,
    });

    // Async validate-and-save. SPEC § 4.4. The handler returns 202
    // immediately; the validator opens a broker session in the
    // background and flips status to active / error.
    const row = deps.accounts.get(c.tenant_id, id)!;
    validateAccount(deps, c.tenant_id, row);

    reply.status(202);
    return toPublicAccount(row);
  });

  // GET /v1/accounts/:id.
  app.get<{ Params: { id: string } }>('/v1/accounts/:id', async (req) => {
    requireScope(req, 'slot:read');
    const { id } = AccountIdParam.parse(req.params);
    const c = getClaims(req);
    const row = deps.accounts.get(c.tenant_id, id);
    if (!row) {
      throw new ProblemError({
        status: 404,
        code: 'NOT_FOUND',
        title: 'Account not found',
        detail: `id=${id}`,
      });
    }
    return toPublicAccount(row);
  });

  // ────────────── orders ──────────────

  // POST /v1/orders — place a market/limit/stop order.
  app.post('/v1/orders', async (req, reply) => {
    requireScope(req, 'slot:write');
    const body = NewOrderBody.parse((req as unknown as { body: unknown }).body);
    const c = getClaims(req);

    const acct = deps.accounts.get(c.tenant_id, body.account_id);
    if (!acct) {
      throw new ProblemError({
        status: 404,
        code: 'NOT_FOUND',
        title: 'Account not found',
        detail: `id=${body.account_id}`,
      });
    }
    if (acct.status !== 'active') {
      throw new ProblemError({
        status: 409,
        code: 'RISK_BLOCKED',
        title: 'Account is not active',
        detail: `status=${acct.status}`,
      });
    }

    const newOrder: NewOrder = {
      instrument: body.instrument,
      side: body.side,
      qty: body.qty,
      type: body.type,
      price: body.price,
      sl: body.sl,
      tp: body.tp,
      reduce_qty: body.reduce_qty,
    };

    enforcePreTrade(deps, newOrder);

    // Place in the connector first so the broker_order_id maps back
    // into our ledger row.
    const accountRef = `sim-${acct.id}`;
    const result = await deps.connector.openTrade(accountRef, newOrder);
    if (!result.ok) {
      deps.accounts.updateStatus(
        c.tenant_id,
        acct.id,
        'error',
        null,
        result.reason,
        Date.now(),
      );
      throw new ProblemError({
        status: 502,
        code: 'BROKER_DOWN',
        title: 'Broker rejected the order',
        detail: result.reason,
      });
    }

    const row = deps.ledger.insertOrder({
      account_id: acct.id,
      instrument: body.instrument,
      side: body.side,
      qty: body.qty,
      type: body.type,
      price: body.price ?? null,
      sl: body.sl ?? null,
      tp: body.tp ?? null,
      reduce_qty: body.reduce_qty ?? null,
      status: 'pending',
      broker_order_id: result.broker_order_id,
    });

    reply.status(202);
    return {
      id: row.id,
      account_id: row.account_id,
      instrument: row.instrument,
      side: row.side,
      qty: row.qty,
      type: row.type,
      status: row.status,
      broker_order_id: row.broker_order_id,
      ts_open: row.ts_open,
    };
  });

  // GET /v1/orders?account_id=&limit=
  app.get('/v1/orders', async (req) => {
    requireScope(req, 'slot:read');
    const q = ListQuery.parse((req as unknown as { query: unknown }).query);
    const c = getClaims(req);
    const acct = deps.accounts.get(c.tenant_id, q.account_id);
    if (!acct) {
      throw new ProblemError({
        status: 404,
        code: 'NOT_FOUND',
        title: 'Account not found',
        detail: `id=${q.account_id}`,
      });
    }
    return {
      account_id: q.account_id,
      orders: deps.ledger.listOrders(q.account_id, q.limit ?? 100).map(serializeOrder),
    };
  });

  // GET /v1/orders/:id — single order by id. account_id is parsed from query.
  app.get<{ Params: { id: string } }>('/v1/orders/:id', async (req) => {
    requireScope(req, 'slot:read');
    const { id } = AccountIdParam.parse(req.params);
    const q = StateQuery.parse((req as unknown as { query: unknown }).query);
    const c = getClaims(req);
    const acct = deps.accounts.get(c.tenant_id, q.account_id);
    if (!acct) {
      throw new ProblemError({
        status: 404,
        code: 'NOT_FOUND',
        title: 'Account not found',
        detail: `id=${q.account_id}`,
      });
    }
    const row = deps.ledger.getOrder(q.account_id, id);
    if (!row) {
      throw new ProblemError({
        status: 404,
        code: 'NOT_FOUND',
        title: 'Order not found',
        detail: `id=${id}`,
      });
    }
    return serializeOrder(row);
  });

  // ────────────── fills / positions / state ──────────────

  // GET /v1/fills?account_id=&limit=
  app.get('/v1/fills', async (req) => {
    requireScope(req, 'slot:read');
    const q = ListQuery.parse((req as unknown as { query: unknown }).query);
    const c = getClaims(req);
    if (!deps.accounts.get(c.tenant_id, q.account_id)) {
      throw new ProblemError({
        status: 404,
        code: 'NOT_FOUND',
        title: 'Account not found',
      });
    }
    return {
      account_id: q.account_id,
      fills: deps.ledger.listFills(q.account_id, q.limit ?? 200),
    };
  });

  // GET /v1/positions?account_id=
  app.get('/v1/positions', async (req) => {
    requireScope(req, 'slot:read');
    const q = StateQuery.parse((req as unknown as { query: unknown }).query);
    const c = getClaims(req);
    if (!deps.accounts.get(c.tenant_id, q.account_id)) {
      throw new ProblemError({
        status: 404,
        code: 'NOT_FOUND',
        title: 'Account not found',
      });
    }
    return {
      account_id: q.account_id,
      positions: deps.ledger.positionsFor(q.account_id),
    };
  });

  // GET /v1/state?account_id=
  app.get('/v1/state', async (req) => {
    requireScope(req, 'slot:read');
    const q = StateQuery.parse((req as unknown as { query: unknown }).query);
    const c = getClaims(req);
    const acct = deps.accounts.get(c.tenant_id, q.account_id);
    if (!acct) {
      throw new ProblemError({
        status: 404,
        code: 'NOT_FOUND',
        title: 'Account not found',
      });
    }
    const accountRef = `sim-${acct.id}`;
    let connectorState;
    try {
      connectorState = await deps.connector.state(accountRef);
    } catch (e) {
      connectorState = {
        accountRef,
        loggedIn: false,
        lastError: (e as Error).message,
      };
    }
    return {
      account_id: acct.id,
      status: acct.status,
      broker_server: acct.broker_server,
      broker_login: acct.broker_login,
      last_validation_ts: acct.last_validation_ts,
      last_error: acct.last_error,
      connector: connectorState,
      positions: deps.ledger.positionsFor(q.account_id),
    };
  });

  // GET /v1/balance?account_id=  (Phase B: read-only balance from
  // connector.state(). Phase C+: aggregated with the cerebro).
  app.get('/v1/balance', async (req) => {
    requireScope(req, 'slot:read');
    const q = StateQuery.parse((req as unknown as { query: unknown }).query);
    const c = getClaims(req);
    const acct = deps.accounts.get(c.tenant_id, q.account_id);
    if (!acct) {
      throw new ProblemError({
        status: 404,
        code: 'NOT_FOUND',
        title: 'Account not found',
      });
    }
    const accountRef = `sim-${acct.id}`;
    const st = await deps.connector.state(accountRef);
    return {
      account_id: acct.id,
      broker_login: acct.broker_login,
      balance: st.balance ?? null,
      margin: st.margin ?? null,
    };
  });

  // ────────────── reconciler ──────────────
  startReconciler(deps);
}

function getClaims(req: unknown): RouteClaims {
  const c = (req as { claims?: RouteClaims }).claims;
  if (!c) throw new Error('no claims on request — auth hook missing?');
  return c;
}

function serializeOrder(o: {
  id: string;
  account_id: string;
  instrument: string;
  side: 'buy' | 'sell';
  qty: number;
  type: string;
  price: number | null;
  sl: number | null;
  tp: number | null;
  reduce_qty: number | null;
  status: string;
  broker_order_id: string | null;
  ts_open: number | null;
  ts_close: number | null;
}) {
  return {
    id: o.id,
    account_id: o.account_id,
    instrument: o.instrument,
    side: o.side,
    qty: o.qty,
    type: o.type,
    price: o.price,
    sl: o.sl,
    tp: o.tp,
    reduce_qty: o.reduce_qty,
    status: o.status,
    broker_order_id: o.broker_order_id,
    ts_open: o.ts_open,
    ts_close: o.ts_close,
  };
}

function requireScope(
  req: unknown,
  scope: 'slot:read' | 'slot:write' | 'slot:stream',
): void {
  const c = getClaims(req);
  if (!c.scope.includes(scope)) {
    throw new ProblemError({
      status: 403,
      code: 'FORBIDDEN',
      title: `Missing scope: ${scope}`,
    });
  }
}
