# NEXIO v6.9.0 — Futures Funnel Repair + Fast-Mover Pump Radar

This is a clean replacement for the signal engine in v5.51. It remains a paper-trading system by default and intentionally produces fewer alerts.

An impulse is **not** an entry. The engine first arms a candidate, waits for a controlled retest, and only signals after a new **closed 1-minute candle** reclaims the level with real taker-buy flow, acceptable open interest, narrow spread, sufficient depth, and an approved BTC regime. It can arm from a fast breakout, sustained 15–30 minute advance, or a slower trend in a deep Binance USDT perpetual.

## What this fixes

- Never scores the still-open candle. This removes the repainting that made alerts fade immediately.
- Uses Binance's actual taker-buy kline field for order-flow delta. A green candle is no longer treated as proof of buying pressure.
- Detects a real breakout level from candles that existed before the impulse.
- Waits for a retest and reclaim instead of entering the vertical pump candle.
- Keeps valid candidates for 24 minutes and accepts setup-aware standard pullbacks or controlled shallow consolidations before reclaim.
- Uses setup-specific, closed-price impulse giveback limits: fast 50%, steady 60% and liquid trend 70%, with an ATR floor and consecutive confirmation for slow setups. Temporary wicks do not become automatic terminal failures.
- Streams BTC aggregate trades in parallel with the closed-candle scanner. A rolling 0.35% BTC fall within 10 seconds immediately cancels all pending Futures candidates and blocks new entries for two minutes.
- Reserves 30% of the universe for liquid contracts accelerating between five-minute universe snapshots; the remainder stays liquidity-ranked.
- Keeps Futures enabled during a controlled intraday BTC pullback when BTC remains above a rising hourly EMA50/EMA200 structure. A real 5m/15m/1h downside shock still blocks entries.
- Keeps Futures enabled during a tightly bounded BTC EMA50 support retest when EMA50 remains above EMA200, its six-hour slope is no worse than -0.05%, BTC is no more than 0.35% below EMA50, micro-trend is healthy, and no downside shock is present.
- Scans deep Binance Futures contracts including ETH, BNB, SOL, XRP, ADA and TRX; BTC remains the regime instrument and is not traded.
- Adds a `LIQUID_TREND` path for slower deep contracts. It still requires configured depth, spread, OI, manipulation screening, a controlled retest and a later closed-bar reclaim.
- Confirms LIQUID_TREND reclaims from current EMA structure, current five-minute stability and multi-minute taker buying, rather than requiring all pre-retest 15–30 minute heat to remain unchanged.
- Uses the latest closed five-minute BTC price for the regime decision instead of the older hourly close.
- Uses a volatility-based minimum stop for quiet liquid contracts instead of rejecting every stop below a fixed 0.30%.
- Exposes the Futures funnel, exact terminal rejection reasons, waiting gates and pre-arm filters separately through `/diagnostics`, so large impulse counts cannot hide the post-arm blocker.
- Persists 15-minute Futures gate summaries to Supabase, so diagnostics survive a Railway restart and can be audited over 24 hours.
- Blocks thin contracts by default: at least $15M 24-hour quote volume, $100k depth on each side within 0.5%, and no more than 10 bps spread.
- Walks the live ask ladder for the configured paper order size and rejects an entry whose measured impact exceeds 8 bps. It also requires aggregated bid/ask support, bid-depth retention and controlled spread expansion at the reclaim decision.
- Keeps a structurally valid reclaim in `RECLAIMED_WAIT_BOOK` for up to three closed bars when execution liquidity is temporarily weak; FIRE remains impossible until every final execution gate recovers.
- Uses a rolling median of recent depth snapshots for retention and spread-expansion checks instead of trusting one noisy prior snapshot.
- Records top-three order-book imbalance for diagnosis but does not trust it as the only gate; three levels are too easy to spoof.
- Separates terminal manipulation from temporary entry-quality weakness after arming. Crashes, sell-delta climax, severe OI divergence and catastrophic depth collapse still reject immediately; recoverable thin books wait without permission to FIRE.
- Evaluates paper exits from every closed 1-minute candle. If SL and TP occur in the same candle, it records SL first (conservative), rather than guessing a win from a later ticker snapshot.
- Uses actual net PnL and R-multiples after configurable fees/slippage for limits and statistics.
- Monitors open trades independently from the watchlist and restores them after restart.
- Closes a recorded Futures trade on a deterministic closed-bar momentum fade, then sends the matching close instruction.
- Retries unsent Futures and Alpha outcome messages after Telegram/network failure instead of silently losing the warning.
- Fails closed when BTC, candles, OI, depth, database, or exchange data are unavailable.
- Enforces one open trade, daily/weekly limits, and consecutive-loss limits.
- Uses database uniqueness so two Railway instances cannot create the same signal twice.

