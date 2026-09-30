# Futures auto execution staging

The existing Futures engine emits LONG-only setup signals into `nexio_trades`.
That table enforces LONG direction and a single global open trade. Its paper
results do not validate a live long/short strategy. The fade worker uses a
dedicated Binance Futures subaccount and refuses unmanaged positions/orders.

The new Futures executor must use a different subaccount/API key and its own
runtime, lease, control, order IDs, and ledger. It must not consume the existing
paper account, overwrite fade ownership, or change Railway alerts and Alpha.

The planning policy in `src/futures-auto-policy.js` is intentionally inert. It
models at most five open positions, isolated 2x leverage, at most $150 notional
per trade, a $5 net whole-position target, and a planned stop loss capped by
the lower of $5 and 1% of verified equity. Aggregate modeled open loss is capped
at 3% equity, margin use at 50% equity. Exchange quantity/min-notional filters
may make a trade impossible at a small balance. Gaps, fees, funding and fills
can make realized outcomes worse than the model.

Before any live switch, implement and verify: a distinct SHORT setup and
closed-bar out-of-sample outcomes; native reduce-only stops and targets for
both directions; ambiguous-order recovery by client ID; lease fencing and
restart reconciliation; daily realized loss lock; manual-position isolation;
testnet entry, stop, take-profit, restart and outage drills. This staging
change sends no Binance orders and does not enable execution.
