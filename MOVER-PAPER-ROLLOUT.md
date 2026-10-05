# NEXIO 6.9.48 mover paper accounts

This overlay adds two **virtual-only** accounts to the alert service:

- `FUTURES_TRENDING_MOVER`: opens on the existing confirmed, deduplicated `[FUTURES] TRENDING MOVER` event; virtual $100 start, 2x max margin model, at most $200 notional, structural stop from recent closed 1m lows (fallback 1.5%), 1.5R modeled-net target, four-hour time exit.
- `ALPHA_FAST_MOVER`: opens on the existing security-screened, deduplicated `[ALPHA] FAST MOVER` event; separate virtual $100 start, at most $100 notional, stop distance half the detected move clamped to 1–10%, 1.5R modeled-net target, one-hour time exit.

Both ledgers cap modeled risk at $10 per entry and reserve no more than $30/day of realized loss plus open stop risk (Dubai day). There is no trade-count cap. Fees and slippage are assumptions from config, not observed fills. Stops can gap and actual market fills/liquidity are not simulated exactly. These figures are an experiment, not a claim of profitability. Existing live Fade/Futures execution code is untouched.

The paper journal uses the existing unique `nexio_events.event_key` table; there is no SQL migration. On startup, the alert service replays the journal. If the journal is unavailable, paper entries fail closed, and `/moverpaperstats` reports the problem. `/paperstats` remains the separate legacy $100 experiment.

Alpha source data is still a polling endpoint, not a websocket. The default interval is reduced from 90s to 30s (configurable no faster than 15s); HTTP 418/429 replies trigger exponential backoff up to 10 minutes. Futures trending already receives Binance's live mini-ticker websocket and marks virtual positions from that feed.

## Tests

Run `npm test` in the project root before merging. This patch was tested with Node 22 against all 46 test files: 46 passed, 0 failed.

## Deployment note

Apply the overlay to a clean checkout of the Railway alert-service branch, run tests, commit, merge, and let Railway deploy it. Do not restart `nexio-fade` or `nexio-futures`: those AWS services execute different strategies and this patch contains no exchange-order code. Confirm Railway startup reports mover paper READY, then use `/moverpaperstats` and `/status`.