## Fast-Mover pump radar (v6.9)

The closed-candle Futures funnel is deliberately slow: it can take 5–25 minutes from impulse to FIRE, and the BTC long gate can freeze it for hours. v6.9 adds an independent live channel that watches Binance's `!miniTicker@arr` USD-M firehose (all symbols, ~1s) for violent sudden pumps:

- triggers on a ≥0.8% 60s move (or ≥1.5% 180s move) with volume acceleration ≥3× its own 9-minute baseline, on contracts with ≥$10M 24h quote volume;
- confirms against REST before alerting: the last closed 1m klines must show the move with ≥52% taker buying, and the live spread must be ≤30 bps;
- respects the realtime BTC shock guard, the `/pause` switch, a 30-minute per-symbol cooldown and a 6-alerts-per-hour global cap;
- sends `[FUTURES] ⚡ FAST MOVER` as an informational radar ping — it never opens a database trade — and persists a deduplicated `FUTURES_FAST_MOVER` event to `nexio_events`.

v6.9 also repairs the silent Futures funnel: the reclaim taker-flow gate (previously hardcoded at 0.57/0.14) and the execution depth gates are now configurable with saner defaults (`FUTURES_RECLAIM_MIN_BUY_RATIO` 0.55, `FUTURES_RECLAIM_MIN_DELTA_RATIO` 0.10, `MIN_DEPTH_EACH_SIDE_USD` $50k, `MIN_ENTRY_DEPTH_IMBALANCE` 0.60). Terminal manipulation gates (crash, sell-delta climax, OI divergence, depth collapse + spread widening) are unchanged. A new `BTC_BLOCK_HEARTBEAT_MIN` (default 120) emits one Telegram + persisted event per window while the BTC gate keeps Futures frozen, and `/why` explains live why the bot is quiet.

All Fast-Mover thresholds are optional env vars: `ENABLE_FAST_MOVER_ALERTS`, `FAST_MOVER_MIN_1M_PCT`, `FAST_MOVER_MIN_3M_PCT`, `FAST_MOVER_VOLUME_ACCEL`, `FAST_MOVER_MIN_QUOTE_USD`, `FAST_MOVER_COOLDOWN_MIN`, `FAST_MOVER_MAX_ALERTS_PER_HOUR`, `FAST_MOVER_MAX_SPREAD_BPS`.

## Alpha rug screening

Binance Alpha scanning is enabled by default. Before an Alpha entry alert, the bot sends the chain and contract address to GoPlus and checks contract permissions and live security data. Confirmed honeypots, blocked selling, dangerous taxes, active mint/freeze authority, balance-changing ownership, closed-source contracts, unavailable checks, and excessive risk scores block the entry silently.

This substantially improves detection, but no automated provider can guarantee that a token will not rug later. Alpha alerts therefore use tiny-size/manual-entry language and remain separate from Futures. Every issued Alpha IGNITION is now written to `nexio_alpha_trades` and monitored for stop, TP1, liquidity loss, momentum fade, and six-hour timeout. Filtered coins still remain silent.

## Finnhub economic calendar

v6.5 restores information-only reminders for US high-impact economic events from Finnhub. The calendar runs in its own 30-second loop, uses a six-hour API cache, and cannot change or delay Futures or Alpha scoring. It provides:

- an 08:00–10:59 Dubai morning summary when important US events are scheduled that day;
- reminders near four hours, 60, 45, 30 and 15 minutes before an event;
- a release-time warning;
- persistent deduplication through the existing `nexio_events` table;
- `/events` and `/calendar` for the next 14 days.

