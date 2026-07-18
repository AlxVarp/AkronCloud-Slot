/**
 * Phase B tracker — single file flagging what remains for Phase B.
 *
 * Search the repo for "PHASE-B" to land in this file's callers.
 * Phase B intent:
 *
 *  1. ~~connectors/mt5.ts — ZMQ subscriber to PublisherZMQEvents.mq5
 *     + outbound commands over a second ZMQ socket. Implements the
 *     BrokerConnector interface end-to-end (this file already
 *     defines the contract).~~  **DONE** (commit 763705a).
 *     The connector boots, binds the outbound publisher, subscribes
 *     to the inbound, drives state from account_status, derives
 *     positions from the ledger, and emits the right shapes for
 *     `stream()`. Outstanding follow-up: a SlotCommandEA.mq5 on the
 *     MT5 chart that consumes the outbound socket and actually
 *     places orders, then publishes the real broker_order_id +
 *     fill events back on the inbound socket.
 *  2. validator.ts — actually start a broker session with the
 *     connector and flip accounts.status to active/error. **DONE**
 *     (the body was already implemented; the stub was just a
 *     comment that misled the original author).
 *  3. ledger.ts — wire the connector's stream() AsyncIterable into
 *     recordFill / recordOrder, and implement positionsFor over the
 *     orders + fills tables. **DONE** — services/mt5-zmq.ts (the
 *     global ZMQ subscriber started in app.ts) already writes fills
 *     to ledger.insertFill and order_state changes to
 *     ledger.updateOrderStatus. ledger.positionsFor derives
 *     positions. The MT5 connector (item 1) reads from
 *     ledger.positionsFor so the system is end-to-end.
 *  4. reconciler.ts — cron tick (cfg.reconcileIntervalMs) comparing
 *     connector.positions() to ledger positions, emitting drift
 *     events to /v1/stream and a reconcile_log row.
 *  5. api/ws.ts — replace the NOT_IMPLEMENTED stub subscribe path
 *     with the actual fan-out from the reconciler + connector.
 *  6. api/rest.ts — wire POST /v1/orders + GET endpoints through
 *     the connector via risk → ledger → connector.openTrade, and
 *     stream fills back via the WS upgrade.
 *  7. AkronCloud/apps/orchestrator — adopt this protocol; mint
 *     real JWTs against SLOT_JWT_SECRET; issue PATCH /v1/risk-limits.
 *
 * Spec: SPEC.md § 4.5, § 5, § 7.
 */
export const PHASE_B_ITEMS = [
  'connectors/mt5.ts',
  'validator.ts real impl',
  'ledger.ts real impl',
  'reconciler.ts real impl',
  'api/ws.ts real impl',
  'api/rest.ts POST /v1/orders path',
  'AkronCloud/apps/orchestrator integration',
] as const;
