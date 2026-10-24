# v6.9.71: retain the structural stop until +1R net

Previously, volatility trailing could replace a momentum job's structural stop
on the entry management pass. Only the explicit break-even rule waited for +1R.
For example, a SHORT at 1.000 with a structural stop of 1.0315 and 5m ATR of
0.005 could immediately replace its stop with about 1.010.

Momentum jobs now retain their current native stop until observed modeled net
profit reaches the immutable original plannedLossUsd (1R). Modeled net includes
the executor's fee and exit-slippage assumptions; it is not realized profit.
At that threshold, momentumTrailArmed is saved in the existing job state. After
arming, the existing 2x 5m ATR trail and cost-adjusted break-even floor remain
active even if current modeled profit drops below 1R or the process restarts.
Stops never widen. Previously tightened stops are retained during migration;
older jobs without the latch must observe +1R before further ATR tightening.

Initial structural stop placement, position sizing, per-trade/aggregate modeled
risk, entry gates, native stop coverage checks, emergency exits and four-hour
maximum holding time are unchanged. This update does not move SHORT stops to
the original pump peak, change ATR multipliers or implement the 48-hour engine.
Waiting for +1R can surrender a small unrealized gain that the prior early trail
would have protected. It does not guarantee fewer losses or higher profitability.

Focused tests cover both directions below/at the threshold, tiny ATR, restart
persistence, subsequent pullbacks, ATR expansion and previously tightened stops.
Executor tests assert that initial native stops survive the first pass and a
restart before +1R, then tighten and persist the latch after the threshold.
All exchange operations in tests are mocked. Deployment is not performed by
this source change; current server behavior must be verified separately.
