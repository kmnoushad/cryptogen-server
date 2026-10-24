# NEXIO source recovery and v6.9.70 repairs

GitHub main declared v6.9.48 while the supplied AWS source snapshot declared
v6.9.67. This branch recovers that snapshot, overlays the supplied v6.9.68
structure and v6.9.69 momentum source patches, then applies the repairs below.
GitHub's existing mover-paper integration and Alpha polling/backoff are retained.
No environment files, credentials, runtime journals or archived source backups
are included. This is a proposed source baseline, not a verified server image.

## Repairs

- Terminal zero-fill entries are retired only after matching order identity,
  flat position and owned-order cleanup checks. Known-unsent/rejected intents
  receive the same flat/cleanup checks. Such attempts do not consume a momentum
  re-entry campaign; a new signal is still required and durable IDs still dedupe.
- Unverified momentum exits remain blocked even after six hours. A verified
  full owned bot close can be reconciled regardless of its close reason; exchange
  manual/unattributed exits remain blocked. Protection failures stay blocked.
- Closed outcomes are retried during reconciliation, after active protection,
  with at most one historical job per cycle and a 30-second per-job retry delay.
  Re-entry still requires matching exchange fill evidence and net-income data.
- SHORT re-entry requires a new support break, separate failed retest and renewed
  selling after the prior exit. Existing climax, lower-high, 15m breakdown,
  flow, freshness, cost, funding and account checks remain mandatory. Winning
  campaigns settle 60 seconds; losing campaigns wait ten minutes and use half
  the campaign risk ceiling. Three-entry cap and direction restrictions remain.
- Removed the duplicate initial ensureStop call and redundant momentum-position
  read. Native stop checks/replacements continue reading owned position afresh.
- Package and app version agree at 6.9.70. Test discovery explicitly targets
  test/*.test.js so archived backup directories are not executed.

## Validation

`npm run check`: 695 tests passed, including retained GitHub mover-paper tests.
The reconstructed AWS tree separately passed 691 tests. Exchange calls are mocked.
These tests establish code behavior, not profitability, live throughput or fills.

## Outstanding server and strategy work

No AWS login/session is available in this thread. The actual installed hashes,
worker heartbeat, pause state, Binance protection and execution behavior have not
been inspected. This branch is not merged or deployed. Review the source recovery
diff before treating it as the deployment baseline; preserve server-owned state.

The requested 48-hour compression/OI, +3%/60s breakout and staged Fibonacci/base
exit engine is NOT implemented by these repairs. v6.9.69's closed-bar momentum
strategy remains: 80-minute base, deep scans of 24 ranked symbols, no fixed TP,
native stop plus ATR trailing. Its thresholds and entry/exit policy must not be
described as the requested dual-phase system. A 48-hour OI history feed and causal
tick/volume capture, dedicated strategy implementation and validation are still
needed. Gold/MT5 and movie modules were not modified.
