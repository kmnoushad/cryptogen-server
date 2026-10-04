# Sudden-spike Fade detection prototype

This is a tick-based detector, not a deployed strategy. Existing live workers do not import it. Every output has `allowed:false` and `executable:false`; a research candidate has a separate `candidate:true` flag.

Unlike the old scanner, it does not require an 8% daily gain, two failed highs, or a closed-minute confirmation. Feed Binance aggregate trades with event time, aggregate trade ID and aggressor side. Provide an independently refreshed BTC context and executable bid/ask. The caller must provide an exchange-verified symbol allowlist and reset the detector whenever a stream disconnects. No trade stream or AWS service is connected by this change.

Frozen experimental thresholds:

1. Warm up with 140 seconds of continuous trades; a gap over five seconds resets the pattern. Duplicate and out-of-order events are ignored. Per-symbol storage is bounded.
2. Flag a WATCH on a 2% rise within 30 seconds and at least three times baseline quote flow. This does not short a rising spike.
3. A short research candidate requires a 0.5–0.9% retreat from its observed high, at least two seconds without a new high, and 60% sell-aggressor share over five seconds with at least three trades.
4. Expire the watch after 45 seconds. Retreats beyond 0.9% are rejected rather than chased.
5. BTC data must be no older than two seconds: 15-minute return must be nonpositive and 30-second return no greater than 0.1%. These are provisional context rules, not evidence of fraud or of a profitable short.
6. Book data must be no older than one second with spread no greater than 0.1%. Model the structural stop 0.1% above the spike high; do not widen it to consume $5. Retain the 25% modeled-cost ceiling and executable-quote no-chase check.

`maxModeledLossUsd:5` is candidate metadata only. It does not size an order or modify the production 0.5%-equity risk policy. A future planner must use the smaller of the approved equity risk and $5, reserve costs/slippage, round to exchange filters and skip exchange-minimum failures. Gaps can exceed any modeled loss. Keep native stop placement, lease fencing, position reconciliation, risk caps, funding/OI/event and account controls when connecting a validated detector.

No historical tick/book dataset is available in the saved one-minute candle exports. Those candles cannot establish this detector's profitability, latency or intraminute event order. Four focused tests and the full 460-test JavaScript suite pass. They check state transitions and guards, not an edge. Before a live route, record prospective aggregate trades, executable quotes, BTC snapshots and every watch/rejection; replay immutable data with fees, delay and adverse fills. Keep skipped patterns in the report.
