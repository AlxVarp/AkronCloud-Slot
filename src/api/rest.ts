import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import { ProblemError } from '../problem.js';
import { toPublicAccount, type Deps } from '../app.js';
import { validateAccount } from '../validator.js';
import { enforcePreTrade } from '../risk.js';
import { startReconciler } from '../reconciler.js';
import type { NewOrder } from '../connectors/base.js';
import { signToken } from '../auth.js';

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

/**
 * HTML page rendered at GET /connect. The Phase B-real flow shows a
 * noVNC iframe pointing at the in-container KasmVNC gateway so the
 * user can do the broker login in MetaTrader, then submit the same
 * credentials through the form below (the slot can't see what the
 * user typed in MT5 directly without a desktop-bridge we haven't
 * built yet — Phase C). The form mints a one-shot bootstrap JWT so
 * the browser can POST /v1/accounts without an out-of-band token.
 */
function connectPage(opts: { bootstrapToken: string; tenantHint: string }): string {
  const { bootstrapToken, tenantHint } = opts;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>akroncloud-slot — broker onboarding</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 1080px; margin: 0 auto; padding: 24px; color: #111; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p.lede { margin: 0 0 24px; color: #555; font-size: 14px; }
    .row { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; }
    .pane { border: 1px solid #ddd; border-radius: 8px; overflow: hidden; }
    .pane h2 { margin: 0; padding: 12px 16px; font-size: 14px; background: #f6f6f6; border-bottom: 1px solid #ddd; }
    iframe { width: 100%; height: 540px; border: 0; display: block; background: #000; }
    form { padding: 16px; display: grid; gap: 12px; }
    label { font-size: 12px; color: #444; display: grid; gap: 4px; }
    input { font: inherit; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; }
    button { font: inherit; padding: 10px 14px; border: 0; border-radius: 6px; background: #1f6feb; color: white; cursor: pointer; }
    button[disabled] { background: #888; cursor: not-allowed; }
    pre.out { background: #0d1117; color: #c9d1d9; padding: 12px; border-radius: 6px; overflow: auto; max-height: 220px; white-space: pre-wrap; }
    .ok { color: #137333; font-weight: 600; }
    .err { color: #b3261e; font-weight: 600; }
    .hint { font-size: 12px; color: #777; }
  </style>
</head>
<body>
  <h1>akroncloud-slot · broker onboarding</h1>
  <p class="lede">tenant <code>${tenantHint}</code> · slot runs MetaTrader&nbsp;5 inside this container. Open the desktop on the left, log into your broker, then submit the same credentials below so the slot can encrypt them and the API can take over.</p>

  <div class="row">
    <div class="pane">
      <h2>VNC (MetaTrader 5 desktop)</h2>
      <iframe src="http://localhost:3000" sandbox="allow-same-origin allow-scripts"></iframe>
    </div>

    <div class="pane">
      <h2>Submit broker credentials</h2>
      <form id="f">
        <label>Broker server (e.g. ICMarkets-Demo01)
          <input name="server" required autocomplete="off" placeholder="Deriv-Server">
        </label>
        <label>MT5 login number
          <input name="login" required inputmode="numeric" autocomplete="off" placeholder="12345678">
        </label>
        <label>MT5 password
          <input name="password" required type="password" autocomplete="off">
        </label>
        <button type="submit" id="go">Submit &amp; take over</button>
        <p class="hint">Submitting flips the slot from <code>pending_login</code> to <code>operational</code>. The slot encrypts the password (AES-256-GCM, per-tenant derived key), stores it in SQLite, then keeps the broker session open via the in-process connector. From here on, <code>POST /v1/orders</code>, <code>GET /v1/positions</code>, <code>WS /v1/stream</code> etc. all come online.</p>
      </form>
      <pre id="out" class="out" hidden></pre>
    </div>
  </div>

  <script>
  const form = document.getElementById('f');
  const btn = document.getElementById('go');
  const out = document.getElementById('out');
  const tok = ${JSON.stringify(bootstrapToken)};

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true; btn.textContent = 'Submitting...';
    out.hidden = false; out.textContent = 'POST /v1/accounts ...';
    const data = new FormData(form);
    const body = JSON.stringify({
      broker: 'mt5',
      broker_server: data.get('server'),
      broker_login: data.get('login'),
      broker_password: data.get('password'),
    });
    try {
      const res = await fetch('/v1/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
        body,
      });
      const j = await res.json().catch(() => ({}));
      out.textContent = 'HTTP ' + res.status + '\\n' + JSON.stringify(j, null, 2);
      if (res.status === 202) {
        out.classList.add('ok'); out.classList.remove('err');
      } else {
        out.classList.add('err'); out.classList.remove('ok');
        btn.disabled = false; btn.textContent = 'Retry';
      }
    } catch (e) {
      out.textContent = 'Network error: ' + e.message;
      out.classList.add('err');
      btn.disabled = false; btn.textContent = 'Retry';
    }
  });
  </script>
</body>
</html>`;
}

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

  // GET /connect — broker-onboarding HTML page. Embedded with a
  // short-lived bootstrap JWT that the user can present to
  // POST /v1/accounts without an out-of-band token. This is the
  // only entry point while the slot is in pending_login. Once the
  // user POSTs broker creds, the slot flips to operational and the
  // user gets a full REST/WS API surface.
  app.get('/connect', async (_req, reply) => {
    const bootstrap = await signToken(
      {
        sub: 'bootstrap',
        tenant_id: deps.cfg.tenantId,
        slot_id: deps.cfg.slotId,
        scope: ['slot:write'],
      },
      { secret: deps.cfg.jwtSecret, ttlSeconds: 15 * 60 },
    );
    reply.type('text/html').send(
      connectPage({ bootstrapToken: bootstrap, tenantHint: deps.cfg.tenantId }),
    );
  });

  // All /v1/* (except /v1/health and /connect) require authentication.
  app.addHook('onRequest', async (req, _reply) => {
    if (req.url === '/v1/health' || req.url === '/connect' || req.url?.startsWith('/connect?')) return;

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
    // into our ledger row. The SimConnector (and the future real
    // MT5 connector) deterministically derives its accountRef from
    // (broker_server, broker_login).
    const accountRef = `sim-${acct.broker_server}-${acct.broker_login}`;
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
    const accountRef = `sim-${acct.broker_server}-${acct.broker_login}`;
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
    const accountRef = `sim-${acct.broker_server}-${acct.broker_login}`;
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
