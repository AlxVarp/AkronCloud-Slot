#!/usr/bin/env -S npx tsx
/**
 * dev-token — mint a JWT for curl-driven local testing.
 *
 * Reads SLOT_JWT_SECRET, SLOT_TENANT_ID, SLOT_SLOT_ID from .env (or the
 * current process env). Writes the compact JWT to stdout. By default it
 * includes all three slot: scopes and has a 1-hour TTL.
 *
 * Usage:
 *   npm run -s dev-token
 *   npm run -s dev-token -- --ttl-seconds=300
 *   npm run -s dev-token -- --scope=slot:read,slot:write
 *   npm run -s dev-token -- --sub=cerebro --tenant-id=t-1
 */

import 'dotenv/config';
import { signToken, ALL_SCOPES, type Scope } from '../src/auth.js';

type CliOpts = {
  sub: string;
  tenant_id: string;
  slot_id: string;
  scope: Scope[];
  ttlSeconds: number;
  /** secret override; defaults to SLOT_JWT_SECRET from env */
  secret?: string;
};

function parseArgs(argv: string[]): CliOpts {
  const envSub = process.env.SLOT_DEV_TOKEN_SUB ?? 'dev';
  const envTenant = process.env.SLOT_TENANT_ID ?? '00000000-0000-0000-0000-000000000001';
  const envSlot = process.env.SLOT_SLOT_ID ?? '00000000-0000-0000-0000-0000000000aa';
  const envTtl = Number(process.env.SLOT_DEV_TOKEN_TTL ?? 3600);

  const opts: CliOpts = {
    sub: envSub,
    tenant_id: envTenant,
    slot_id: envSlot,
    scope: ALL_SCOPES,
    ttlSeconds: envTtl,
  };

  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (!m) continue;
    const key = m[1]!;
    const val = m[2]!;
    switch (key) {
      case 'sub':
        opts.sub = val;
        break;
      case 'tenant-id':
      case 'tenant_id':
        opts.tenant_id = val;
        break;
      case 'slot-id':
      case 'slot_id':
        opts.slot_id = val;
        break;
      case 'ttl-seconds':
      case 'ttl_seconds':
        opts.ttlSeconds = Number(val);
        break;
      case 'scope': {
        const requested = val.split(',').map((s) => s.trim()) as Scope[];
        const unknown = requested.filter(
          (s) => !(ALL_SCOPES as string[]).includes(s),
        );
        if (unknown.length > 0) {
          console.error(`unknown scope values: ${unknown.join(', ')}`);
          process.exit(2);
        }
        opts.scope = requested;
        break;
      }
      case 'secret':
        opts.secret = val;
        break;
      default:
        console.error(`unknown flag: --${key}`);
        process.exit(2);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  const secret = opts.secret ?? process.env.SLOT_JWT_SECRET;
  if (!secret) {
    console.error('SLOT_JWT_SECRET is not set; refusing to mint a dev token');
    process.exit(1);
  }

  const jwt = await signToken(
    {
      sub: opts.sub,
      tenant_id: opts.tenant_id,
      slot_id: opts.slot_id,
      scope: opts.scope,
    },
    { secret, ttlSeconds: opts.ttlSeconds },
  );

  const exp = Math.floor(Date.now() / 1000) + opts.ttlSeconds;
  process.stdout.write(jwt + '\n');
  process.stderr.write(
    `dev token: sub=${opts.sub} tenant=${opts.tenant_id} slot=${opts.slot_id} ` +
      `scopes=[${opts.scope.join(',')}] exp=${new Date(exp * 1000).toISOString()}\n`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
