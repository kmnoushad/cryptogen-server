"""Historical funding rates from /fapi/v1/fundingRate (public, no key).

This endpoint shares the server's IP with the live workers, so it is paced
slowly and a 418 ban stops the whole job immediately.
"""
import json
import os
import time
import urllib.error
import urllib.parse

import pyarrow as pa
import pyarrow.parquet as pq

from . import net
from .config import FAPI_BASE


def fetch_symbol(manifest, settings, symbol, start_ms, end_ms, fetch=net.get,
                 log=print, sleep=time.sleep):
    rows, cursor = [], start_ms
    while cursor < end_ms:
        q = urllib.parse.urlencode(dict(symbol=symbol, startTime=cursor, endTime=end_ms, limit=1000))
        try:
            page = json.loads(fetch(f"{FAPI_BASE}/fapi/v1/fundingRate?{q}",
                                    timeout=settings.timeout_s, retries=settings.retries, log=log))
        except urllib.error.HTTPError as e:
            if e.code == 400:  # typically "Invalid symbol" for long-delisted contracts
                manifest.record_funding(symbol, "unavailable", detail=f"HTTP 400 from fundingRate")
                return "unavailable"
            raise
        sleep(settings.rest_delay_s)
        if not page:
            break
        rows += page
        nxt = int(page[-1]["fundingTime"]) + 1
        if nxt <= cursor or len(page) < 1000:
            break
        cursor = nxt
    if not rows:
        manifest.record_funding(symbol, "unavailable", rows=0, detail="no funding rows in range")
        return "unavailable"
    seen, t, r, mp = set(), [], [], []
    for x in sorted(rows, key=lambda x: int(x["fundingTime"])):
        ft = int(x["fundingTime"])
        if ft in seen:
            continue
        seen.add(ft)
        t.append(ft)
        r.append(float(x["fundingRate"]))
        mp.append(float(x["markPrice"]) if x.get("markPrice") not in (None, "") else None)
    path = os.path.join(settings.data_dir, "funding", f"{symbol}.parquet")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tbl = pa.table({"funding_time": pa.array(t, pa.int64()),
                    "funding_rate": pa.array(r, pa.float64()),
                    "mark_price": pa.array(mp, pa.float64())})
    pq.write_table(tbl, path + ".tmp", compression="zstd")
    os.replace(path + ".tmp", path)
    manifest.record_funding(symbol, "ok", rows=len(t), first_ms=t[0], last_ms=t[-1], path=path)
    return "ok"
