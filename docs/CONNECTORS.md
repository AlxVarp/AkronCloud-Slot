# Adding a Broker Connector

> Step-by-step guide for adding a new broker (e.g. MetaTrader5 / IBKR / Alpaca) to the slot service. Once a connector lands, the platform's panel picks it up automatically — no other code in this repo needs to change.

## What a connector is

A connector is a TypeScript module under `src/connectors/<broker-id>.ts` that implements the `BrokerConnector` interface documented in `../SPEC.md § 4`. It translates broker-specific protocol quirks (WebSocket / REST / TCP / proprietary) into the slot's unified API.

## Steps

1. **Create the file**: `src/connectors/<broker-id>.ts`.

2. **Implement the interface** (pseudo-code):

   ```ts
   import type { BrokerConnector, AccountRef, Quote, Position, OrderResult, NewOrder, BrokerEvent } from './base.js';

   export default class <Broker>Connector implements BrokerConnector {
     id = '<broker-id>';
     displayName = 'My Broker';

     async connect(creds: unknown): Promise<AccountRef> {
       // 1. Validate creds.
       // 2. Open connection (WebSocket / REST / TCP).
       // 3. Verify auth with broker.
       // 4. Return { account_id, broker_id: '<broker-id>', display_name }.
     }

     async disconnect(accountId: string): Promise<void> {
       // Close the connection cleanly. Idempotent.
     }

     async quote(symbol: string): Promise<Quote> {
       // Fetch top-of-book quote. Cache in memory for ~100ms to avoid hammering the broker.
     }

     async positions(accountId: string): Promise<Position[]> {
       // Return current open positions.
     }

     async openTrade(accountId: string, order: NewOrder): Promise<OrderResult> {
       // Place the order. Return { ok: true, order_id, broker_order_id } on success,
       // { ok: false, reason } on broker-rejected.
     }

     async closeTrade(accountId: string, positionId: string, qty?: number): Promise<OrderResult> {
       // Close (full or partial) by position_id.
     }

     async *stream(accountId: string): AsyncIterable<BrokerEvent> {
       // Yield fill / order_state / account events from the broker's streaming endpoint.
     }
   }
   ```

3. **Register in `src/connectors/index.ts`**:

   ```ts
   import deriv from './deriv.js';
   // import mt5 from './mt5.js';

   export const connectors = {
     [deriv.id]: deriv,
     // [mt5.id]: mt5,
   };

   export type ConnectorId = keyof typeof connectors;
   ```

4. **Add broker-specific env vars** to `SPEC.md § 8.1` and document them in `AkronCloud-Node/bootstrap.sh` so the bootstrap knows what to pass.

5. **Add fixtures** under `tests/connectors/<broker-id>/` — at minimum a happy-path test that:
   - `connect()` returns a valid `AccountRef`.
   - `quote('EURUSD')` returns a sane `Quote`.
   - `openTrade(...)` against a sandbox account returns `{ ok: true, ... }`.
   - `disconnect()` is idempotent.

6. **Update `SPEC.md`**:
   - Add the connector to § 4.1 (initial) or § 4.2 (post-MVP).
   - Note any broker-specific quirks in § 7 (failure modes).
   - If new env vars: § 8.1.

7. **Open a PR** with title `feat(slot): add <broker-id> connector`. Tag it for review by the slot-service maintainers.

## Sandbox / paper-trading

Always test against the broker's **sandbox / demo / paper-trading** endpoint, not real money. Each broker has its own sandbox URL and creds.

## Things to keep in mind

- **Idempotency**: every operation must be safely retryable. The reconciler replays pending orders on reconnect; your connector must dedupe via `broker_order_id`.
- **Latency**: streaming quotes should arrive within 200ms. Cache top-of-book quotes for at most one event-loop tick (`setImmediate`) to avoid hammering the broker.
- **Time skew**: never trust broker-supplied timestamps without checking against `Date.now()`. Reconciler catches drift but catching it upstream is cheaper.
- **Auth refresh**: long-lived sessions (24h+ on some brokers) will need a re-auth. Implement a renewal flow or accept that the slot restarts every 24h.

## Open questions before adding a connector

- Does the broker support a streaming API? If not, the slot will need to poll. Document the polling rate.
- What's the rate-limit? The reconciler must back off accordingly.
- Are sandbox credentials available without a paid account? If not, mark the connector as `requires-paid-account` in the panel.

## Reference

- `../SPEC.md § 4` — the interface contract.
- `../src/connectors/base.ts` (scaffolded; will land in a follow-up PR) — the types.
- `../src/connectors/deriv.ts` (scaffolded; will land in a follow-up PR) — the first implementation as a worked example.
