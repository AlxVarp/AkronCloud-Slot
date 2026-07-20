import type { FastifyInstance } from 'fastify';
import { MOBILE_HTML } from './mobile.html.js';
import { registerVncStaticRoutes } from './vnc-static-routes.js';
import { registerMt5WsProxy } from './mt5-ws-proxy.js';

/**
 * GET /mobile — phone-friendly VNC wrapper for KasmVNC.
 *
 * Single-page app that:
 *   - Loads KasmVNC's bundled `core/rfb.js` (served same-origin at
 *     /vnc-static/core/rfb.js — copied from /usr/local/share/kasmvnc/www
 *     at build time).
 *   - Renders MT5 in a full-viewport canvas with pinch/scroll.
 *   - Provides a virtual keyboard + macro buttons.
 *   - Stores broker credentials in localStorage for one-tap fill.
 *
 * The WebSocket goes through /mt5-ws (same-origin proxy in this
 * same Fastify app) which pipes bytes to KasmVNC's :3000/websockify.
 * Same-origin WS avoids port-3000 firewall issues on mobile networks.
 */
export async function registerMobileRoutes(app: FastifyInstance): Promise<void> {
  await registerVncStaticRoutes(app);
  await registerMt5WsProxy(app);
  app.get('/mobile', async (_req, reply) => {
    reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-cache, no-store, must-revalidate')
      .send(MOBILE_HTML);
  });
}