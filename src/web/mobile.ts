import type { FastifyInstance } from 'fastify';
import { MOBILE_HTML } from './mobile.html.js';
import { registerVncStaticRoutes } from './vnc-static-routes.js';

/**
 * GET /mobile — phone-friendly VNC wrapper for KasmVNC.
 *
 * Single-page app that:
 *   - Iframes KasmVNC's own noVNC client (served same-origin at
 *     /vnc-static/) so the WebSocket works out of the box.
 *   - Renders the MT5 desktop in a full-viewport canvas.
 *   - Provides a virtual keyboard + macro buttons (Esc/Tab/Enter/F2/Ctrl+…)
 *   - Stores broker credentials in localStorage and auto-types them
 *     into the MT5 login dialog via the iframed RFB's sendKey().
 *
 * No auth on this endpoint (the slot's JWT layer still protects the
 * /v1/* REST API; the /mobile page is meant to be the public-facing
 * entry point for phone-based access).
 */
export async function registerMobileRoutes(app: FastifyInstance): Promise<void> {
  await registerVncStaticRoutes(app);
  app.get('/mobile', async (_req, reply) => {
    reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-cache, no-store, must-revalidate')
      .send(MOBILE_HTML);
  });
}