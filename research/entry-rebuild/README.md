# Entry-model rebuild — 4 October 2026

Research code only. These models are not imported by a live worker and every
returned candidate has `executable: false`. No strategy approval or live deployment
follows from this PR. Current live configuration was not changed by this research.

## Fixed models

1. **pullback5:** symbol 15-minute trend, BTC context must not oppose it,
   local five-minute EMA20/EMA50 trend, an EMA20 pullback and separate recovery.
   Structural stop from the last three five-minute bars plus 0.1 ATR.
2. **compression5:** symbol/context trend and a six-bar compression followed
   by a closed five-minute range breakout with 1.5x volume and directional flow.
   Entry may be at most 0.3 ATR beyond the level. Structural compression stop.
3. **auctionFade5:** rolling 24-hour gain >=8%, quote volume >=$15m and top20
   within the included sample; local rise >=5%; fresh failed high with an upper
   wick, weak buying and volume. In bullish BTC, require relative weakness.
   Stop is the rejected high plus 0.1 ATR; no widening to fit quantity.

All use the current 25% modeled-cost ceiling, maximum 2.5% structural width,
no-chase checks at modeled fill, next-minute entry, 1.5R target, +1R break-even
and four-hour holding limit. These are fixed hypotheses, not a parameter search.

## Outcome

39 complete symbols, 14 evaluation days plus one warmup day. PORTALUSDT's
local file was truncated and excluded; the replay records the exclusion.
This history has already been inspected. Temporal partitions are **reused
validation**, not an untouched holdout.

| Model | Base trades | Win rate | Net expectancy | Decision |
|---|---:|---:|---:|---|
| Five-minute pullback | 115 | 26.1% | -0.174R | Reject |
| Compression breakout | 36 | 44.4% | +0.003R | Reject: validation negative, delay stress -0.214R |
| Failed-high auction Fade | 0 | N/A | N/A | Insufficient eligible setups; not evidence of an edge |

The compression headline is effectively flat. Its validation segment is
-0.251R over eight trades and the later reused segment is -0.068R over nine.
Entry slippage and delay scenarios reapply entry checks, so accepted subsets
differ: a positive stressed subset is not proof of robustness. No model passed.

`summary.json` preserves all nine scenarios and rejection counts. Net and drawdown
are independent risk units, not account dollars. This is not a portfolio replay.
Historical funding/OI/events, exchange book/spread, lot-size minima, account-wide
margin/concurrency, actual stop fills and unlisted coins are not represented.
Targets are assumed filled on touch; ambiguous stop/target bars take the stop first.
Break-even changes take effect on the next minute.

## Reproduce

Node >=20, Python >=3.10 and numpy are required. Use a separate Python environment.

```bash
node scripts/replay-entry-rebuild.js /path/to/nexio-continuous-data /tmp/entry-rebuild
python3 scripts/evaluate-entry-rebuild.py --data /path/to/nexio-continuous-data --signals /tmp/entry-rebuild/entry-signals.json --out /tmp/entry-rebuild/entry-results.json
node --test test/research-entry-models.test.js
python3 -m unittest discover -s test -p test_entry_rebuild_engine.py
```

## Required before a replacement is considered for live

Freeze any further hypothesis before reviewing fresh data. Evaluate it on unseen
history and forward paper with realized fees, funding and quote timing, then run
portfolio constraints and exchange protection/restart drills. A 65% win-rate
target alone does not establish positive net expectancy. Do not route these
research candidates into either live executor.
