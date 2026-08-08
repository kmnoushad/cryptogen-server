# Railway cutover

## Before deployment

1. Leave the current v5.51 service running while you create the new Supabase tables.
2. Run `sql/schema.sql` in the Supabase SQL editor.
3. Confirm there are no legacy rows in `nexio_trades`; this is a new table and must start clean.
4. Add the variables from `.env.example` to a new Railway service.
5. Use the Supabase **service-role** key only in Railway. Never put it in Base44, a browser, a mobile app, or Telegram.
6. Keep `PAPER_MODE=true`. Set `ENABLE_ALPHA_SIGNALS=true` for guarded Alpha alerts.

## Telegram cutover

A Telegram bot token can have only one reliable `getUpdates` consumer. When v6 is ready:

1. Stop v5.51.
2. Start v6.
3. Check Railway `/health`.
4. Send `/status`, then `/scan` to the bot.
5. If v6 fails startup, stop it before restarting v5.51.

Using a separate temporary Telegram bot for the first week is even safer because it lets v5.51 remain available for non-trading subscription commands without competing pollers.

## Expected behavior

- Empty candidate lists are normal.
- The bot does not send an entry on the first pump candle.
- `PUMP/DUMP RISK BLOCK` means the setup was rejected, not that a rug was proven.
- Only one paper trade can be open globally.
- A symbol that loses is blocked for three hours by default.
- New entries stop after two losses in the same Dubai day, at the daily/weekly limits, or when BTC is not in the strict bullish regime.
- `/pause` stops new candidates/signals but continues to monitor the open paper trade.
- `/priority` restores the ranked colored setup board.
- Alpha QUALIFIED is a watch state; Alpha IGNITION is a manual-entry alert after a second on-chain risk check.
- `POSSIBLE RUG` means material contract/concentration risk remains. `BLOCKED` means no Alpha entry is issued.

## First evaluation

Do not change thresholds during the first 100 closed trades. Changing them after every loss makes the sample unusable. At 100 trades, export `nexio_trades` and compare:

- net expectancy in R;
- profit factor after fees/slippage;
- maximum drawdown;
- MFE and MAE;
- results by BTC regime and hour;
- manipulation exits versus normal stops;
- performance of the first 50 trades versus the next 50.

If the next 50 deteriorate, the edge did not generalize. Keep it in paper mode.
