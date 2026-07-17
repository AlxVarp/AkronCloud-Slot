import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import { ProblemError } from '../problem';
import { toPublicAccount } from '../app';

/**
 * REST routes. See SPEC.md § 2.1.
 */

const AccountCreateBody = z.object({
  broker: z.literal('mt5').default('mt5'),
  broker_server: z.string().min(1).max(128),
  broker_login: z.string().min(1).max(128),
  broker_password: z.string().min(1).max(512),
});

const AccountIdParam = z.object({
  id: z.string().uuid(),
});

export async function restRoutes(app: FastifyInstance) {
  // GET /v1/health — unauthenticated.
  app.get('/v1/health', async (_req) => {
    return {
      status: 'ok',
      uptime_s: Math.floor(process.uptime()),
      version: app.deps.cfg ? '0.2.0' : '0.2.0',
      service: 'akroncloud-slot',
      slot_id: app.deps.cfg.slotId,
    };
  });

  // All /v1/* (except /v1/health) require an authenticated slot
  // caller with tenant_id matching the slot's tenant. Specific
  // endpoints add `slot:write` etc. Scope checks are enforced in
  // `authenticate()` below.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/v1/health') return; // public

    const token = app.deps.auth.extractBearer(
      req.headers.authorization as string | undefined,
    );
    if (!token) {
      throw new ProblemError({
        status: 401,
        code: 'UNAUTHENTICATED',
        title: 'Missing Authorization header',
      });
    }

    const claims = await app.deps.auth.verifyToken(token, {
      secret: app.deps.cfg.jwtSecret,
      expectedTenantId: app.deps.cfg.tenantId,
      expectedSlotId: app.deps.cfg.slotId,
    });
    // Stash claims so handlers can do additional scope checks.
    (req as unknown as { claims: typeof claims }).claims = claims;
    void reply;
  });

  // POST /v1/accounts — provision a broker account.
  app.post('/v1/accounts', async (req, reply) => {
    requireScope(req, 'slot:write');

    const body = AccountCreateBody.parse((req as unknown as { body: unknown }).body);
    const claims = (req as unknown as { claims: { tenant_id: string } }).claims;

    const id = randomUUID();
    const now = Date.now();

    const packed = app.deps.crypto.encrypt(
      app.deps.cfg.encryptionKey,
      claims.tenant_id,
      Buffer.from(body.broker_password, 'utf8'),
    );

    app.deps.accounts.insert({
      id,
      tenant_id: claims.tenant_id,
      slot_id: app.deps.cfg.slotId,
      broker: body.broker,
      broker_server: body.broker_server,
      broker_login: body.broker_login,
      encrypted_creds: packed.packed,
      status: 'pending_validation',
      created_at: now,
      updated_at: now,
    });

    reply.status(202);
    return toPublicAccount(
      app.deps.accounts.get(claims.tenant_id, id)!,
    );
  });

  // GET /v1/accounts/:id — read account status.
  app.get<{ Params: { id: string } }>('/v1/accounts/:id', async (req) => {
    requireScope(req, 'slot:read');
    const { id } = AccountIdParam.parse(req.params);
    const claims = (req as unknown as { claims: { tenant_id: string } }).claims;
    const row = app.deps.accounts.get(claims.tenant_id, id);
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
}

/** Throw FORBIDDEN unless the request's token carries `scope`. */
function requireScope(
  req: unknown,
  scope: 'slot:read' | 'slot:write' | 'slot:stream',
): void {
  const claims = (req as { claims?: { scope: string[] } }).claims;
  if (!claims?.scope.includes(scope)) {
    throw new ProblemError({
      status: 403,
      code: 'FORBIDDEN',
      title: `Missing scope: ${scope}`,
    });
  }
}
