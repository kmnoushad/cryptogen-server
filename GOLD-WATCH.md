# CryptoNerd Gold Watch

Gold Watch is an isolated, paper-only XAU/USD monitoring worker. It sends setup observations and simulated-account results to the dedicated Telegram group.

## Safety boundary

- No Binance, MT5, broker, or order API is imported.
- `GOLD_MODE` must equal `paper`.
- `LIVE_TRADING_ENABLED` and `MT5_TRADING_ENABLED` must remain `false`.
- The process refuses to start if any safety setting is changed.
- The initial paper balance defaults to USD 100.
- Automatic paper entries default to off while the feed is validated.

## Phase 1 behavior

- Pull 5-minute XAU/USD bars from Twelve Data.
- Scan recent global reporting through GDELT and alert only conservative high-impact keyword matches.
- Label each event as confirmed public reporting, single-source reporting, or reported/unconfirmed.
- Keep event alerts informational: headlines never open even a paper position.
- Calculate EMA20, EMA50, RSI14, ATR14, support, and resistance.
- Alert only when trend, pullback, and confirmation produce the configured minimum confidence.
- Model spread and slippage in the paper ledger.
- Report when the theoretical size is below the configured broker minimum. This is important because a USD 100 account may be too small for a realistic 0.01-lot gold position at sensible risk.
- Persist state atomically under `/var/lib/nexio-gold/state.json`.

No setup is a recommendation to trade.

The event classifier is deliberately conservative and rule-based. It is a monitoring aid, not a guarantee that a report is true or that gold will move in the labeled direction.
