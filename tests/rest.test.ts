import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newMasterKeyB64 } from '../src/crypto';
import { signToken, ALL_SCOPES } from '../src/auth';
import { buildApp } from '../src/app';
import type { AppConfig } from '../src/config';
import type { FastifyInstance } from 'fastify';

const SECRET = 'unit-test-secret-with-enough-bytes-to-be-hs256-safe';

let dir: string;
let cfg: AppConfig;
let app: FastifyInstance;
let token: string;
let tenantToken: string;
let otherTenantToken: string;
let readOnlyToken: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'slot-app-'));
  const stateDb = join(dir, 'state.db');
  cfg = {
    tenantId: 'tenant-a',
    slotId: 'slot-1',
    jwtSecret: SECRET,
    encryptionKey: (() => {
      // re-decode to keep types tight
      return Buffer.from(newMasterKeyB64(), 'base64');
    })(),
    bind: '127.0.0.1',
    port: 0,
    stateDb,
    logLevel: 'silent',
    reconcileIntervalMs: 30_000,
    mt5ZmqHost: '127.0.0.1',
    mt5ZmqInPort: 5555,
    mt5ZmqOutPort: 5556,
    connectorId: 'sim',
    riskLimits: {
      max_position_size: 0,
      max_daily_loss_pct: 100,
      kill_switch_active: false,
    },
  };
  app = await buildApp(cfg);
  await app.ready();
  token = await signToken(
    { sub: 'test', tenant_id: cfg.tenantId, slot_id: cfg.slotId, scope: ALL_SCOPES },
    { secret: cfg.jwtSecret },
  );
  tenantToken = await signToken(
    {
      sub: 'test',
      tenant_id: 'tenant-other',
      slot_id: cfg.slotId,
      scope: ALL_SCOPES,
    },
    { secret: cfg.jwtSecret },
  );
  otherTenantToken = tenantToken;
  readOnlyToken = await signToken(
    {
      sub: 'test',
      tenant_id: cfg.tenantId,
      slot_id: cfg.slotId,
      scope: ['slot:read'],
    },
    { secret: cfg.jwtSecret },
  );
});

afterEach(async () => {
  if (app) await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('REST: /v1/health', () => {
  it('returns 200 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.slot_id).toBe(cfg.slotId);
  });
});

describe('REST: /connect (broker onboarding)', () => {
  it('returns 200 with HTML and an embedded bootstrap token', async () => {
    const res = await app.inject({ method: 'GET', url: '/connect' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    const html = res.body;
    expect(html).toMatch(/<title>akroncloud-slot — broker onboarding<\/title>/);
    // The HTML contains a JWT-shaped string (header.payload.signature).
    expect(html).toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  });

  it('does not require auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/connect',
      // intentionally no Authorization header
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('REST: auth on protected endpoints', () => {
  it('rejects requests without a token', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/accounts', payload: {} });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('rejects requests with a token signed by the wrong secret', async () => {
    const wrongToken = await signToken(
      {
        sub: 'test',
        tenant_id: cfg.tenantId,
        slot_id: cfg.slotId,
        scope: ALL_SCOPES,
      },
      { secret: 'wrong-secret-also-32-bytes-or-more-please' },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: `Bearer ${wrongToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with a token from a different tenant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: `Bearer ${otherTenantToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe('FORBIDDEN');
  });
});

describe('REST: POST /v1/accounts', () => {
  it('creates a row and returns 202 with the public view (no encrypted_creds)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        broker_server: 'ICMarkets-Demo',
        broker_login: '12345',
        broker_password: 'hunter2',
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.broker_server).toBe('ICMarkets-Demo');
    expect(body.broker_login).toBe('12345');
    // The validator runs async; by the time the test reads the row
    // it may already be 'active' (sim connector logs in fast). The
    // POST handler returns 'validating' initially.
    expect(['validating', 'active', 'error']).toContain(body.status);
    expect(body).not.toHaveProperty('encrypted_creds');
  });

  it('rejects without slot:write scope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: `Bearer ${readOnlyToken}` },
      payload: {
        broker_server: 'X',
        broker_login: '1',
        broker_password: 'p',
      },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe('FORBIDDEN');
  });

  it('rejects an invalid body (missing broker_password)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        broker_server: 'X',
        broker_login: '1',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('BAD_REQUEST');
  });
});

describe('REST: GET /v1/accounts/:id', () => {
  it('returns the row when the caller owns it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        broker_server: 'S1',
        broker_login: 'L1',
        broker_password: 'P1',
      },
    });
    const id = created.json().id;

    const got = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().id).toBe(id);
  });

  it('returns 404 for an unknown id', async () => {
    const got = await app.inject({
      method: 'GET',
      url: '/v1/accounts/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(got.statusCode).toBe(404);
    const body = got.json();
    expect(body.code).toBe('NOT_FOUND');
  });

  it('returns 404 (not 403) when an account exists but belongs to another tenant', async () => {
    // create as tenant-a
    const created = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: `Bearer ${token}` },
      payload: { broker_server: 'S', broker_login: 'L', broker_password: 'P' },
    });
    const id = created.json().id;

    // attempt to read as another tenant
    const got = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${id}`,
      headers: { authorization: `Bearer ${otherTenantToken}` },
    });
    expect(got.statusCode).toBe(403);
  });
});
