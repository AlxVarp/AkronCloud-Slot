import { SignJWT, jwtVerify } from 'jose';
import { ProblemError } from './problem.js';

/**
 * Auth — HS256 JWT issue + verify, scoped to the slot.
 *
 * Spec: SPEC.md § 2.3 + § 2.4.
 *
 * In Phase A the slot is its own issuer for dev tokens (see
 * scripts/dev-token.ts). In Phase C, the AkronCloud cerebro will
 * issue tokens against the same `SLOT_JWT_SECRET` — no change here.
 */

export type Scope = 'slot:read' | 'slot:write' | 'slot:stream';

export const ALL_SCOPES: Scope[] = ['slot:read', 'slot:write', 'slot:stream'];

export type Claims = {
  sub: string;
  tenant_id: string;
  slot_id: string;
  exp: number;
  scope: Scope[];
};

export type SignOpts = {
  /** raw secret bytes or utf-8 string; we'll encode either way */
  secret: string | Uint8Array;
  /** defaults to 1 hour from now */
  ttlSeconds?: number;
};

export type VerifyOpts = {
  secret: string | Uint8Array;
  /** if set, the token's tenant_id must equal this */
  expectedTenantId?: string;
  /** if set, the token's slot_id must equal this */
  expectedSlotId?: string;
  /** if set, all of these scopes must be present in the token */
  requiredScopes?: Scope[];
  /** clock skew tolerance in seconds (default 5) */
  clockToleranceSeconds?: number;
};

const DEFAULTS = {
  ttlSeconds: 60 * 60, // 1 hour
  clockToleranceSeconds: 5,
} as const;

/**
 * Sign a JWT with HS256. Returns the compact serialized token.
 */
export async function signToken(
  claims: Pick<Claims, 'sub' | 'tenant_id' | 'slot_id' | 'scope'>,
  opts: SignOpts,
): Promise<string> {
  const secret = encodeSecret(opts.secret);
  const ttl = opts.ttlSeconds ?? DEFAULTS.ttlSeconds;
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({
    sub: claims.sub,
    tenant_id: claims.tenant_id,
    slot_id: claims.slot_id,
    scope: claims.scope,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(secret);
  return jwt;
}

/**
 * Verify a JWT. Returns the parsed claims on success.
 * Throws ProblemError on any failure (expired, bad sig, missing
 * tenant/slot/scope, etc.) so callers can surface a Problem+JSON.
 */
export async function verifyToken(
  token: string,
  opts: VerifyOpts,
): Promise<Claims> {
  const secret = encodeSecret(opts.secret);
  let payload: Record<string, unknown>;
  try {
    const r = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
      clockTolerance: opts.clockToleranceSeconds ?? DEFAULTS.clockToleranceSeconds,
    });
    payload = r.payload as Record<string, unknown>;
  } catch (e) {
    throw new ProblemError({
      status: 401,
      code: 'UNAUTHENTICATED',
      title: 'Invalid or expired token',
      detail: (e as Error).message,
    });
  }

  const claims = parseClaims(payload);

  if (opts.expectedTenantId && claims.tenant_id !== opts.expectedTenantId) {
    throw new ProblemError({
      status: 403,
      code: 'FORBIDDEN',
      title: 'Tenant mismatch',
      detail: `token tenant_id=${claims.tenant_id}, expected ${opts.expectedTenantId}`,
    });
  }

  if (opts.expectedSlotId && claims.slot_id !== opts.expectedSlotId) {
    throw new ProblemError({
      status: 403,
      code: 'FORBIDDEN',
      title: 'Slot mismatch',
      detail: `token slot_id=${claims.slot_id}, expected ${opts.expectedSlotId}`,
    });
  }

  if (opts.requiredScopes && opts.requiredScopes.length > 0) {
    const missing = opts.requiredScopes.filter(
      (s) => !claims.scope.includes(s),
    );
    if (missing.length > 0) {
      throw new ProblemError({
        status: 403,
        code: 'FORBIDDEN',
        title: 'Insufficient scope',
        detail: `missing scopes: ${missing.join(', ')}`,
      });
    }
  }

  return claims;
}

/**
 * Extract a bearer token from an `Authorization: Bearer <token>` header.
 * Returns null if absent / malformed. Caller decides how to react.
 */
export function extractBearer(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return m ? m[1]!.trim() : null;
}

// ---- helpers ----

function encodeSecret(s: string | Uint8Array): Uint8Array {
  if (typeof s === 'string') return new TextEncoder().encode(s);
  return s;
}

function parseClaims(payload: Record<string, unknown>): Claims {
  const sub = payload.sub;
  const tenant_id = payload.tenant_id;
  const slot_id = payload.slot_id;
  const exp = payload.exp;
  const scope = payload.scope;

  if (
    typeof sub !== 'string' ||
    typeof tenant_id !== 'string' ||
    typeof slot_id !== 'string' ||
    typeof exp !== 'number' ||
    !Array.isArray(scope)
  ) {
    throw new ProblemError({
      status: 401,
      code: 'UNAUTHENTICATED',
      title: 'Token missing required claims',
      detail: 'expected { sub, tenant_id, slot_id, exp, scope }',
    });
  }

  const validScopes = scope.every(
    (s) => typeof s === 'string' && (ALL_SCOPES as string[]).includes(s),
  );
  if (!validScopes) {
    throw new ProblemError({
      status: 401,
      code: 'UNAUTHENTICATED',
      title: 'Token has unknown scope values',
    });
  }

  return {
    sub,
    tenant_id,
    slot_id,
    exp,
    scope: scope as Scope[],
  };
}
