import type { FastifyInstance } from 'fastify';
import { DESKTOP_HTML } from './desktop.html.js';
import { registerVncStaticRoutes } from './vnc-static-routes.js';
import { registerMt5WsProxy } from './mt5-ws-proxy.js';

/**
 * GET /mobile — phone-friendly VNC wrapper for KasmVNC.
 * GET /desktop — desktop-friendly VNC wrapper for KasmVNC.
 *
 * /mobile single-page app:
 *   - Loads KasmVNC's bundled `core/rfb.js` (served same-origin at
 *     /vnc-static/core/rfb.js — copied from /usr/local/share/kasmvnc/www
 *     at build time).
 *   - Renders MT5 in a full-viewport canvas with pinch/scroll.
 *   - Provides a virtual keyboard + macro buttons.
 *   - Stores broker credentials in localStorage for one-tap fill.
 *
 * /desktop single-page app:
 *   - Same RFB client, same WebSocket proxy.
 *   - Renders MT5 at the host's native 1024x768 resolution with
 *     letterbox scaling (no mobile shrink).
 *   - No virtual keyboard — the real keyboard works because the
 *     RFB client captures key events from the canvas.
 *   - Adds a settings panel (KasmVNC backend override) and a
 *     tighter credentials sheet (same one-tap fill UX as /mobile).
 *
 * The WebSocket goes through /mt5-ws (same-origin proxy in this
 * same Fastify app) which pipes bytes to KasmVNC's :3000/websockify.
 * Same-origin WS avoids port-3000 firewall issues on mobile networks.
 */
export async function registerMobileRoutes(app: FastifyInstance): Promise<void> {
  await registerVncStaticRoutes(app);
  await registerMt5WsProxy(app);
  app.get('/terminal', async (_req, reply) => {
    reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-cache, no-store, must-revalidate')
      .send(DESKTOP_HTML);
  });
  app.get('/mobile', async (_req, reply) => {
    return reply.redirect('/terminal', 308);
  });
  // /desktop — desktop-friendly VNC wrapper for KasmVNC.
  // /mobile is the proven-working template; /desktop is a thinner
  // variant of the same approach: same RFB client (noVNC core),
  // same /mt5-ws proxy, no virtual keyboard, FAB at the bottom-right
  // for quick access to login / sync / reconnect. The layout is
  // desktop-first: full RFB canvas fills the viewport, real keyboard
  // input works because the RFB client captures key events from
  // the canvas. (We removed the iOS / mobile-only padding and
  // credential-fill UI for desktop.)
  app.get('/desktop', async (_req, reply) => {
    return reply.redirect('/terminal', 308);
  });
  // 1x1 transparent PNG. Browsers auto-request /favicon.ico on every
  // page load; without this we get a noisy 404 in the console.
  const TRANSPARENT_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  app.get('/favicon.ico', async (_req, reply) => {
    reply
      .type('image/png')
      .header('Cache-Control', 'public, max-age=86400')
      .send(TRANSPARENT_PNG);
  });
}
