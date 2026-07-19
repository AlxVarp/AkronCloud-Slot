import pino from 'pino';

const level = process.env.SLOT_LOG_LEVEL ?? 'info';

export const log = pino({
  level,
  base: {
    service: 'akroncloud-slot',
    tenant_id: process.env.SLOT_TENANT_ID ?? undefined,
    slot_id: process.env.SLOT_SLOT_ID ?? undefined,
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = pino.Logger;
