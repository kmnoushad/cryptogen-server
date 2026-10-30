# Phase 1B: chart fade simulation (v6.9.72)

This is a new, separate virtual SHORT cohort. It uses public Binance Futures
prices and cannot submit Binance live or demo orders. It does not import the
live executor, exchange credentials, account state or live risk configuration.
The existing Futures Auto, Fade Auto, Gold and mover-paper rules are unchanged.

## Signals and definitions

`get_score(symbol, inputs)` records all 15 components with points, active/unknown
status and raw evidence. Each component awards its weight once per score row.
The worker requests 150 15m klines, uses only completed contiguous candles and
requires the latest expected close. It logs MA7/25/99, not just their ordering.

| Component | Points | Explicit test definition |
|---|---:|---|
| Pump gate | 0 | Current ticker and latest 15m close both >=2x the rolling 24h low. Below this, no entry. |
| MA7 cross below MA25 | +15 | A bearish cross within the last 20 closes, after a candle qualified for the pump gate. |
| MA25 rejection from below | +15 | Prior close below MA25; latest wick above MA25 and entire body below. |
| Recovery | -20 | Latest close above MA25 plus fresh MA7 cross up. Also vetoes entry. |
| Flat MA chop | -10 | MA7/25 gap <0.5%; both absolute changes <=0.1% over three bars. |
| Biggest-volume bar red | +10 | Largest base-volume bar among the last 20 is red. |
| Weak green bounce | +10 | At least one green bar after the largest red-volume bar; all such green volumes <50% of that red bar. |
| Green volume breakout | -15 | Latest green close above the prior five highs, volume above largest red bar. |
| MACD bearish divergence | +15 | Higher price high and lower MACD at two 2-left/2-right confirmed pivots, at least three bars apart, within 40 bars; newest pivot <=10 bars old. |
| MACD cross down | +10 | Fresh MACD(12,26,9) cross below signal with both lines above zero. |
| Histogram shrink | +5 | Three positive histogram bars decrease while three closes increase. |
| Upper wick | +10 | One of last three bars has upper wick >50% of range and high within 2% of last-20 high. |
| Monitoring | +10 | Only an explicit fresh official-page tag or reviewed daily snapshot. Half-size cap. |
| 180d downtrend | +10 | Latest complete daily close down >70% vs close exactly 180 daily intervals earlier. Requires 181 contiguous complete daily bars; fetch limit 182. |
| New listing | +5 | Futures contract onboardDate <30 days old. Half-size cap. This is contract listing age, not necessarily the token's age on Spot. |

Insufficient 180-day data is unknown, not a 70% decline. Missing listing metadata
is unknown. Monitoring/listing flags are research hypotheses, not proof a token
will fall. Values are not tuned or claimed profitable.

## Entry, sizing and exits

- Default research threshold **50 points** (`--min-score` overrides it).
- Score alone never enters: latest closed 15m candle must be red and close below
  both preceding candle lows; recovery condition must be false.
- Stop is above the latest confirmed swing high within 20 bars, with a 0.1%
  buffer; fallback is the highest high in the last ten bars. Skip a stop >8%
  away, including after adverse entry slippage. Skip an entry moved >0.5% since
  the signal close or bid/ask spread >0.2%.
- Independent **$100 virtual cash**, <=1% equity/$1 modeled risk per attempt,
  max three simulated positions, max $150 notional each and 50% virtual margin
  allocation at modeled 2x. Monitoring/new-listing/unknown risk metadata caps
  risk and notional at 0.5x; multiple flags do not compound to 0.25x.
- One simulated entry per symbol per six hours from the prior entry, persisted
  through restarts. Repeated polling cannot re-enter the same score candle.
- Explicit test exit defaults, because none were supplied: fixed stop, **1.5R
  modeled net target**, four-hour maximum hold. No trailing or partial close is
  added to this research cohort.
- Entry uses a current public bid with 5bps adverse slippage; exit uses ask or
  historical candle prices with 5bps adverse slippage. Fees are 5bps each side.
  Funding is **not modeled** and is marked in reports, so reported net is not
  fully funding-adjusted. Gap-through stops may exceed modeled risk.
- Between polls, completed 1m bars replay exits after the entry minute; stop
  wins when stop and target touch the same bar. Pre-entry portions of a candle
  are excluded. Current ask quotes also mark/close positions. First partial
  minute excursions between polls are not reconstructible; this is not tick
  execution proof. Missing exit history prevents new entries instead of
  inventing an exit. No exchange minimum/step fill realism is claimed.

## Monitoring tag daily cache

The label belongs to Spot/Margin; it is not supplied by futures exchangeInfo.
The separate worker checks the official English Monitoring market page at most
once every 24 hours and caches the result in `monitoring-auto.json`. The website
is not a versioned API. Only explicit per-token `Monitoring` tags in embedded
JSON are accepted, and parsed lists prove positives only. If schema, network or
pagination is unavailable, affected flags stay **unknown**, receive zero points
and use half sizing. A menu label, old announcement or absent token never proves
a current flag or its absence. The checker may therefore remain unknown on
Binance's deployed page schema; it has not been validated on a running server.

For complete known-positive/negative metadata, maintain a reviewed `monitoring.json`
in the paper data directory, with fresh numeric UTC-millisecond `checkedAt`,
`complete:true`, a `symbols` array of exact futures baseAsset codes, and a `sources`
array of official HTTPS binance.com URLs. It expires after 24 hours. Do not infer
1000-prefixed contract/Spot mappings. No hardcoded current Monitoring list ships
with this patch.

Official references:
- https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data
- https://www.binance.com/en/markets/coinInfo-Monitoring
- https://www.binance.com/en/academy/glossary/monitoring-tag

## Run and report

From the checked-out source on Linux with Node >=20, installed dependencies and
`flock` available:

```sh
npm run start:fade-chart-paper -- --data-dir /absolute/separate/paper-directory
```

`--once` performs one paper cycle. The CLI acquires a kernel file lock so a second
instance cannot write the same ledger. Do not run the underlying class concurrently
without that lock. No credential or exchange environment file is required.
Kline requests are sequential, the 180d cache refreshes daily, scan duration is
bounded to three minutes and 429/418 responses back off. Scores run after :03
at the first poll of each new 15m interval. Open paper positions are checked each
15-second cycle. This sidecar has its own public-data traffic; combined server
IP request limits still apply. Do not activate it blindly on a saturated host.

`deploy/nexio-fade-chart-paper.service` is an optional separate systemd service
using existing `nexio` user, no EnvironmentFile, and a dedicated StateDirectory.
Confirm the Node path, permissions and host capacity before installation. No
service was installed, started, or enabled by this PR.

For Telegram visibility, set only in the main scanner's environment:

```text
FADE_CHART_PAPER_STATUS_FILE=/var/lib/nexio-fade-chart-paper/state.json
```

Then `/fadechartpaper` reads that research status. The path does not launch a
worker. The scanner needs read access to the separate state directory.

To print an offline report without any public data calls:

```sh
node scripts/fade-chart-paper.js --paper --data-dir /absolute/separate/paper-directory --report
```

Daily JSONL files log SCORE (all components), ENTRY_CHECK, OPEN, CLOSE and ERROR.
The durable state retains each trade's entry score, fees and outcome. The report
groups closed trades by each component's true/false/unknown state with trade
count, wins and net PnL. These are descriptive associations in selected trades,
not an ablation test or causal evidence that a component helps. Rejected scores
remain available for future counterfactual replay. Keep the full paper directory
for the review; do not delete state to reset a losing run.
