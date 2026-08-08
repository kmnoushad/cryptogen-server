# Railway cutover

## Before deployment

1. Leave the current v5.51 service running while you create the new Supabase tables.
2. Already running v6.4: no new SQL is required. Existing v6.1–v6.3 installation: run `sql/v6.4-migration.sql`. New installation: run `sql/schema.sql`.
3. Confirm there are no legacy rows in `nexio_trades`; this is a new table and must start clean.
4. Add the variables from `.env.example` to Railway. If `MAX_UNIVERSE` already exists, change it from `40` to `60`.
5. Use the Supabase **service-role** key only in Railway. Never put it in Base44, a browser, a mobile app, or Telegram.
6. Keep `PAPER_MODE=true`. Set `ENABLE_ALPHA_SIGNALS=true` for guarded Alpha alerts.
7. Keep the existing `FINNHUB_KEY`. `ENABLE_ECONOMIC_CALENDAR=true` is the default. The calendar does not start trades or block them.

## Telegram cutover

A Telegram bot token can have only one reliable `getUpdates` consumer. When v6 is ready:

1. Stop v5.51.
2. Start v6.
3. Check Railway `/health`.
4. Send `/version`, `/status`, `/events`, `/diagnostics`, then `/scan` to the bot. `/version` must report `v6.5.0`.
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
- While paused, Alpha runs monitor-only scans for issued entries; it cannot create a new IGNITION.
- Futures WATCH/ARMED/RETESTED and Alpha QUALIFIED states are internal and silent.
- Alpha IGNITION is sent only after a second on-chain risk check passes the configured risk ceiling.
- Futures candidates remain active for 24 minutes and survive the five-minute universe rotation.
- `/diagnostics` shows the most common internal Futures gates without sending rejected setups as alerts.
- The first persisted 24-hour diagnostic window appears after 15 minutes.
- `/audit` compares only database-monitored Futures and Alpha outcomes; old Alpha alerts without entries cannot be reconstructed honestly.
- Issued entries receive stop, TP, fade/liquidity, or timeout close messages. Failed outcome sends retry on the next monitoring cycle.
- Rejected futures setups, possible rugs, fake pumps and unavailable security checks are blocked silently and recorded in `nexio_events`.
- Calendar reminders run separately from trading at four hours, 60, 45, 30 and 15 minutes and at release time. `/events` shows whether Finnhub loaded successfully.

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
