"""Golden Hour research data CLI.

  python -m ghr.cli universe                       # index symbols incl. delisted
  python -m ghr.cli download --months 2026-04      # pilot: one month, all symbols
  python -m ghr.cli report                         # sizes, gaps, extrapolation
  python -m ghr.cli download --months 2025-10:2026-09 --datasets klines,markPriceKlines,premiumIndexKlines
  python -m ghr.cli funding --months 2025-10:2026-09
  python -m ghr.cli seal                           # hash-lock the holdout months

Safe to interrupt at any point and rerun: completed files are skipped.
"""
import argparse
import fcntl
import os
import sys
import time

from . import VERSION, funding, holdout, klines, net, universe
from .config import DATASETS, Settings
from .manifest import Manifest


def log(msg):
    print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg, flush=True)


def month_range(spec):
    if ":" not in spec:
        return [m.strip() for m in spec.split(",") if m.strip()]
    a, b = spec.split(":")
    y, m = map(int, a.split("-"))
    out = []
    while f"{y:04d}-{m:02d}" <= b:
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def single_instance(root):
    f = open(os.path.join(root, ".lock"), "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit("another ghr job is running; refusing to start a second one")
    return f


def in_life(row_first, row_last, month):
    return row_first is not None and row_first <= month <= (row_last or month)


def cmd_download(mf, st, args):
    months = month_range(args.months)
    datasets = args.datasets.split(",")
    for d in datasets:
        if d not in DATASETS:
            sys.exit(f"unknown dataset {d}; choose from {DATASETS}")
    syms = mf.db.execute(
        "SELECT symbol, first_month, last_month FROM symbols WHERE in_archive=1 ORDER BY symbol").fetchall()
    if not syms:
        sys.exit("symbol table empty: run `universe` first")
    if args.symbols:
        wanted = set(args.symbols.split(","))
        syms = [s for s in syms if s[0] in wanted]
    counts = {}
    for d in datasets:
        for m in months:
            todo = [s for s, a, b in syms if in_life(a, b, m)]
            log(f"{d} {m}: {len(todo)} symbols listed in archive that month")
            for i, s in enumerate(todo, 1):
                status = klines.fetch_month(mf, st, d, s, m, log=log)
                counts[status] = counts.get(status, 0) + 1
                if status != "skip":
                    time.sleep(st.archive_delay_s)
                if i % 100 == 0:
                    log(f"  {i}/{len(todo)} {counts}")
    log(f"download finished: {counts}")


def cmd_funding(mf, st, args):
    months = month_range(args.months)
    start, _ = klines.month_bounds_ms(months[0])
    _, end = klines.month_bounds_ms(months[-1])
    syms = mf.db.execute(
        "SELECT symbol, first_month, last_month FROM symbols WHERE in_archive=1 ORDER BY symbol").fetchall()
    done = {r[0] for r in mf.db.execute("SELECT symbol FROM funding WHERE status IN ('ok','unavailable')")}
    todo = [s for s, a, b in syms if s not in done and a and a <= months[-1] and (b or a) >= months[0]]
    log(f"funding: {len(todo)} symbols to fetch at {st.rest_delay_s}s pacing")
    for i, s in enumerate(todo, 1):
        funding.fetch_symbol(mf, st, s, start, end, log=log)
        if i % 50 == 0:
            log(f"  funding {i}/{len(todo)}")


def cmd_report(mf, st, args):
    log(f"ghr {VERSION}  root={st.root}")
    n_sym, n_dead = mf.db.execute(
        "SELECT COUNT(*), SUM(trading_now=0) FROM symbols WHERE in_archive=1").fetchone()
    log(f"symbols: {n_sym} in archive, {n_dead or 0} not trading today (kept: survivorship guard)")
    print(f"{'dataset':20} {'status':8} {'files':>6} {'zip MB':>9} {'parquet MB':>11} {'missing min':>12}")
    for d, s, n, bz, bp, miss in mf.summary():
        print(f"{d:20} {s:8} {n:6d} {bz/1e6:9.1f} {bp/1e6:11.1f} {miss:12d}")
    for d, n, avg in mf.db.execute(
            "SELECT dataset, COUNT(*), AVG(bytes_parquet) FROM files WHERE status='ok' GROUP BY dataset"):
        # Extrapolate to 12 months using symbol-months actually listed in the archive.
        sm = 0
        for a, b in mf.db.execute("SELECT first_month, last_month FROM symbols WHERE in_archive=1"):
            sm += sum(1 for m in month_range(args.months) if in_life(a, b, m))
        log(f"extrapolation {d}: ~{sm * avg / 1e9:.2f} GB parquet for {sm} symbol-months "
            f"in {args.months} (from {n} measured files)")
    worst = mf.db.execute(
        "SELECT symbol, month, missing_minutes, longest_gap_min FROM files "
        "WHERE status='ok' AND dataset='klines' ORDER BY missing_minutes DESC LIMIT 10").fetchall()
    if worst:
        log("largest gaps (symbol, month, missing minutes, longest gap):")
        for w in worst:
            print("   ", *w)
    bad = mf.db.execute("SELECT dataset, symbol, month, detail FROM files WHERE status IN ('invalid','error')").fetchall()
    for b in bad[:20]:
        print("   INVALID", *b)
    seen = [m for m in st.seen_months]
    log(f"holdout months (locked): {','.join(st.holdout_months)}; previously inspected: {','.join(seen)}")


def main(argv=None):
    p = argparse.ArgumentParser(prog="ghr")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("universe")
    d = sub.add_parser("download")
    d.add_argument("--months", required=True)
    d.add_argument("--datasets", default="klines")
    d.add_argument("--symbols", default="")
    f = sub.add_parser("funding")
    f.add_argument("--months", required=True)
    r = sub.add_parser("report")
    r.add_argument("--months", default="2025-10:2026-09")
    sub.add_parser("seal")
    args = p.parse_args(argv)

    st = Settings()
    os.makedirs(st.data_dir, exist_ok=True)
    _lock = single_instance(st.root)
    mf = Manifest(st.manifest_path)
    try:
        if args.cmd == "universe":
            universe.build(mf, st, log=log)
        elif args.cmd == "download":
            cmd_download(mf, st, args)
        elif args.cmd == "funding":
            cmd_funding(mf, st, args)
        elif args.cmd == "report":
            cmd_report(mf, st, args)
        elif args.cmd == "seal":
            log(f"sealed {holdout.seal(st, mf)} holdout files")
    except klines.DiskGuard as e:
        log(f"STOPPED by disk guard: {e}")
        return 2
    except net.Banned as e:
        log(f"STOPPED: HTTP 418 IP ban on {e}. Do not retry; the live workers share this IP.")
        return 3
    finally:
        mf.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
