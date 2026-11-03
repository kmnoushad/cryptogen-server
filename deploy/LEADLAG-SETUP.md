# Lead–Lag collector setup (not deployed)

The experimental worker is `src/gold-leadlag-worker.js`. It requires Node 20+, npm dependencies (including ws), and a 32+ character secret.

## Example commands on AWS
```bash
cd /opt/nexio
npm ci
export LEADLAG_INGEST_TOKEN="$(openssl rand -hex 32)"
export LEADLAG_PORT=8891
export LEADLAG_BINANCE_SYMBOL=XAUUSDT
node src/gold-leadlag-worker.js
```

**Do not use this as a production deployment script.** Store the secret securely and configure a systemd unit after validation. Never expose port 8891 publicly. Bind stays at 127.0.0.1. Do not paste secrets into chat.

## MT5 bridge contract
An existing MT5 terminal-side bridge (not yet implemented) must securely forward a JSON POST to `/mt5/tick` with `Authorization: Bearer <secret>` and body:
```json
{"bid":3917.57,"ask":3917.85,"exchangeTs":1793690000000}
```
The timestamp above is illustrative. `exchangeTs` must be actual millisecond epoch time of the MT5 tick. The current collector rejects stale ticks. For a remote MT5 terminal, use a private tunnel or authenticated HTTPS ingress; the loopback endpoint cannot be reached remotely.

## Current limitations
- The worker is **not deployed** and the MT5 sender is not implemented.
- Binance bookTicker may not provide exchange timestamps for every payload; receive-time fallback is not sufficient for sub-second causal conclusions.
- Paper entry calibration is blocked until real synchronized, cost-aware out-of-sample observations are available.
- The engine is in-memory; restart loses demo state. No Telegram integration or durable storage yet.
- Check that the Binance XAUUSDT futures contract is available for the target account/region before assuming it can be traded.
- A dedicated unit test suite, clock-offset measurements, bid/ask fill realism, and durable data capture are required before operational use.
