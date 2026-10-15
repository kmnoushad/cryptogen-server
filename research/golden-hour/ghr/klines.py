"""Download one monthly archive, verify its SHA-256, validate, store as Parquet.

One symbol-month (~43k rows) is held in memory at a time. Nothing is filled,
interpolated or invented: gaps are counted and recorded in the manifest.
"""
import calendar
import csv
import hashlib
import io
import os
import shutil
import zipfile

import pyarrow as pa
import pyarrow.parquet as pq

from . import net
from .config import ARCHIVE_BASE

MINUTE = 60_000
KLINE_COLS = ("open_time", "open", "high", "low", "close", "volume", "close_time",
              "quote_volume", "trades", "taker_buy_base", "taker_buy_quote")
FLOAT_COLS = ("open", "high", "low", "close", "volume", "quote_volume",
              "taker_buy_base", "taker_buy_quote")


class DiskGuard(Exception):
    pass


def archive_url(dataset, symbol, interval, month):
    name = f"{symbol}-{interval}-{month}.zip"
    return f"{ARCHIVE_BASE}/data/futures/um/monthly/{dataset}/{symbol}/{interval}/{name}", name


def month_bounds_ms(month):
    y, m = map(int, month.split("-"))
    start = calendar.timegm((y, m, 1, 0, 0, 0)) * 1000
    days = calendar.monthrange(y, m)[1]
    return start, start + days * 1440 * MINUTE


def check_disk(root, min_free_gb):
    free = shutil.disk_usage(root).free / 1e9
    if free < min_free_gb:
        raise DiskGuard(f"only {free:.1f} GB free (< {min_free_gb} GB guard); stopping")
    return free


def verify_checksum(blob, checksum_text, name):
    parts = checksum_text.decode().split()
    if len(parts) < 1 or (len(parts) > 1 and parts[1].lstrip("*") != name):
        raise ValueError(f"unexpected CHECKSUM format: {checksum_text[:120]!r}")
    digest = hashlib.sha256(blob).hexdigest()
    if digest != parts[0].lower():
        raise ValueError(f"sha256 mismatch: got {digest}, expected {parts[0]}")
    return digest


def _to_ms(t):
    t = int(float(t))
    return t // 1000 if t > 10**14 else t  # archive moved some feeds to microseconds


def parse_csv(raw):
    """Parse a kline CSV with or without a header row. Returns dict of lists."""
    cols = {c: [] for c in KLINE_COLS}
    reader = csv.reader(io.StringIO(raw.decode()))
    for row in reader:
        if not row or not row[0].strip():
            continue
        if not row[0].strip().lstrip("-").isdigit():  # header row
            continue
        if len(row) < 11:
            raise ValueError(f"short row ({len(row)} fields): {row}")
        cols["open_time"].append(_to_ms(row[0]))
        cols["close_time"].append(_to_ms(row[6]))
        cols["trades"].append(int(float(row[8])))
        for i, c in ((1, "open"), (2, "high"), (3, "low"), (4, "close"), (5, "volume"),
                     (7, "quote_volume"), (9, "taker_buy_base"), (10, "taker_buy_quote")):
            cols[c].append(float(row[i]))
    return cols


def validate(cols, month):
    """Sort, dedupe and measure quality. Raises on irreconcilable data."""
    n = len(cols["open_time"])
    if n == 0:
        raise ValueError("empty file")
    order = sorted(range(n), key=cols["open_time"].__getitem__)
    keep, seen, dupes = [], {}, 0
    for i in order:
        t = cols["open_time"][i]
        if t % MINUTE:
            raise ValueError(f"open_time {t} not aligned to a minute")
        if t in seen:
            j = seen[t]
            if any(cols[c][i] != cols[c][j] for c in ("open", "high", "low", "close", "volume")):
                raise ValueError(f"conflicting duplicate rows at {t}")
            dupes += 1
            continue
        seen[t] = i
        keep.append(i)
    out = {c: [cols[c][i] for i in keep] for c in KLINE_COLS}

    lo, hi = month_bounds_ms(month)
    ts = out["open_time"]
    if ts[0] < lo or ts[-1] >= hi:
        raise ValueError(f"rows outside {month}: {ts[0]}..{ts[-1]}")
    gaps = missing = longest = 0
    for a, b in zip(ts, ts[1:]):
        step = (b - a) // MINUTE - 1
        if step > 0:
            gaps += 1
            missing += step
            longest = max(longest, step)
    bad = sum(1 for o, h, l, c in zip(out["open"], out["high"], out["low"], out["close"])
              if min(o, h, l, c) <= 0 or h < max(o, c) or l > min(o, c))
    zero_vol = sum(1 for v in out["volume"] if v == 0)
    stats = dict(rows=len(ts), expected_rows=(hi - lo) // MINUTE, gaps=gaps,
                 missing_minutes=missing, longest_gap_min=longest, duplicates=dupes,
                 bad_ohlc=bad, zero_volume_min=zero_vol, first_ms=ts[0], last_ms=ts[-1])
    return out, stats


def write_parquet(cols, path, ohlc_only=False):
    names = ("open_time", "open", "high", "low", "close") if ohlc_only else KLINE_COLS
    arrays = []
    for c in names:
        typ = pa.float64() if c in FLOAT_COLS else pa.int64()
        arrays.append(pa.array(cols[c], type=typ))
    table = pa.table(arrays, names=list(names))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    pq.write_table(table, tmp, compression="zstd")
    os.replace(tmp, path)  # atomic: a crash never leaves a half-written file
    return os.path.getsize(path)


def fetch_month(manifest, settings, dataset, symbol, month, fetch=net.get, log=print):
    """Idempotent: skips files already recorded ok/missing. Returns status."""
    interval = settings.interval
    if manifest.done(dataset, symbol, interval, month):
        return "skip"
    check_disk(settings.root, settings.min_free_gb)
    url, name = archive_url(dataset, symbol, interval, month)
    get = lambda u: fetch(u, timeout=settings.timeout_s, retries=settings.retries, log=log)
    try:
        blob = get(url)
    except net.NotFound:
        manifest.record(dataset, symbol, interval, month, "missing", detail="no archive file")
        return "missing"
    try:
        digest = verify_checksum(blob, get(url + ".CHECKSUM"), name)
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            csvs = [n for n in z.namelist() if n.endswith(".csv")]
            if len(csvs) != 1:
                raise ValueError(f"expected one CSV in zip, found {csvs}")
            raw = z.read(csvs[0])
        cols, stats = validate(parse_csv(raw), month)
        path = os.path.join(settings.data_dir, dataset, interval, symbol, f"{month}.parquet")
        size = write_parquet(cols, path, ohlc_only=(dataset != "klines"))
    except net.NotFound as e:
        manifest.record(dataset, symbol, interval, month, "invalid", detail=f"checksum missing: {e}")
        return "invalid"
    except (ValueError, zipfile.BadZipFile) as e:
        manifest.record(dataset, symbol, interval, month, "invalid", detail=str(e)[:500])
        log(f"INVALID {dataset} {symbol} {month}: {e}")
        return "invalid"
    manifest.record(dataset, symbol, interval, month, "ok", sha256=digest,
                    bytes_zip=len(blob), bytes_parquet=size, path=path, **stats)
    return "ok"
