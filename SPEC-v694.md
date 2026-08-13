# SPEC — NEXIO v6.9.4 (Tier-2 TRENDING MOVER + suppression observability)

Repo: /mnt/agents/output/cryptogen-server (master = v6.9.3). Branch `v6.9.4`.
Node ≥20, ESM, only dep `ws`. `node --test`. No new deps. NO SQL migration.
All new config vars MUST use the lenient numberFromWarn / lenient-bool pattern (never throw).

## Problem
The v6.9 fast-mover detector (src/pump-detector.js) only fires on violent bursts:
+0.8%/60s or +1.5%/180s with ≥3× 60s volume acceleration, then a REST confirm
(taker buyRatio ≥ 0.52, spread ≤ 30 bps). Real 24h gainers often grind up over
15–60 minutes on thinner books — no burst, or confirm rejects the thin spread —
so the radar stays silent on exactly the moves the user sees in the Gainers tab.

## Workstream A — Tier-2 "TRENDING MOVER" inside src/pump-detector.js

Second, independent detection tier in the SAME FastMoverDetector class (reuses the
existing WebSocket, buffers concept, confirm plumbing, cooldown/cap machinery).
Tier 1 behavior must stay byte-equivalent (all existing pump-detector tests pass).

### Slow ring buffer
- Add a second per-symbol buffer `slowPoints`: store at most ONE point per 15s per symbol
  (decimate on ingest), 70-minute horizon, cap ~300 points. Prune like the fast buffer;
  reap dead symbols in the same watchdog pass.
- Volume velocity for tier 2: use a 5-minute delta of `q` vs the median of 5-minute deltas
  over the prior ~60 min of the slow buffer (soft gate, baseline must be > 0).

### Trigger (any window; all env-configurable, defaults shown)
- move vs ~15 min ≥ TRENDING_MIN_15M_PCT (2.0; range 0.5–10)
- OR move vs ~30 min ≥ TRENDING_MIN_30M_PCT (3.5; range 1–20)
- OR move vs ~60 min ≥ TRENDING_MIN_60M_PCT (5.0; range 1.5–40)
- 5-min volume acceleration ≥ TRENDING_VOLUME_ACCEL (2.0; range 1–10)
- 24h quote volume ≥ existing fastMoverMinQuoteUsd
- not BTC / not FUTURES_EXCLUDED / price > 0
- shock guard not blocked; engine not paused
- Reference-point selection with staleness cap = min(2 × 15s decimation, 60s) beyond the
  window target — never fabricate a reference from too-old data.
- Master switch ENABLE_TRENDING_MOVER (default true).
- Evaluate tier 2 at most once per 15s per detector tick pass (it's fine to evaluate on the
  decimated-point cadence) — do NOT run it on every raw tick.

### Confirm + alert
- REST confirm (reuse binance injection): klines 1m limit 5 → taker buyRatio ≥
  TRENDING_MIN_BUY_RATIO (0.50; range 0.40–0.70); depth limit 20 → spread ≤
  TRENDING_MAX_SPREAD_BPS (45; range 5–200). Confirm failures: silent, log, count metric
  `trendingConfirmRejected`, and throttle re-attempts per symbol ≥ 120s (separate from the
  tier-1 throttle map).
- Separate cooldown TRENDING_COOLDOWN_MIN (120; range 15–720) and hourly cap
  TRENDING_MAX_ALERTS_PER_HOUR (4; range 1–20) — independent maps/counters from tier 1.
- Dedup: insertEvent FIRST, event_type `FUTURES_TRENDING_MOVER`, key
  `trending-mover:{symbol}:{floor(now/(cooldownMin*60000))}`; false ⇒ log + metric
  `trendingDedupSkipped`, NO send; DB throw ⇒ log, still send.
- Telegram: `[FUTURES] 📈 TRENDING MOVER` — symbol, move % and which window (15/30/60m),
  price, 5-min volume accel ×, taker buy %, spread, 24h volume, and a caution line
  (steady mover — not a burst; can still reverse; radar ping, not a gated entry).
  escapeHtml all strings; formatPrice for prices.

## Workstream B — Suppression observability
- Both tiers maintain per-reason suppression counters:
  { cooldown, hourlyCap, shock, paused, volumeLow, quoteLow, confirmRejected, dedupSkipped }.
- Expose in health(): `metrics` plus `suppressed` breakdown and `lastTriggerAt`,
  `lastAlertAt`, `lastSuppressedReason`.
- engine.js `/why` reply: extend the fast-mover status line into 2–3 lines showing tier-1 and
  tier-2 alerts/triggers and the top-2 suppression reasons with counts. `/status` gets one
  compact line per tier. Keep messages short (Telegram-friendly).

## Workstream C — Tests & docs
- test/pump-detector.test.js: extend — slow-buffer decimation/horizon, each tier-2 window
  on/off, volume-accel soft gate, confirm reject throttle ≥120s, cooldown/cap independence
  from tier 1 (a tier-1 alert must not consume tier-2 cap and vice versa), dedup-hit no-send,
  DB-error still-sends, suppression counters increment correctly, health() new fields.
- test/config.test.js: defaults + lenient fallback for all 9 new vars.
- Bump version.js + package.json (+ lockfile version fields) → 6.9.4.
- V6.9-CHANGES.md: add v6.9.4 section (why tier 1 missed 24h gainers, tier-2 design, env
  table, no-SQL deployment note). README.md: 2–3 lines on the two radar tiers.
- `npm test` green (baseline 126) + `node --check` all touched files before commit.
Commit to branch `v6.9.4`.
