import type { FastifyInstance } from 'fastify';

/**
 * /v1/stream WebSocket upgrade.
 *
 * The cerebro was the only consumer of this endpoint (it pushed
 * broker events from the slot). With single-desktop mode the
 * cerebro is not part of the deployment, so there is no consumer
 * for broker event streaming. The route registration is
 * intentionally empty; the file stays so a future reattached
 * cerebro can wire a similar surface without re-discovering
 * the shape.
 */
export async function wsRoutes(_app: FastifyInstance): Promise<void> {
  void _app;
}
