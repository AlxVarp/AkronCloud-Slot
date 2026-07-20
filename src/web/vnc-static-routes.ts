import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/**
 * GET /vnc-static/* — KasmVNC's bundled noVNC client (extracted
 * from /usr/local/share/kasmvnc/www inside the container at build
 * time, copied to dist/web/vnc-static/).
 *
 * We serve it from the slot's port 7777 so /mobile can iframe
 * it same-origin. The bundled client knows how to talk to
 * KasmVNC's WebSocket endpoint (`ws://<host>:3000/`); we just
 * point the iframe at this same-origin URL and the bundled JS
 * handles the rest.
 */
export async function registerVncStaticRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, {
    root: path.join(__dirname, 'vnc-static'),
    prefix: '/vnc-static/',
    decorateReply: false,
    index: ['index.html'],
  });
}