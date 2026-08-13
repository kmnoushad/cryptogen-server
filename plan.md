# NEXIO v6.8.1 → v6.9 Fix Plan

## Problem statement
User reports: after the v6.8.x update, ZERO Futures trade alerts fire; only a few Alpha alerts
arrive. ChatGPT and Claude previously failed to fix. Missions:
1. Root-cause why the Futures pipeline never reaches FIRE and fix it (without removing safety).
2. Add a SPECIAL CASE: a live Binance-Futures **fast-mover / sudden-pump detector** that alerts
   in near real time (WebSocket, not closed-candle polling).

## Root-cause hypotheses (from code read)
- H1: BTC regime gate (`classifyBtcRegime`) is long-only and fail-closed; in chop/bear phases
  `allowed=false` → the entire Futures universe is gated at `BTC_BLOCK` forever.
- H2: The arm→retest→reclaim→execution funnel multiplies ~15 simultaneous strict conditions
  (depth $100k/side within 0.5%, imbalance ≥0.75, ≤8bps impact, buyRatio1 ≥0.57 on the single
  reclaim candle, reclaim within 24-min TTL, etc.). Live probability ≈ 0 even when replays pass.
- H3: Closed-1m-bar-only architecture can never catch a sudden pump early — structural.
- H4: Account-risk gates (1 open trade, 2 consecutive losses/day) can silently freeze new entries;
  diagnostics exist but no Telegram visibility when the engine is frozen for hours.
- H5: Any single symbol data error (OI history missing etc.) throws per scan — acceptable, but
  error storms hide in logs.

## Stage 0 — Extract project
Rebuild the real repo from the uploaded dump into /mnt/agents/output/cryptogen-server/ so
coders can edit and `node --test` it.

## Stage 1 — Fix Futures alert pipeline (coder subagent)
Load skill: vibecoding-general-swarm.
- Make the strictest funnel gates configurable + soften defaults sensibly:
  depth/side 100k→50k, minEntryDepthImbalance 0.75→0.60, keep spread ≤10bps, keep impact gate.
- BTC gate: keep fail-closed for SHOCK, but add `BULLISH`/`BULLISH_PULLBACK`/`BULLISH_RETEST`
  unchanged; add explicit Telegram-visible diagnostics when the engine is BTC-frozen for hours.
- Add heartbeat/visibility: `/why` command + periodic (silent-log) funnel summary so the user can
  see exactly which gate is blocking; add `FUTURES_ENGINE_FROZEN` diagnostics event.
- Loosen reclaim single-candle flow gate slightly (buyRatio1 0.57→0.55, delta 0.14→0.10) behind
  env vars, without touching manipulation terminal-risk gates.
- Fix anything the audit finds that is a genuine bug (not preference).

## Stage 2 — Fast-mover pump detector (coder subagent, new module)
New `src/pump-detector.js`:
- WebSocket `wss://fstream.binance.com/stream?streams=!miniTicker@arr` (all USD-M symbols, ~1s).
- Rolling per-symbol price/volume windows (1m/3m/5m), detect: price +X% in ≤3 min (default 1.2%),
  volume acceleration vs its own baseline, above min 24h quote volume, not a memecoin-excluded
  symbol, BTC shock guard respected, per-symbol cooldown (default 30 min), global rate limit.
- On trigger: light REST confirm (ticker24h + depth spread check) → immediate Telegram
  `[FUTURES] ⚡ FAST MOVER` alert with move %, window, price, volume ratio, and a caution note.
  Dedup via nexio_events so restarts don't re-alert. Fully env-configurable; can be disabled.
- Health wired into /status and engine.health().

## Stage 3 — Tests + verification (verifier subagent)
- Extend node:test suite for new gates and the pump detector (injectable clock/ws double).
- `npm test` must pass; `node --check` every touched file.
- Reviewer pass: confirm no safety gate silently removed, no fabricated behavior.

## Stage 4 — Package & deliver
- Update version.js → 6.9.0, add V6.9-CHANGES.md, zip project to
  /mnt/agents/output/nexio-v6.9.zip for Railway redeploy.
