# Regime-specific hypotheses — 4 October 2026

Two additional hypotheses were implemented after the first three were rejected.
This is five cumulative models on reused history, not five independent validation
attempts. Neither additional model is imported by a live worker. Every output has
`allowed:false`, `executable:false`; a research candidate is recorded separately.

## Range reversion

BTC's last 61 closed one-minute prices and the symbol's previous 24 closed
five-minute prices must each have directional efficiency <=0.20. Efficiency is
absolute endpoint change divided by total absolute price travel, not a prediction.
A closed five-minute failed excursion outside the two-hour range needs directional
taker flow. The stop is beyond the excursion wick with 0.1 five-minute ATR buffer.
The prior range's volume-weighted centre must allow at least 1.5R after modeled
fees and slippage. Stops are never shifted to meet this reward check.

## Failed-reclaim Fade

Keep the rolling prior-pump/volume and sampled top20 selection. Require three
distinct closed minutes: rejected high, failed reclaim within 0.15% of resistance,
and a subsequent weak-buying close below the retest low. Entry must remain within
0.5 five-minute ATR of resistance. BTC closed-minute shocks reject a candidate;
strongly trending-up BTC needs symbol relative weakness. This is not the production
ten-second shock guard and historical funding/OI/event data is absent.

Both hypotheses use the same 25% cost ceiling, 2.5% maximum structural width,
next-minute modeled fills, no-chase checks, 1.5R net target, +1R break-even and
four-hour holding window. They were not loosened after reviewing results.

## Results

Same 39 complete sampled symbols and reused 14-day history; PORTALUSDT excluded.

| Hypothesis | Base trades | Outcome | Extra slippage / one-minute delay |
|---|---:|---|---|
| Range reversion | 0 | No eligible executable-width/reward entries | 0 / 0 |
| Failed-reclaim Fade | 1 | Break-even, 0R under the model | 0 / 0 |

The range replay had 105 setups rejected for insufficient reward to the centre
and four for the cost ceiling, in addition to earlier regime and pattern rejections.
This establishes neither a profitable range model nor that range strategies in
general cannot work. One break-even Fade is insufficient evidence for an edge.
The results require no change to live execution rules.

456 local JavaScript tests and three Python accounting tests passed. Implementation
tests establish causality, input validation, mirrored directions and accounting;
they do not establish trading success. All independent-risk and dataset limitations
in README.md still apply. Exact counts and exclusions are in regime-replay.json;
six modeled execution scenarios are in regime-summary.json.

```bash
node scripts/replay-regime-rebuild.js /path/to/nexio-continuous-data /tmp/regime-rebuild
python3 scripts/evaluate-entry-rebuild.py --data /path/to/nexio-continuous-data --signals /tmp/regime-rebuild/regime-signals.json --models rangeReversion5,failedReclaimFade1 --out /tmp/regime-rebuild/regime-results.json
node --test test/regime-entry-models.test.js
```

No candidate in this PR has passed live acceptance. New hypotheses must be declared
and tested prospectively on fresh data; continuing to search the same history until
one result is positive would increase selection bias rather than establish an edge.
