# SPEC — NEXIO v6.9.0 (Futures pipeline repair + Fast-Mover pump detector)

Repo: /mnt/agents/output/cryptogen-server (branch `v6.9` off baseline v6.8.1).
Node ≥20, ESM, only dependency `ws`. Tests: `node --test`. All new behavior env-configurable.
DO NOT weaken terminal manipulation gates (crash, sell-delta climax, OI divergence, depth
collapse+spread widening) and DO NOT touch Alpha or calendar logic except where noted.

## Workstream A — Why Futures never FIREs (repair)

A1. Make the strictest funnel gates configurable and set saner defaults (config.js):
- `MIN_DEPTH_EACH_SIDE_USD` default 100_000 → **50_000** (min 10_000).
- `MIN_ENTRY_DEPTH_IMBALANCE` default 0.75 → **0.60** (range 0.4–1.5).
- NEW `FUTURES_RECLAIM_MIN_BUY_RATIO` default **0.55** (range 0.50–0.70).
- NEW `FUTURES_RECLAIM_MIN_DELTA_RATIO` default **0.10** (range 0–0.30).
strategy.js: replace the hardcoded reclaim flow constants (fast 0.57/0.14, liquid 0.54/0.08)
with cfg values; liquid path keeps a 0.03/0.04 relaxation below the fast path (i.e.
liquid buyRatio = cfg − 0.03, liquid delta = cfg − 0.04, floored at 0.50/0.0).
Keep `context.risk.terminalRisk` handling byte-for-byte equivalent.

A2. BTC-freeze visibility (engine.js):
- Track `btcBlockedSince` (ms) whenever `btc.allowed === false`; reset when allowed.
- NEW env `BTC_BLOCK_HEARTBEAT_MIN` default **120** (0 = off). When the gate has been
  continuously closed for ≥ N minutes, send ONE Telegram + persist `FUTURES_BTC_BLOCK_HEARTBEAT`
  event (dedup key bucketed by N-minute window) containing: regime, EMA50 distance, slope6h,
  top-3 gate counts, candidates cancelled count. Repeat at most once per window.

A3. `/why` owner command (engine.js + no telegram.js change needed beyond using existing send):
Reply with: current BTC regime + numeric detail, whether risk snapshot allows entries (reasons),
top-5 pre-arm `IMPULSE:` blockers, top-5 candidate HOLD reasons, top-5 REJECT reasons,
current candidates with state, and fast-mover detector status line.

A4. Genuine bug fixes allowed if found during implementation; each must be documented in
V6.9-CHANGES.md with the evidence. No speculative rewrites.

## Workstream B — Fast-Mover (sudden pump) detector — NEW src/pump-detector.js

Special-case live channel: catches violent Binance USDT-M futures pumps in near real time,
independent of the slow closed-candle funnel. Informational-actionable alert, NOT a DB trade.

### Data feed
- WebSocket `wss://fstream.binance.com/stream?streams=!miniTicker@arr` (~1s, ALL symbols).
  Event: array of `{ E, s, c, o, h, l, v, q }` — `c` last price, `q` 24h rolling quote volume.
- Per symbol keep a ring buffer of `{ t, price, q }` (10-min horizon, ≥2 Hz not required; one
  point per incoming tick is fine, cap ~700 points/symbol, prune old).
- Volume velocity estimator: `volPerMin = (q_now − q_60s_ago)`; baseline = median of the same
  60s deltas over the previous 9 minutes. Over a 60s window the 24h-roll-off error is minor;
  treat it as a soft gate only, and hard-confirm via REST klines before alerting.

### Trigger (all must hold; defaults in parens, all env-overridable)
- price move vs 60s ago ≥ `FAST_MOVER_MIN_1M_PCT` (**0.8**)
- OR price move vs 180s ago ≥ `FAST_MOVER_MIN_3M_PCT` (**1.5**)
- volume acceleration ≥ `FAST_MOVER_VOLUME_ACCEL` × baseline (**3.0**), baseline > 0
- 24h quote volume ≥ `FAST_MOVER_MIN_QUOTE_USD` (**10_000_000**)
- symbol not in FUTURES_EXCLUDED, not BTC, status live (price > 0)
- realtime shock guard NOT blocked; engine not paused
- per-symbol cooldown `FAST_MOVER_COOLDOWN_MIN` (**30**), global cap
  `FAST_MOVER_MAX_ALERTS_PER_HOUR` (**6**)
- master switch `ENABLE_FAST_MOVER_ALERTS` (default **true**)

### Confirm-before-alert (REST, via existing BinanceClient)
- klines 1m limit 5 → last closed candles show the move and taker buyRatio ≥ 0.52
- depth limit 20 → spread ≤ `FAST_MOVER_MAX_SPREAD_BPS` (**30**, informational, looser than entry gate)
On confirm failure: stay silent, log, count metric `confirmRejected`.

### Alert + persistence
- Telegram: `[FUTURES] ⚡ FAST MOVER` with symbol, move % and window, price, volume accel ×,
  1m taker buy %, spread, 24h volume, and a clear caution line (sudden moves can reverse; this
  is a live radar ping, not the gated FIRE entry). Sent via existing telegram.send.
- Persist `FUTURES_FAST_MOVER` event to nexio_events, dedup key
  `fast-mover:{symbol}:{cooldownBucket}`; on DB failure still send the alert, log the error.
- Metrics: triggers, alerts, confirmRejected, suppressed (cooldown/cap/shock/paused).

### Robustness
- Same reconnect/backoff + 30s staleness watchdog pattern as src/realtime-shock.js
  (unref'd timers), no unhandled rejections, `stop()` clean.
- health(): enabled, connected, lastMessageAt, tracked symbols, metrics, lastError.
- Constructor MUST accept `{ WebSocketImpl, now, sleepImpl }`-style injectables for tests.

### Wiring
- index.js: construct, `start()` after engine.initialize(), `stop()` in shutdown; pass into
  Engine (like realtimeShock) so `/status` shows one line and scanOnce/`/why` can read health.
  Detector must keep running while engine paused? NO — paused suppresses new alerts (monitoring
  of existing trades is unaffected either way).

## Workstream C — Tests & docs
- test/pump-detector.test.js: ring buffer, each trigger gate on/off, cooldown, hourly cap,
  shock/pause suppression, confirm-fail silence, dedup key shape, reconnect scheduling.
  Use injected fake WS + fake binance + fake clock. No network.
- Update/extend test/config.test.js + test/strategy.test.js for A1 defaults.
- Bump src/version.js → `6.9.0`; package.json version → 6.9.0.
- Write V6.9-CHANGES.md: root-cause explanation of the silent Futures funnel, every gate
  change with old→new default, the fast-mover design, deployment notes (no SQL migration,
  new optional env vars listed).
- README.md: add short Fast-Mover section + new commands/env vars.
- `npm test` green and `node --check` on every touched file before commit.
Commit to branch `v6.9` in /mnt/agents/output/cryptogen-server.
