import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { log } from '../log.js';

/**
 * GET /mt5-ws — WebSocket proxy from the slot to KasmVNC's
 * Xvnc websockify backend. Solves two problems at once:
 *
 *   1. Browsers running on cellular / restrictive networks may not
 *      be able to reach the slot's port 3000 (KasmVNC) directly,
 *      even when port 7777 (slot API) is reachable. The mobile
 *      page is loaded from :7777 — the WebSocket needs to go
 *      back to :7777 same-origin to avoid firewall / port issues.
 *
 *   2. KasmVNC's Xvnc backend has quirky behaviour for non-root
 *      paths (404 on /websockify from :6901 directly; nginx on
 *      :3000 has to forward the upgrade). Going through the slot
 *      keeps the WS upgrade semantics uniform.
 *
 * Architecture: client (browser on :7777) opens WS to
 * ws://host:7777/mt5-ws. The slot opens a server-side WS to
 * ws://127.0.0.1:3000/websockify (KasmVNC nginx -> :6901 Xvnc)
 * and pipes bytes both ways. No protocol-level changes; the
 * client sees the KasmVNC RFB server directly.
 */
export async function registerMt5WsProxy(app: FastifyInstance): Promise<void> {
  // @fastify/websocket is already registered at app.ts boot.
  // We just add our /mt5-ws route here.
  app.register(async (instance) => {
    instance.get('/mt5-ws', { websocket: true }, (socket, req) => {
      const client = socket;

      // Spawn the upstream WS to KasmVNC. Same path KasmVNC's
      // bundled noVNC uses.
      const upstreamUrl = 'ws://127.0.0.1:3000/websockify';
      const upstream = new WebSocket(upstreamUrl, ['binary']);

      let clientOpen = true;
      let upstreamOpen = false;

      const closeBoth = (reason: string): void => {
        if (!clientOpen && !upstreamOpen) return;
        log.info({ reason }, 'mt5-ws proxy closing');
        try { client.close(); } catch (e) { /* ignore */ }
        try { upstream.close(); } catch (e) { /* ignore */ }
        clientOpen = false;
        upstreamOpen = false;
      };

      upstream.on('open', () => {
        upstreamOpen = true;
        log.info('mt5-ws upstream opened to KasmVNC');
      });

      upstream.on('close', (code: number, reason: Buffer) => {
        log.info({ code, reason: reason.toString() }, 'mt5-ws upstream closed');
        if (clientOpen) {
          try { client.close(code || 1006, 'upstream closed'); } catch (err) { /* ignore */ }
        }
      });

      upstream.on('error', (err: Error) => {
        log.warn({ error: err.message }, 'mt5-ws upstream error');
        closeBoth('upstream error');
      });

      upstream.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        if (!clientOpen) return;
        try {
          if (client.readyState === 1 /* OPEN */) {
            client.send(data as ArrayBuffer | Buffer);
          }
        } catch (err) {
          log.warn({ err: (err as Error).message }, 'mt5-ws client send failed');
          closeBoth('client send failed');
        }
      });

      client.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        if (!upstreamOpen) return;
        try {
          if (upstream.readyState === 1 /* OPEN */) {
            upstream.send(data as ArrayBuffer | Buffer);
          }
        } catch (err) {
          log.warn({ err: (err as Error).message }, 'mt5-ws upstream send failed');
          closeBoth('upstream send failed');
        }
      });

      client.on('close', (code: number, reason: Buffer) => {
        log.info({ code, reason: reason.toString() }, 'mt5-ws client closed');
        try { upstream.close(); } catch (err) { /* ignore */ }
        clientOpen = false;
      });

      client.on('error', (err: Error) => {
        log.warn({ error: err.message }, 'mt5-ws client error');
        closeBoth('client error');
      });

      log.info({
        ua: req.headers['user-agent']?.slice(0, 60) ?? '',
        origin: req.headers.origin ?? '',
      }, 'mt5-ws client connected');
    });
  });
}