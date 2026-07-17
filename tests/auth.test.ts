import { describe, it, expect } from 'vitest';
import {
  signToken,
  verifyToken,
  extractBearer,
  ALL_SCOPES,
  type Claims,
} from '../src/auth';
import { ProblemError } from '../src/problem';

const SECRET = 'unit-test-secret-with-enough-bytes-to-be-hs256-safe';
const TENANT = 'tenant-a';
const SLOT = 'slot-1';

const baseClaims: Pick<Claims, 'sub' | 'tenant_id' | 'slot_id' | 'scope'> = {
  sub: 'cerebro',
  tenant_id: TENANT,
  slot_id: SLOT,
  scope: ALL_SCOPES,
};

describe('auth: signToken + verifyToken round-trip', () => {
  it('round-trips a fresh token', async () => {
    const jwt = await signToken(baseClaims, { secret: SECRET });
    const claims = await verifyToken(jwt, { secret: SECRET });
    expect(claims.sub).toBe(baseClaims.sub);
    expect(claims.tenant_id).toBe(TENANT);
    expect(claims.slot_id).toBe(SLOT);
    expect(claims.scope).toEqual(ALL_SCOPES);
  });

  it('uses HS256 alg + JWT typ header', async () => {
    const jwt = await signToken(baseClaims, { secret: SECRET });
    const header = JSON.parse(
      Buffer.from(jwt.split('.')[0]!, 'base64url').toString('utf8'),
    );
    expect(header).toMatchObject({ alg: 'HS256', typ: 'JWT' });
  });

  it('default TTL is 1 hour (within tolerance)', async () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = await signToken(baseClaims, { secret: SECRET });
    const claims = await verifyToken(jwt, { secret: SECRET });
    const delta = claims.exp - before;
    expect(delta).toBeGreaterThanOrEqual(60 * 60 - 5);
    expect(delta).toBeLessThanOrEqual(60 * 60 + 5);
  });

  it('respects ttlSeconds', async () => {
    const jwt = await signToken(baseClaims, {
      secret: SECRET,
      ttlSeconds: 30,
    });
    const claims = await verifyToken(jwt, { secret: SECRET });
    const remaining = claims.exp - Math.floor(Date.now() / 1000);
    expect(remaining).toBeGreaterThanOrEqual(25);
    expect(remaining).toBeLessThanOrEqual(35);
  });
});

describe('auth: verifyToken rejection paths', () => {
  it('rejects a forged token (different secret)', async () => {
    const jwt = await signToken(baseClaims, { secret: SECRET });
    await expect(verifyToken(jwt, { secret: 'wrong-secret' })).rejects.toBeInstanceOf(
      ProblemError,
    );
  });

  it('rejects a token from a different tenant', async () => {
    const jwt = await signToken(baseClaims, { secret: SECRET });
    let err: unknown;
    try {
      await verifyToken(jwt, { secret: SECRET, expectedTenantId: 'other' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProblemError);
    expect((err as ProblemError).problem.code).toBe('FORBIDDEN');
    expect((err as ProblemError).problem.title).toBe('Tenant mismatch');
  });

  it('rejects a token from a different slot', async () => {
    const jwt = await signToken(baseClaims, { secret: SECRET });
    await expect(
      verifyToken(jwt, { secret: SECRET, expectedSlotId: 'other' }),
    ).rejects.toMatchObject({ problem: { code: 'FORBIDDEN' } });
  });

  it('rejects a token without required scopes', async () => {
    const jwt = await signToken(
      { ...baseClaims, scope: ['slot:read'] },
      { secret: SECRET },
    );
    await expect(
      verifyToken(jwt, {
        secret: SECRET,
        requiredScopes: ['slot:write'],
      }),
    ).rejects.toMatchObject({
      problem: { code: 'FORBIDDEN', title: 'Insufficient scope' },
    });
  });

  it('allows when all required scopes are present', async () => {
    const jwt = await signToken(baseClaims, { secret: SECRET });
    const claims = await verifyToken(jwt, {
      secret: SECRET,
      requiredScopes: ['slot:read', 'slot:write', 'slot:stream'],
    });
    expect(claims.scope).toEqual(ALL_SCOPES);
  });

  it('rejects a malformed JWT (junk string)', async () => {
    await expect(
      verifyToken('not-a-jwt', { secret: SECRET }),
    ).rejects.toBeInstanceOf(ProblemError);
  });

  it('rejects a token with an unknown scope value', async () => {
    // Construct a token manually with a bogus scope claim.
    // Easier path: write a token with a known secret but the scope
    // claim outside our enum — and confirm verify refuses it.
    const jwt = await signToken(baseClaims, { secret: SECRET });
    const [h, p, s] = jwt.split('.');
    const tampered = JSON.parse(
      Buffer.from(p!, 'base64url').toString('utf8'),
    );
    tampered.scope = ['slot:admin:totes-real']; // bogus
    const newPayload = Buffer.from(JSON.stringify(tampered)).toString('base64url');
    // re-sign with the right secret so the signature remains valid
    const { reSign } = await import('./helpers/reSign');
    const tamperedJwt = `${h}.${newPayload}.${(await reSign(SECRET, h!, newPayload))}`;
    await expect(
      verifyToken(tamperedJwt, { secret: SECRET }),
    ).rejects.toBeInstanceOf(ProblemError);
  });
});

describe('auth: extractBearer', () => {
  it('returns the token from a Bearer header', () => {
    expect(extractBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('is case-insensitive on the scheme', () => {
    expect(extractBearer('bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearer('BEARER abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('trims surrounding whitespace', () => {
    expect(extractBearer('   Bearer   abc.def.ghi  ')).toBe('abc.def.ghi');
  });

  it('returns null for absent or malformed header', () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer('')).toBeNull();
    expect(extractBearer('abc.def.ghi')).toBeNull();
    expect(extractBearer('Basic abc')).toBeNull();
    expect(extractBearer('Bearer')).toBeNull(); // no token
  });
});
