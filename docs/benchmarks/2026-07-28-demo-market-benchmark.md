# Demo market-order benchmark ? 2026-07-28

Environment: Deriv-Demo account `32141235`, baseline `v0.3.0-functional-baseline` (`c951cb8`).

## Scope

The benchmark used the authenticated `/v1` API with 0.01-lot market buys in
`EURUSD.0`, `GBPUSD.0`, and `USDJPY.0`. Each position was discovered through
`GET /v1/positions`, modified with SL/TP where accepted, then closed through
the API. The test started and ended with zero positions and zero pending orders.

## Results

| Operation | Result | Latency |
| --- | --- | ---: |
| Open EURUSD.0 | accepted, ticket `8716253824` | 186.42 ms |
| Open GBPUSD.0 | accepted, ticket `8716253831` | 162.29 ms |
| Open USDJPY.0 | accepted, ticket `8716253833` | 137.71 ms |
| Modify EURUSD.0 SL/TP | accepted | 114.61 ms |
| Modify GBPUSD.0 SL/TP | accepted | 90.99 ms |
| Modify USDJPY.0 SL/TP | rejected: `10016 Invalid stops` | 59.89 ms |
| Close USDJPY.0 | accepted | 110.34 ms |
| Close GBPUSD.0 | accepted | 170.52 ms |
| Close EURUSD.0 | accepted | 105.03 ms |

Entry p50 was 162.29 ms; the three API closes were all below 171 ms. MT5
history contained all six fills (three entries and three exits). The Demo
balance changed from 9696.32 USD to 9695.71 USD, consistent with the recorded
commissions and the small realized result. No position remained open.

## Findings / follow-up

1. `limit` and `stop` are **not benchmarked**: the command server maps every
   `open` request to `TRADE_ACTION_DEAL`, ignoring the requested order type and
   price. Sending one would create an accidental market order.
2. Pending-order amendment/cancellation is not supported because the command
   server lacks `TRADE_ACTION_PENDING` and `TRADE_ACTION_MODIFY` handling.
3. USDJPY SL/TP needs symbol-specific tick/point calculation. Its first run
   rejected invalid stops. A subsequent 0.01-lot USDJPY open returned
   `10021 No prices`; it created no position. Treat quote availability as a
