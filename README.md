# NEXIO v6 — Recovery Core

This is a clean replacement for the signal engine in v5.51. It remains a paper-trading system by default and intentionally produces fewer alerts.

The central change is simple: an impulse is **not** an entry. The engine first arms a candidate, waits for a controlled retest, and only signals after a new **closed 1-minute candle** reclaims the breakout with real taker-buy flow, acceptable open interest, narrow spread, sufficient depth, and a bullish BTC regime.

## What this fixes

- Never scores the still-open candle. This removes the repainting that made alerts fade immediately.
- Uses Binance's actual taker-buy kline field for order-flow delta. A green candle is no longer treated as proof of buying pressure.
- Detects a real breakout level from candles that existed before the impulse.
- Waits for a retest and reclaim instead of entering the vertical pump candle.
- Blocks thin contracts by default: at least $15M 24-hour quote volume, $100k depth on each side within 0.5%, and no more than 10 bps spread.
- Treats price spikes, OI contraction, sell-delta, wick rejection, depth collapse, and repeated pump/retrace episodes as manipulation/fade risk.
- Evaluates paper exits from every closed 1-minute candle. If SL and TP occur in the same candle, it records SL first (conservative), rather than guessing a win from a later ticker snapshot.
- Uses actual net PnL and R-multiples after configurable fees/slippage for limits and statistics.
- Monitors open trades independently from the watchlist and restores them after restart.
- Fails closed when BTC, candles, OI, depth, database, or exchange data are unavailable.
- Enforces one open trade, daily/weekly limits, and consecutive-loss limits.
- Uses database uniqueness so two Railway instances cannot create the same signal twice.

## Important: "rug pull" versus a futures dump

Binance futures candles and order books cannot prove an on-chain rug pull. Real rug screening requires the token contract and chain plus checks for LP ownership/lock, mint/freeze authority, honeypot or sell restrictions, taxes, deployer wallets, and holder concentration.

For that reason, `ENABLE_ALPHA_SIGNALS` is disabled and v6 refuses to start if somebody turns it on. An audited on-chain adapter is not part of this recovery core. The futures engine detects **manipulation/fade/crash risk**, which is the observable problem that causes a futures entry to collapse.

## Install

1. In Supabase, run `sql/schema.sql` once.
2. Copy `.env.example` to your Railway variables and fill the four required values.
3. Keep `PAPER_MODE=true`.
4. Deploy with Node 20 or newer. No npm packages are required.

Use `DEPLOYMENT.md` for the safe cutover sequence. Do not run v5.51 and v6 against the same Telegram bot token: two `getUpdates` pollers will steal updates from each other. This recovery project deliberately excludes subscriptions, payments, broadcasts, Alpha entries, social-hype scoring, and economic-calendar guesses so those systems cannot change or delay trade decisions. Your old `paper_trades` data is left untouched; v6 writes to `nexio_trades` because the old outcomes are not trustworthy enough to train the new gate.

```bash
npm test
npm start
```

The service exposes `/health` on `PORT` and supports these owner Telegram commands:

- `/status`
- `/candidates`
- `/stats`
- `/scan`
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

Official reference: <https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data>