All messages state that direction is unknown. If Finnhub is unavailable or the account does not include the calendar endpoint, the error is shown in `/events`; trading continues normally. Finnhub currently documents Economic Calendar as a premium endpoint.

## Notification policy

Automatic Telegram trade output is deliberately limited to actionable events:

- `[FUTURES] FIRE` after the full closed-bar breakout, retest and reclaim gate.
- `[FUTURES] ⚡ FAST MOVER` live radar pings for violent confirmed pumps (informational; no database trade).
- `[FUTURES] BTC GATE BLOCKED` heartbeat at most once per `BTC_BLOCK_HEARTBEAT_MIN` window while the BTC long gate keeps the funnel frozen.
- `[ALPHA] IGNITION` after internal qualification, live acceleration and a second on-chain check.
- Exit/outcome messages for issued Futures and Alpha trades only.
- Separate high-impact US calendar information and staged reminders. These do not constitute trade signals.
- One startup confirmation.

Priority lists, WATCH/ARMED/RETESTED states, Alpha QUALIFIED states, pump/dump blocks, rug warnings, rejected coins and data errors remain silent. They are processed internally and important filters are persisted to `nexio_events` for diagnostics.

## Install

1. Existing v6.4 installation: no new SQL is required. Existing v6.1–v6.3 database: run `sql/v6.4-migration.sql`. Completely new database: run `sql/schema.sql`.
2. Copy `.env.example` to your Railway variables and fill the four required values.
3. Keep `PAPER_MODE=true`.
4. Deploy with Node 20 or newer. Railway installs the locked `ws` dependency from `package-lock.json`. Upgrading from v6.4–v6.8.1 requires no new SQL and no required new Railway variables; all v6.9 variables (BTC-block heartbeat, reclaim thresholds, Fast-Mover radar) have safe defaults.

Use `DEPLOYMENT.md` for the safe cutover sequence. Do not run v5.51 and v6 against the same Telegram bot token: two `getUpdates` pollers will steal updates from each other. Subscriptions, payments, broadcasts and social-hype scoring remain excluded. The live calendar is isolated from trade decisions. Your old `paper_trades` data is left untouched; v6 writes to `nexio_trades` because the old outcomes are not trustworthy enough to train the new gate.

```bash
npm test
npm run smoke
npm run smoke:ws
npm run audit:futures
npm start
```

The service exposes `/health` on `PORT` and supports these owner Telegram commands:

- `/status`
- `/version`
- `/why` (live explanation of a quiet bot: BTC gate, risk snapshot, top blockers, candidates, Fast-Mover status)
- `/diagnostics`
- `/audit`
- `/stats`
- `/events` or `/calendar`
- `/scan`
- `/alphascan`
- `/pause`
- `/resume`
- `/help`

## Promotion rule

Do not switch this to live merely because the first trades win. Keep a frozen configuration for at least 100 closed, out-of-sample paper trades across different market regimes. Evaluate expectancy, profit factor, maximum drawdown, and results after fees/slippage—not win rate alone.

## Data definitions

The implementation follows Binance's official USD-M fields:

- Klines: `/fapi/v1/klines`; index 7 is quote volume and index 9 is taker-buy base volume.
- Open-interest history: `/futures/data/openInterestHist`; comparisons use consecutive `sumOpenInterest` observations.
- 24-hour universe data: `/fapi/v1/ticker/24hr`.
- Order-book validation: `/fapi/v1/depth`.
- Realtime BTC micro-shock input: Binance USD-M `btcusdt@aggTrade` WebSocket stream.
- Fast-Mover radar input: Binance USD-M combined stream `!miniTicker@arr` (`c` last price, `q` 24h rolling quote volume per symbol), REST-confirmed via `/fapi/v1/klines` and `/fapi/v1/depth`.

Official reference: <https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data>

GoPlus token-security reference: <https://docs.gopluslabs.io/reference/tokensecurityusingget_1>

Finnhub Economic Calendar reference: <https://finnhub.io/docs/api/economic-calendar>
