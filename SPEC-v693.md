# SPEC — NEXIO v6.9.3 (Alpha Fast-Mover radar + QUALIFIED runner fix)

Repo: /mnt/agents/output/cryptogen-server (master currently at v6.9.2). Branch `v6.9.3`.
Node ≥20, ESM, only dep `ws`. Tests: `node --test`. No new dependencies. NO SQL migration
(only nexio_events inserts with new event_type/dedup keys).
All new config vars MUST use the lenient v6.9.2 patterns (numberFromWarn / lenient bool) —
an invalid optional value warns and falls back, never throws at boot.

## Context
Binance Alpha tokens (on-chain, polled from the same ALPHA_URL in src/alpha.js) can go
vertical (user example: APR +163% in ~18h). The existing AlphaRadar pipeline is too slow to
catch the early leg: it needs ≥3 snapshots (~12 min at 240s polling) before qualification,
and demotes QUALIFIED tokens back to SEEDED once change24h crosses +40 — abandoning exactly
the strongest runners. v6.9.3 adds an independent fast radar and fixes the demotion.

## Workstream A — NEW src/alpha-mover.js (Alpha Fast-Mover radar)

Informational-actionable early alert. NO database trade row, NO outcome monitoring,
NO changes to AlphaRadar's IGNITION logic.

### Class contract
```js
export class AlphaFastMover {
  constructor({ cfg, store, telegram, fetcher, assessSecurity, now, sleepImpl })
  // fetcher: defaults to requestJson — used to GET the Alpha token list (same ALPHA_URL
  //   as src/alpha.js; import and reuse that constant or redefine it identically)
  // assessSecurity: defaults to fetchAndAssessOnchain from './onchain-risk.js'
  // now: defaults to Date.now; sleepImpl: defaults to util.sleep
  async pollOnce()   // one fetch + evaluate cycle; fully awaitable for tests
  start()            // begins an internal loop: pollOnce every cfg.alphaMoverPollMs,
                     // errors logged and counted, loop keeps going; idempotent
  stop()             // clean stop, clears timer
  health()           // { enabled, lastPollAt, tracked, metrics, lastError }
}
```

### Detection (per token, keyed `chainId:contractAddress.toLowerCase()`)
- Ring buffer per token of `{ t, price, liquidity, holders }`, 60-min horizon, cap ~120 points.
- Skip tokens failing hard floors: price > 0, liquidity ≥ cfg.alphaMoverMinLiquidityUsd,
  volume24h ≥ cfg.alphaMinVolumeUsd, holders ≥ cfg.alphaMinHolders (reuse existing cfg keys).
- Skip if `change24h >= cfg.alphaMoverMax24hChangePct` (too late — default 60) or
  `change24h <= -20`.
- TRIGGER (either): price vs ~10 min ago ≥ cfg.alphaMoverMin10mPct (default 3.0)
  OR price vs ~30 min ago ≥ cfg.alphaMoverMin30mPct (default 6.0).
  Reference point = latest buffer point at-or-before (now − window), with a staleness cap
  of 2 poll intervals; if no reference exists (insufficient history), no trigger — never
  fabricate a reference from too-old data.
- Soft confirmation: liquidity vs 30 min ago ≥ -3% (if reference available), holders not
  decreasing vs previous point (when both finite).
- Suppression: engine paused (inject `isPaused: () => engine?.paused` like the futures
  detector), per-token cooldown cfg.alphaMoverCooldownMin (default 60), global hourly cap
  cfg.alphaMoverMaxAlertsPerHour (default 4), or an OPEN alpha trade / IGNITED state for the
  same contract is NOT required to be checked (radar is independent; note this in docs).
- On trigger: security screen via assessSecurity(token, cfg) BEFORE alerting:
  - `hardBlock === true` → silent; log + metric `blocked`.
  - `riskScore > cfg.alphaMoverMaxRiskScore` (default 5) → silent; log + metric `blocked`.
  - otherwise send alert; if rating is POSSIBLE_RUG/CAUTION the message shows a ⚠️ label.
  - security check throws → skip this cycle, metric `errors`, no alert (fail-safe).
