# NEXIO v6.2 — Actionable Alerts

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

## Alpha rug screening

Binance Alpha scanning is enabled by default. Before an Alpha entry alert, the bot sends the chain and contract address to GoPlus and checks contract permissions and live security data. Confirmed honeypots, blocked selling, dangerous taxes, active mint/freeze authority, balance-changing ownership, closed-source contracts, unavailable checks, and excessive risk scores block the entry silently.

This substantially improves detection, but no automated provider can guarantee that a token will not rug later. Alpha alerts therefore use tiny-size/manual-entry language and remain separate from the futures paper ledger.

## Notification policy

Automatic Telegram output is deliberately limited to actionable events:

- `[FUTURES] FIRE` after the full closed-bar breakout, retest and reclaim gate.
- `[ALPHA] IGNITION` after internal qualification, live acceleration and a second on-chain check.
- Exit/outcome messages for an issued Futures paper trade.
- One startup confirmation.

Priority lists, WATCH/ARMED/RETESTED states, Alpha QUALIFIED states, pump/dump blocks, rug warnings, rejected coins and data errors remain silent. They are processed internally and important filters are persisted to `nexio_events` for diagnostics.

## Install

1. In Supabase, run `sql/schema.sql` once.
2. Copy `.env.example` to your Railway variables and fill the four required values.
3. Keep `PAPER_MODE=true`.
4. Deploy with Node 20 or newer. No npm packages are required.

Use `DEPLOYMENT.md` for the safe cutover sequence. Do not run v5.51 and v6 against the same Telegram bot token: two `getUpdates` pollers will steal updates from each other. Subscriptions, payments, broadcasts, social-hype scoring, and economic-calendar guesses remain excluded so they cannot change or delay trade decisions. Your old `paper_trades` data is left untouched; v6 writes to `nexio_trades` because the old outcomes are not trustworthy enough to train the new gate.

```bash
npm test
npm start
```

The service exposes `/health` on `PORT` and supports these owner Telegram commands:

- `/status`
- `/stats`
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

Official reference: <https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data>

GoPlus token-security reference: <https://docs.gopluslabs.io/reference/tokensecurityusingget_1>
