# Parallel multi-symbol demo benchmark — 2026-07-29

Environment: Deriv-Demo account `32141235`, branch `codex/p0-trading`,
commit `35e144c`. Measurements are API round trips from inside the Slot
container; they do not include browser, internet-client, or user-interface
latency.

## Scope

The measured run issued each phase concurrently for three live-quoted symbols:

| Symbol | Quantity |
| --- | ---: |
| Boom 300 Index.0 | 0.50 |
| Boom 500 Index.0 | 0.21 |
| Crash 500 Index.0 | 0.22 |

For every symbol the benchmark created a buy-limit order beyond the broker's
minimum stop distance, modified it, cancelled it, opened a market buy,
modified SL/TP, and closed it. Every write used a distinct idempotency key.
The account was empty before the run and the cleanup check confirmed zero
positions and zero pending orders afterward.

## Results

| Parallel phase (3 requests) | p50 | p95 / max |
| --- | ---: | ---: |
| Create pending limits | 1,374.8 ms | 2,026.3 ms |
| Modify pending limits | 1,393.8 ms | 2,063.4 ms |
| Cancel pending limits | 1,554.6 ms | 2,222.1 ms |
| Open market positions | 1,565.6 ms | 2,233.3 ms |
| Modify position SL/TP | 1,449.6 ms | 2,089.0 ms |
| Close positions | 1,410.8 ms | 2,091.7 ms |

All 18 measured mutation requests succeeded. The individual request times
within each three-request phase rose in sequence (roughly 0.7–2.2 s), so the
HTTP calls were concurrent but the MT5 command bridge serialized broker work.
That is safe and deterministic, but it is the current throughput ceiling.

## Outcome

- Pending-order create, amend, and cancel work against the demo broker.
- Market open, SL/TP amendment, and close work across three different symbols.
- The final `/v1/positions` and `/v1/orders` checks both returned zero items.
- The next performance improvement, if needed, is a queue/worker design that
  permits safe broker-side concurrency; it should not bypass the present
  serialization without ordering and cleanup guarantees.
