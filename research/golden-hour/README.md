# NEXIO Golden Hour — Phase 2 historical data pipeline

Research only. This module imports no production NEXIO code, reads no API keys,
places no orders and restarts no service. It runs as its own system user
(`nexio-research`) from `/srv/nexio-research`, and the run wrapper makes
`/opt/nexio` and the worker environment files inaccessible to it.

## What it collects (12 complete months: 2025-10 → 2026-09)

| Dataset | Source | Scope |
|---|---|---|
| 1m klines (OHLC, volume, quote volume, trade count, taker-buy volume) | data.binance.vision monthly archives | every USDT perpetual listed in the archive that month |
| 1m mark-price klines | archive | same |
| 1m premium-index klines | archive | same |
| Funding history | `/fapi/v1/fundingRate` (public REST) | same |

5m/15m bars are derived later from 1m, not downloaded, so all timeframes agree.
Trade-level data (aggTrades) is out of scope here; it is fetched later only for
detected event windows. Historical spread/order-book data is not collected here;
its archive coverage must be verified separately and modeled conservatively.

## Bias and integrity guards

- **Survivorship:** the universe comes from the archive's S3 listing, which keeps
  delisted contracts. Binance's own helper script uses current `exchangeInfo` and
  would silently drop them. `exchangeInfo` is used only to annotate.
- **Integrity:** every zip is checked against its published SHA-256. Mismatches,
  conflicting duplicate rows, misaligned timestamps or rows outside the month mark
  the file `invalid`; nothing is written and it is retried on the next run.
- **No invented data:** absent archives are recorded `missing`; gaps are counted
  (count, total minutes, longest) and never filled.
- **Holdout:** 2026-07, 2026-08 and 2026-09 are downloaded and then sealed with
  per-file SHA-256 (`seal`). Analysis must read through `holdout.read_klines`, which
  refuses those months unless `GHR_HOLDOUT_UNLOCK=ONE-SHOT-FINAL-EVALUATION` is set,
  verifies the seal, and logs every access.
- **Already-seen data:** September 2026 overlaps the 4 Oct entry-rebuild research
  (39 symbols, different models). It stays in the holdout but is flagged. October
  2026, once its monthly archive is published, is the first fully fresh month and
  should be added to the holdout.

## Server safety (2 vCPU burstable, 1.9 GiB RAM)

Each command runs as a transient systemd unit with `MemoryMax=600M`, no swap,
`CPUQuota=50%`, `Nice=19` and idle IO priority, so it cannot starve `nexio-fade`
or `nexio-futures` or drain the instance's CPU burst credits. One symbol-month
(~43k rows) is held in memory at a time. A single-instance lock prevents two jobs
running at once. The downloader stops (deletes nothing) below 15 GB free disk.
REST requests are paced at one every 2 s because they share the server's IP with
the live workers; an HTTP 418 ban stops the job immediately without retrying.

Every command is resumable: stop it at any time and rerun; finished files are skipped.

## Install and pilot

```bash
# once (touches nothing under /opt/nexio)
sudo sh deploy/install.sh research/golden-hour-phase2
cd /srv/nexio-research/code/research/golden-hour

sudo ./deploy/run.sh universe                     # index symbols, incl. delisted
journalctl -u nexio-research -f                   # watch; Ctrl-C to stop watching
sudo ./deploy/run.sh download --months 2026-04    # PILOT: one month, all symbols, klines only
sudo ./deploy/run.sh report                       # measured size + 12-month extrapolation
```

Review the pilot report (symbol count, delisted count, invalid files, gaps, size
extrapolation) before running the full year:

```bash
sudo ./deploy/run.sh download --months 2025-10:2026-09 --datasets klines,markPriceKlines,premiumIndexKlines
sudo ./deploy/run.sh funding --months 2025-10:2026-09
sudo ./deploy/run.sh report
sudo ./deploy/run.sh seal
```

Stop safely at any time: `sudo systemctl stop nexio-research`.

## Tests

```bash
python3 -m unittest discover -s tests -v
```

17 offline tests cover checksum rejection, gap/duplicate accounting, microsecond
timestamps, missing archives, disk guard, delisted-symbol retention, holdout
locking/tamper detection, funding pagination and 429/418 handling. They prove
the plumbing behaves as specified; they say nothing about any trading edge.

## Not yet verified against the live archive

The S3 listing endpoint, archive coverage for delisted symbols, and the funding
endpoint's behaviour for long-delisted contracts were exercised only with
simulated responses. The pilot run is the verification step; `universe` fails
loudly if the listing returns no symbols.