- Dedup: insert nexio_events FIRST, event_type `ALPHA_FAST_MOVER`, key
  `alpha-mover:{key}:{floor(now / (cooldownMin*60000))}`; insertEvent → false ⇒ log, metric
  `dedupSkipped`, NO telegram; DB throw ⇒ log, still send (same semantics as v6.9.1 futures
  detector).
- Telegram message: `[ALPHA] ⚡ FAST MOVER` with symbol, chain name, +move% and window
  (10m/30m), price, liquidity, holders, 24h change, security label, and an explicit caution
  line (early radar ping, unverified move, tiny size / DYOR — NOT the guarded IGNITION entry).
  HTML-escape all strings via escapeHtml; formatPrice for prices; reuse the `usd` short
  formatting style from telegram.js (small local helper is fine).

### New env vars (all lenient-parsed, defaults shown)
ENABLE_ALPHA_FAST_MOVER (true), ALPHA_MOVER_POLL_MS (90_000; min 45_000 max 600_000),
ALPHA_MOVER_MIN_10M_PCT (3.0; 0.5–20), ALPHA_MOVER_MIN_30M_PCT (6.0; 1–40),
ALPHA_MOVER_MAX_24H_CHANGE_PCT (60; 20–200), ALPHA_MOVER_COOLDOWN_MIN (60; 5–720),
ALPHA_MOVER_MAX_ALERTS_PER_HOUR (4; 1–30), ALPHA_MOVER_MAX_RISK_SCORE (5; 0–10),
ALPHA_MOVER_MIN_LIQUIDITY_USD (150_000; min 25_000).

### Wiring (src/index.js, src/engine.js)
- index.js: construct after engine, inject `isPaused`, `start()` after engine.initialize(),
  `stop()` in shutdown; add one startup-message line when enabled.
- engine.js: accept `alphaMover` constructor param; include its health() in health() output;
  one line in /status and /why replies. Engine must NOT import alpha-mover.js (avoid cycles —
  index.js wires the instance, exactly like the v6.9 fastMover pattern).

## Workstream B — QUALIFIED runner fix (src/alpha.js, minimal)
Today: when a tracked token falls out of `eligible()` (including `change24h >= 40`), a
QUALIFIED token is demoted to SEEDED and loses its ignition window.
Change: split the eligibility check into hard floors (price>0, volume24h, liquidity, holders,
change24h > -20) versus the heat cap (change24h < 40).
- Demotion of QUALIFIED happens ONLY when a hard floor fails.
- The heat cap still blocks NEW SEEDED→QUALIFIED transitions (conservative entry preserved).
- A QUALIFIED token riding past +40% keeps its window and can still complete IGNITION if the
  since-qualified move and second security check pass.
Keep the change small and documented; do not otherwise alter scoring or ignition thresholds.

## Workstream C — Tests & docs
- test/alpha-mover.test.js (new): ring buffer reference/staleness, each gate on/off, 10m vs
  30m windows, cooldown, hourly cap, pause suppression, hardBlock silent, riskScore ceiling
  silent, security-throw fail-safe, dedup-hit no-send, DB-error still-sends, health shape.
  Inject fake fetcher/assessSecurity/now/sleep — no network, no real timers in assertions.
- test/alpha.test.js: add cases for the runner fix (QUALIFIED survives change24h ≥ 40 with
  floors intact; demotion still happens when liquidity floor fails; new qualification still
  blocked by heat cap).
- test/config.test.js: defaults + lenient fallback for all new vars.
- Bump src/version.js + package.json → 6.9.3. Append a v6.9.3 section to V6.9-CHANGES.md
  (motivation with the APR example, env var table, deployment: no SQL, all vars optional).
  README.md: short Alpha Fast-Mover paragraph.
- `npm test` green (baseline 95) and `node --check` on all touched files before commit.
Commit to branch `v6.9.3`.
