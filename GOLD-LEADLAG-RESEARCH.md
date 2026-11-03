# NEXIO Gold Lead–Lag Paper Research (experimental)

This module is intentionally independent of existing Gold Watch and the live MT5 EA.

## Added
- `src/gold/leadlag-paper.js`: in-memory bid/ask signal detector and simulated ledger.
- Accepts timestamped `MT5` and `BINANCE` quotes via `ingest({venue,bid,ask,exchangeTs,receivedTs})`.
- Tracks directional spike events using *relative moves* instead of comparing raw prices.
- Models entry/exit bid-ask spread, estimated slippage and taker fees.
- Rejects paper entries unless a directional calibration with at least 30 independently verified observations has been supplied.
- Never calls an exchange, broker, Telegram API, or any live order interface.

## Not implemented yet
- MT5 tick-forwarding bridge and Binance market WebSocket feed.
- Clock-offset estimation, synchronized buffering and venue-specific basis normalization.
- Verified catch-up calibration and out-of-sample replay pipeline.
- Persistence, alerting, reconnect handling, unit tests, dashboard and AWS service deployment.

## Safety
This is a research component, **not a production-ready trading system**. It does not trade until an external validated calibration is provided. Do not supply fabricated calibration samples. In-memory simulation state is lost on restart. Do not connect it to live execution. This branch does not change the existing EA.

## Next steps
1. Verify actual MT5 terminal host and instrument mapping.
2. Build a timestamped, authenticated MT5 tick-forwarder.
3. Subscribe to Binance's correct XAUUSDT perpetual executable bid/ask stream and verify availability.
4. Persist raw tick data and measure clock drift and transport latency.
5. Replay synchronized sessions, including news spikes and spread widening.
6. Add cost-aware out-of-sample calibration, test fixtures, persistent ledger, and Telegram summaries.
