import 'dotenv/config';
import { loadMasterKey } from './crypto.js';
import { z } from 'zod';

/**
 * Process-env loader. Validates required vars, exits with a clear
 * error if anything is missing. Decodes SLOT_ENCRYPTION_KEY once.
 */

export type RiskLimits = {
  max_position_size: number;
  max_daily_loss_pct: number;
  kill_switch_active: boolean;
};

export type AppConfig = {
  tenantId: string;
  slotId: string;
  jwtSecret: string;
  encryptionKey: Buffer;
  bind: string;
  port: number;
  stateDb: string;
  logLevel: string;
  reconcileIntervalMs: number;
  mt5ZmqHost: string;
  mt5ZmqInPort: number;
  mt5ZmqOutPort: number;
  connectorId: 'sim' | 'mt5';
  riskLimits: RiskLimits;
};

const riskLimitsSchema = z.object({
  max_position_size: z.number().min(0).default(0),
  max_daily_loss_pct: z.number().min(0).max(100).default(100),
  kill_switch_active: z.boolean().default(false),
});

const schema = z.object({
  SLOT_TENANT_ID: z.string().min(1),
  SLOT_SLOT_ID: z.string().min(1),
  SLOT_JWT_SECRET: z.string().min(32, 'must be 32+ bytes'),
  SLOT_ENCRYPTION_KEY: z.string().min(1),
  SLOT_BIND: z.string().default('127.0.0.1'),
  SLOT_PORT: z.coerce.number().int().positive().default(7777),
  SLOT_STATE_DB: z.string().default('/var/lib/akron-slot/state.db'),
  SLOT_LOG_LEVEL: z.string().default('info'),
  SLOT_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  SLOT_MT5_ZMQ_HOST: z.string().default('127.0.0.1'),
  SLOT_MT5_ZMQ_IN_PORT: z.coerce.number().int().positive().default(5555),
  SLOT_MT5_ZMQ_OUT_PORT: z.coerce.number().int().positive().default(5556),
  SLOT_RISK_LIMITS_JSON: z.string().optional(),
  SLOT_CONNECTOR: z.enum(['sim', 'mt5']).default('sim'),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const errs = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n  ');
    throw new Error(`Invalid configuration:\n  ${errs}`);
  }
  const c = parsed.data;

  let riskLimits: RiskLimits;
  if (c.SLOT_RISK_LIMITS_JSON) {
    let raw: unknown;
    try {
      raw = JSON.parse(c.SLOT_RISK_LIMITS_JSON);
    } catch (e) {
      throw new Error(
        `Invalid SLOT_RISK_LIMITS_JSON: ${(e as Error).message}`,
      );
    }
    const rl = riskLimitsSchema.safeParse(raw);
    if (!rl.success) {
      throw new Error(
        `SLOT_RISK_LIMITS_JSON failed validation: ${rl.error.issues
          .map((i) => i.message)
          .join('; ')}`,
      );
    }
    riskLimits = rl.data;
  } else {
    riskLimits = riskLimitsSchema.parse({});
  }

  let encryptionKey: Buffer;
  try {
    encryptionKey = loadMasterKey(c.SLOT_ENCRYPTION_KEY);
  } catch (e) {
    throw new Error(
      `SLOT_ENCRYPTION_KEY: ${(e as Error).message}. Generate one with: openssl rand -base64 32`,
    );
  }

  return {
    tenantId: c.SLOT_TENANT_ID,
    slotId: c.SLOT_SLOT_ID,
    jwtSecret: c.SLOT_JWT_SECRET,
    encryptionKey,
    bind: c.SLOT_BIND,
    port: c.SLOT_PORT,
    stateDb: c.SLOT_STATE_DB,
    logLevel: c.SLOT_LOG_LEVEL,
    reconcileIntervalMs: c.SLOT_RECONCILE_INTERVAL_MS,
    mt5ZmqHost: c.SLOT_MT5_ZMQ_HOST,
    mt5ZmqInPort: c.SLOT_MT5_ZMQ_IN_PORT,
    mt5ZmqOutPort: c.SLOT_MT5_ZMQ_OUT_PORT,
    connectorId: c.SLOT_CONNECTOR,
    riskLimits,
  };
}
