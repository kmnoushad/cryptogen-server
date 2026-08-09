# v5.51 forensic audit

These are correctness failures, not preferences about indicator thresholds.

1. Almost every indicator consumes the current, unfinished 15-minute candle. Candle quality, RSI, ATR, volume, impulse, CVD, and confirmation can therefore repaint after the alert.
2. `breakoutConfirmed` does not test a breakout level. It only tests whether the previous candle moved 0.3% with volume, then uses the unfinished current candle as confirmation.
3. The CVD implementation assigns all volume on a green candle to buyers and all volume on a red candle to sellers. Binance already supplies taker-buy volume at kline index 9, so the calculated divergence is false.
4. `checkATRExpansion()` calls `calculateATR()` with exactly 10 candles and period 10, while `calculateATR()` requires 11. Recent ATR is always zero; expansion is always about -100%.
5. BTC 4-hour EMA200 is requested from only 100 candles. It is `null`, then JavaScript compares EMA50 with `null` as if `null` were zero, corrupting the regime trend flag.
6. HTF fetch failures return `bullish: true, bearish: true`; BTC fetch failures return `pass: true`. Critical missing data enables trades instead of disabling them.
7. Startup runs both scanners before the first BTC regime calculation. `UNKNOWN !== CHOPPY`, so an alert can fire while the regime is unknown.
8. The "30m/1h/2h" pump check actually measures about 15m/45m/105m and uses absolute change, so a dump is also stored as a pump.
9. Market-mover "fresh volume" subtracts two rolling 24-hour volume snapshots. That is not fresh volume because old trades leave the rolling window at the same time new trades enter it.
10. The fake-pump history detector can count overlapping 4-hour candles from one move as several independent schemes. A normal volatile retracement can therefore permanently blacklist a coin.
11. The Alpha filter skips a token as soon as liquidity drops under the minimum. That means the exact token whose liquidity is collapsing is excluded before the rug-warning code runs.
12. Alpha compares only one four-minute liquidity snapshot with the previous one and has no LP lock, ownership, mint, freeze, honeypot, tax, deployer, or holder-concentration data. It is not a rug detector.
13. The minimum futures volume was reduced to $200k/day. Such contracts are the easiest to manipulate and the hardest to exit near the displayed price.
14. A single order-book snapshot is trusted even though walls can be spoofed or cancelled. The fixed $30k wall threshold is not scaled to market liquidity.
15. Social follower counts and CoinGecko sentiment are stale absolute values, symbol mapping can select the wrong same-symbol token, and the result changes the entry score.
16. The score double-counts correlated facts and is displayed as confidence even though it is not calibrated to probability.
17. Coin-specific decisions are changed after three to five trades. That sample is too small and overfits recent noise.
18. EARLY and FIRE can both trigger in the same loop. `signalPrices` is overwritten by FIRE while the database can retain the EARLY entry, so monitoring and recorded results refer to different trades.
19. Active positions are keyed only by symbol, kept in memory, and not rehydrated after restart. Cooldowns and alert state are also lost on every deploy.
20. Active-position monitoring only runs for symbols still in the watchlist. Stale watchlist cleanup can silently stop risk management.
21. Signal cleanup deletes entries after four hours, while the position manager claims a six-hour timeout; the six-hour branch is normally unreachable.
22. Paper outcomes poll only the current ticker every ten minutes. An intrabar SL or TP that touches and reverses is missed, and if both occur the execution order is unknowable.
23. Paper trades time out at four hours while chat position management times out at six hours. The two systems measure different strategies.
24. Paper closures do not consistently call `recordWin()` or `recordLoss()`, so recovery mode and kill switches do not reflect recorded outcomes.
25. `DAILY_LOSS_STOP_PCT`, `DAILY_PROFIT_STOP`, and `MAX_TRADES_PER_DAY` are declared but never enforced; `dailyTrades` is never incremented.
26. Loss PnL is hardcoded as -1.8% even though each signal has a different ATR stop. Weekly drawdown subtracts a fixed 1.8% per net loss instead of summing trade PnL.
27. SL and TP1 are both 1.2 ATR, which is 1:1 before fees/slippage, while the startup message claims at least 1:1.5.
28. Momentum-stall, retrace, fade, and breakeven messages do not close or update the paper trade. Reported strategy statistics therefore do not represent the instructions sent to the user.
29. A trailing exit updates the database but leaves the in-memory signal active, allowing later timeout accounting and duplicate win recording.
30. Supabase inserts rely on `Prefer: resolution=merge-duplicates` without guaranteed unique constraints or `on_conflict`, so duplicate protection is not reliable across Railway instances.
31. Alert dedup hashes the full message, including its changing timestamp. Repeated semantic alerts are different hashes.
32. Network fixes are started by an unawaited dynamic DNS import, while API requests can begin immediately.
33. Binance, Supabase, and Telegram failures are frequently swallowed. There is no status-aware 418/429 backoff, and Telegram can reject an alert without any visible error.
34. The full scan is sequential and performs many per-symbol requests. Its nominal five-minute schedule is not its real latency, and overlap locks merely skip delayed cycles.
35. Alpha, mover, surge, EARLY, and FIRE use conflicting meanings of "signal"; some have entry prices but are not measured, while others are measured with different exit rules.

v6 removes these paths rather than adding more score bonuses to them.
