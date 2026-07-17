import { buildApp } from './app';
import { loadConfig } from './config';
import { log } from './log';

async function main() {
  const cfg = loadConfig();
  log.info(
    {
      tenant_id: cfg.tenantId,
      slot_id: cfg.slotId,
      bind: cfg.bind,
      port: cfg.port,
      state_db: cfg.stateDb,
      reconcile_ms: cfg.reconcileIntervalMs,
    },
    'starting akroncloud-slot',
  );

  const app = await buildApp(cfg);

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutting down');
    try {
      await app.close();
    } catch (e) {
      log.error({ err: (e as Error).message }, 'error during close');
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    const addr = await app.listen({ host: cfg.bind, port: cfg.port });
    log.info({ addr }, 'listening');
  } catch (e) {
    log.error({ err: (e as Error).message }, 'failed to bind');
    process.exit(1);
  }
}

main().catch((e) => {
  log.error({ err: (e as Error).message }, 'boot failed');
  process.exit(1);
});
