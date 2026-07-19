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
    .pane#done { padding: 20px; background: #13733311; }
    .pane#done h2 { background: transparent; border: 0; color: #137333; }
    pre.examples { background: #0d1117; color: #c9d1d9; padding: 12px; border-radius: 6px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>akroncloud-slot · broker onboarding</h1>
  <p class="lede">tenant <code>${tenantHint}</code> · slot runs MetaTrader&nbsp;5 inside this container. Open the desktop on the left, log into your broker. The slot's login detector will flip this page to operational automatically and close the VNC.</p>

  <div id="syncbar" style="margin: 0 0 20px; padding: 12px 16px; border: 1px solid #c9d1d9; border-radius: 8px; background: #f6f8fa; display: flex; gap: 12px; align-items: center;">
    <strong style="font-size: 13px;">Sync</strong>
    <span class="hint" style="flex: 1;">Click after broker login: re-runs the validator and re-publishes the login command to ZMQ. If the slot's <code>PublisherZMQEvents.ex5</code> is attached, fills + account_status flow within seconds.</span>
    <button type="button" id="sync_btn" style="background:#137333;">Sync</button>
    <button type="button" id="sync_state_btn" style="background:#6e7681;">Refresh state</button>
  </div>
  <pre id="sync_out" class="out" hidden></pre>

  <div class="row" id="pending_row">
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
        <p class="hint">Backup path. Normally the slot auto-detects the broker login via X11 window watcher and kills the VNC chain on its own. The form is here for users who skip the VNC step (e.g. running the slot in a CI-like context).</p>
      </form>
      <pre id="out" class="out" hidden></pre>
    </div>
  </div>

  <div id="done" style="display:none">
    <div class="pane" id="done">
      <h2>Operational</h2>
      <p>Slot is live. VNC has been closed. The MT5 session inside the container is now the source of truth for trades; the slot is bridging fills + order state into the local ledger via ZMQ. Use the REST API below.</p>
      <p class="hint">VNC is gone. Reopen this page anytime to see the curl examples below.</p>
      <pre class="examples"># mint a token (token expires in 1h)
TOKEN=$(curl -s http://localhost:7777/v1/health &gt;/dev/null; curl -s http://localhost:7777/connect | grep -oE 'eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+' | head -1)

# list accounts (if you submitted via the form above)
curl -H "Authorization: Bearer $TOKEN" http://localhost:7777/v1/accounts/&lt;id&gt;

# place a market order
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"account_id":"&lt;id&gt;","instrument":"EURUSD","side":"buy","qty":0.1,"type":"market"}' \
  http://localhost:7777/v1/orders

# list positions
curl -H "Authorization: Bearer $TOKEN" "http://localhost:7777/v1/positions?account_id=&lt;id&gt;"

# stream fills/quotes via WebSocket
wscat -c "ws://localhost:7777/v1/stream?account_id=&lt;id&gt;" -H "Authorization: Bearer $TOKEN"
</pre>
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

  // Poll /v1/lifecycle. When the slot transitions to 'operational',
  // hide the VNC pane and show the operational pane.
  let lastState = null;
  async function poll() {
    try {
      const r = await fetch('/v1/lifecycle');
      if (!r.ok) return;
      const j = await r.json();
      if (j.state === 'operational' && lastState !== 'operational') {
        document.getElementById('pending_row').style.display = 'none';
        document.getElementById('done').style.display = 'block';
        document.title = 'akroncloud-slot — operational';
      } else if (j.state === 'pending_login' && lastState !== 'pending_login') {
        document.getElementById('pending_row').style.display = 'grid';
        document.getElementById('done').style.display = 'none';
      }
      lastState = j.state;
    } catch {}
  }
  poll();
  setInterval(poll, 2000);

  // Sync button: POST /v1/sync to re-trigger the validator. The endpoint
  // re-publishes the login command on the MT5 ZMQ outbound. If the
  // PublisherZMQEvents.ex5 is attached to a chart, the slot starts
  // receiving account_status + fills within seconds.
  const syncBtn = document.getElementById('sync_btn');
  const syncStateBtn = document.getElementById('sync_state_btn');
  const syncOut = document.getElementById('sync_out');
  function showSync(label, body, kind) {
    syncOut.hidden = false;
    syncOut.classList.remove('ok', 'err');
    if (kind) syncOut.classList.add(kind);
    syncOut.textContent = label + '\\n\\n' + JSON.stringify(body, null, 2);
  }
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true; syncBtn.textContent = 'Syncing...';
    showSync('POST /v1/sync ...', { status: 'pending' });
    try {
      const r = await fetch('/v1/sync', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + tok },
      });
      const j = await r.json().catch(() => ({}));
      showSync('HTTP ' + r.status + ' — /v1/sync', j, r.ok ? 'ok' : 'err');
    } catch (e) {
      showSync('Network error: ' + e.message, {}, 'err');
    } finally {
      syncBtn.disabled = false; syncBtn.textContent = 'Sync';
    }
  });
  syncStateBtn.addEventListener('click', async () => {
    syncStateBtn.disabled = true; syncStateBtn.textContent = 'Loading...';
    try {
      const [v1health, v1accounts, v1state, v1positions, v1fills] = await Promise.all([
        fetch('/v1/health').then(r => r.json()).catch(() => ({})),
        fetch('/v1/accounts', { headers: { 'Authorization': 'Bearer ' + tok } }).then(r => r.json()).catch(() => ({})),
        fetch('/v1/state',    { headers: { 'Authorization': 'Bearer ' + tok } }).then(r => r.json()).catch(() => ({})),
        fetch('/v1/positions', { headers: { 'Authorization': 'Bearer ' + tok } }).then(r => r.json()).catch(() => ({})),
        fetch('/v1/fills',     { headers: { 'Authorization': 'Bearer ' + tok } }).then(r => r.json()).catch(() => ({})),
      ]);
      showSync('GET /v1/health + /v1/state + /v1/accounts + /v1/positions + /v1/fills',
        { health: v1health, accounts: v1accounts, state: v1state, positions: v1positions, fills: v1fills },
        'ok');
    } catch (e) {
      showSync('Network error: ' + e.message, {}, 'err');
    } finally {
      syncStateBtn.disabled = false; syncStateBtn.textContent = 'Refresh state';
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

  // All /v1/* (except /v1/health, /v1/lifecycle, /connect) require auth.
  app.addHook('onRequest', async (req, _reply) => {
    if (
      req.url === '/v1/health' ||
      req.url === '/v1/lifecycle' ||
      req.url === '/connect' ||
      req.url?.startsWith('/connect?')
    ) {
      return;
    }

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

  // POST /v1/sync — re-trigger broker session + account_status events
  // for every account in the tenant. Useful when the SlotService.mq5
  // auto-attach didn't fire on boot (e.g. MT5 build 5836 has services
  // off by default, see SlotService commit history). The handler
  // re-runs the validator for every account, which:
  //   1. re-decrypts the password
  //   2. calls connector.connect() → re-publishes the login command
  //      to ZMQ outbound tcp://5556
  //   3. waits up to 15s for an inbound account_status event
  //
  // If the PublisherZMQEvents.ex5 is attached to a chart, the slot
  // will start seeing account_status + fill events within seconds.
  // If it isn't, the call is a no-op (commands go nowhere, no fills
  // arrive) and the user gets a clear hint in the response.
  app.post('/v1/sync', async (req) => {
    requireScope(req, 'slot:write');
    const c = getClaims(req);
    const accounts = deps.accounts.list(c.tenant_id);
    const triggered: Array<{
      id: string;
      broker_server: string;
      broker_login: string;
      previous_status: string;
    }> = [];
    for (const row of accounts) {
      if (row.status === 'disabled') continue;
      triggered.push({
        id: row.id,
        broker_server: row.broker_server,
        broker_login: row.broker_login,
        previous_status: row.status,
      });
      validateAccount(deps, c.tenant_id, row);
    }
    return {
      triggered_at: Date.now(),
      accounts: triggered,
      hint:
        accounts.length === 0
          ? 'No accounts yet. POST /v1/accounts to provision one, or just hit Sync after a manual MT5 login (it will create one on the next event).'
          : 'Re-validator dispatched for every account. The MT5 connector republished the login command to ZMQ outbound. If PublisherZMQEvents.ex5 is attached to a chart, account_status + fills will flow within seconds. If the events do not arrive, see Tools → Options → Expert Advisors → Allow services in the MT5 client.',
    };
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

  // GET /v1/lifecycle — slot lifecycle state (no auth, no params).
  // Reports whether the slot is in pending_login (VNC up) or
  // operational (VNC killed, full API surface). The login detector
  // updates the underlying state file in the background.
  app.get('/v1/lifecycle', async () => {
    const fn = (app as unknown as { slot_state: () => string }).slot_state;
    return {
      state: fn(),
      slot_id: deps.cfg.slotId,
      tenant_id: deps.cfg.tenantId,
      ts: Date.now(),
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
