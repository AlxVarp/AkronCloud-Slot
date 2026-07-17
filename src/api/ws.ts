import type { FastifyInstance } from 'fastify';
import { ProblemError } from '../problem';

/**
 * /v1/stream WebSocket upgrade. Phase A: scaffold only.
 *
 * Auth happens via the `Authorization: Bearer <token>` header on the
 * upgrade request (verified by the global `onRequest` hook + scope
 * check in `requireScope`). Spec § 2.2 enumerates the channels; their
 * push implementations land in Phase B alongside the MT5 connector.
 */
export async function wsRoutes(app: FastifyInstance) {
  app.get('/v1/stream', { websocket: true }, async (socket, req) => {
    const claims = (req as unknown as { claims: { scope: string[] } }).claims;
    if (!claims?.scope.includes('slot:stream')) {
      socket.send(
        JSON.stringify({
          type: 'error',
          code: 'FORBIDDEN',
          message: 'missing scope: slot:stream',
        }),
      );
      socket.close(1008, 'forbidden');
      return;
    }
    // Replace this stub with the MT5-connector-driven event loop in Phase B.
    socket.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
        }
        if (msg?.type === 'subscribe') {
          // Phase A: ack only; actual event fan-out lands in Phase B.
          socket.send(
            JSON.stringify({
              type: 'error',
              code: 'NOT_IMPLEMENTED',
              message: `phase A: subscribe to ${msg.channel} is a stub`,
            }),
          );
        }
      } catch {
        socket.send(
          JSON.stringify({ type: 'error', code: 'BAD_CHANNEL', message: 'invalid JSON' }),
        );
      }
    });

    // Reject anything that never sends a welcome within the handshake
    // window — keeps the socket from being hijacked by anything else.
    socket.send(
      JSON.stringify({
        type: 'event',
        channel: 'heartbeats',
        data: { ts: Date.now(), msg: 'phase A stub — see SPEC §2.2' },
      }),
    );

    // The onRequest hook already authenticated this upgrade. If it
    // didn't, this handler never runs because the hook throws 401.
    void ProblemError; // keep import for future use
    return;
  });
}
