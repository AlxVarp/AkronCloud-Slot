/**
 * Phase B tracker — single file flagging what remains for Phase B.
 *
 * Search the repo for "PHASE-B" to land in this file's callers.
 * Phase B intent:
 *
 *  1. connectors/mt5.ts — ZMQ subscriber to PublisherZMQEvents.mq5
 *     + outbound commands over a second ZMQ socket. Implements the
 *     BrokerConnector interface end-to-end (this file already
 *     defines the contract).
 *  2. validator.ts — actually start a broker session with the
 *     connector and flip accounts.status to active/error.
 *  3. ledger.ts — wire the connector's stream() AsyncIterable into
 *     recordFill / recordOrder, and implement positionsFor over the
 *     orders + fills tables.
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
