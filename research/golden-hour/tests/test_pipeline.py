"""Offline tests. They prove plumbing and guards, not any trading edge."""
import hashlib
import io
import json
import os
import tempfile
import threading
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

import pyarrow.parquet as pq

from ghr import cli, funding, holdout, klines, net, universe
from ghr.config import Settings
from ghr.manifest import Manifest

NS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"'
APR = "2026-04"
APR_START = 1775001600000  # 2026-04-01T00:00:00Z


def kline_csv(times, header=True, scale=1, override=None):
    lines = ["open_time,open,high,low,close,volume,close_time,quote_volume,count,"
             "taker_buy_volume,taker_buy_quote_volume,ignore"] if header else []
    for t in times:
        o, h, l, c, v = (override or {}).get(t, (1.0, 1.1, 0.9, 1.05, 10.0))
        lines.append(f"{t*scale},{o},{h},{l},{c},{v},{(t+59999)*scale},{v*c},5,4,{4*c},0")
    return ("\n".join(lines) + "\n").encode()


def make_zip(name, payload):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(name.replace(".zip", ".csv"), payload)
    blob = buf.getvalue()
    return blob, f"{hashlib.sha256(blob).hexdigest()}  {name}\n".encode()


class FakeArchive:
    """URL -> bytes. Missing URLs raise NotFound like the real CDN."""

    def __init__(self):
        self.files = {}

    def add_month(self, symbol, month, payload, dataset="klines", bad_checksum=False):
        url, name = klines.archive_url(dataset, symbol, "1m", month)
        blob, chk = make_zip(name, payload)
        if bad_checksum:
            chk = b"0" * 64 + f"  {name}\n".encode()
        self.files[url], self.files[url + ".CHECKSUM"] = blob, chk

    def __call__(self, url, **kw):
        if url in self.files:
            return self.files[url]
        raise net.NotFound(url)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.st = Settings(root=self.tmp.name, min_free_gb=0, archive_delay_s=0, rest_delay_s=0)
        os.makedirs(self.st.data_dir, exist_ok=True)
        self.mf = Manifest(self.st.manifest_path)
        self.log = lambda *_: None

    def tearDown(self):
        self.mf.close()
        self.tmp.cleanup()


class TestKlines(Base):
    def test_ok_roundtrip_then_skip(self):
        arc = FakeArchive()
        times = [APR_START + i * 60000 for i in range(30 * 1440)]
        arc.add_month("XUSDT", APR, kline_csv(times))
        self.assertEqual(klines.fetch_month(self.mf, self.st, "klines", "XUSDT", APR, fetch=arc, log=self.log), "ok")
        row = self.mf.db.execute("SELECT rows, expected_rows, gaps, path FROM files").fetchone()
        self.assertEqual(row[:3], (43200, 43200, 0))
        t = pq.read_table(row[3])
        self.assertEqual(t.num_rows, 43200)
        self.assertEqual(t.column("open_time")[0].as_py(), APR_START)
        self.assertEqual(klines.fetch_month(self.mf, self.st, "klines", "XUSDT", APR, fetch=arc, log=self.log), "skip")

    def test_gaps_duplicates_microseconds_headerless(self):
        arc = FakeArchive()
        times = [APR_START + i * 60000 for i in range(100) if i not in (10, 11, 12, 50)]
        times.append(times[5])  # identical duplicate
        arc.add_month("YUSDT", APR, kline_csv(times, header=False, scale=1000))
        self.assertEqual(klines.fetch_month(self.mf, self.st, "klines", "YUSDT", APR, fetch=arc, log=self.log), "ok")
        r = self.mf.db.execute("SELECT rows, gaps, missing_minutes, longest_gap_min, duplicates FROM files").fetchone()
        self.assertEqual(r, (96, 2, 4, 3, 1))

    def test_conflicting_duplicate_is_invalid_and_not_written(self):
        arc = FakeArchive()
        t0 = APR_START
        payload = kline_csv([t0, t0 + 60000]) + kline_csv([t0], header=False, override={t0: (2, 2.2, 1.9, 2.1, 9)})
        arc.add_month("ZUSDT", APR, payload)
        self.assertEqual(klines.fetch_month(self.mf, self.st, "klines", "ZUSDT", APR, fetch=arc, log=self.log), "invalid")
        self.assertFalse(os.path.exists(os.path.join(self.st.data_dir, "klines", "1m", "ZUSDT", f"{APR}.parquet")))
        self.assertFalse(self.mf.done("klines", "ZUSDT", "1m", APR))  # retried next run

    def test_bad_checksum_rejected(self):
        arc = FakeArchive()
        arc.add_month("XUSDT", APR, kline_csv([APR_START]), bad_checksum=True)
        self.assertEqual(klines.fetch_month(self.mf, self.st, "klines", "XUSDT", APR, fetch=arc, log=self.log), "invalid")
        self.assertIn("sha256 mismatch", self.mf.db.execute("SELECT detail FROM files").fetchone()[0])

    def test_missing_archive_recorded_not_invented(self):
        self.assertEqual(klines.fetch_month(self.mf, self.st, "klines", "GONEUSDT", APR,
                                            fetch=FakeArchive(), log=self.log), "missing")
        self.assertTrue(self.mf.done("klines", "GONEUSDT", "1m", APR))

    def test_rows_outside_month_rejected(self):
        arc = FakeArchive()
        arc.add_month("XUSDT", APR, kline_csv([APR_START - 60000, APR_START]))
        self.assertEqual(klines.fetch_month(self.mf, self.st, "klines", "XUSDT", APR, fetch=arc, log=self.log), "invalid")

    def test_mark_price_stores_ohlc_only(self):
        arc = FakeArchive()
        arc.add_month("XUSDT", APR, kline_csv([APR_START]), dataset="markPriceKlines")
        klines.fetch_month(self.mf, self.st, "markPriceKlines", "XUSDT", APR, fetch=arc, log=self.log)
        path = self.mf.db.execute("SELECT path FROM files").fetchone()[0]
        self.assertEqual(pq.read_table(path).column_names, ["open_time", "open", "high", "low", "close"])

    def test_disk_guard(self):
        self.st.min_free_gb = 10**9
        with self.assertRaises(klines.DiskGuard):
            klines.fetch_month(self.mf, self.st, "klines", "XUSDT", APR, fetch=FakeArchive(), log=self.log)


class TestUniverse(Base):
    def test_listing_keeps_delisted_and_filters(self):
        base = "data/futures/um/monthly/klines/"
        page1 = f"""<ListBucketResult {NS}><IsTruncated>true</IsTruncated><NextMarker>{base}B</NextMarker>
          <CommonPrefixes><Prefix>{base}AUSDT/</Prefix></CommonPrefixes>
          <CommonPrefixes><Prefix>{base}BTCUSDT_260327/</Prefix></CommonPrefixes></ListBucketResult>"""
        page2 = f"""<ListBucketResult {NS}><IsTruncated>false</IsTruncated>
          <CommonPrefixes><Prefix>{base}DEADUSDT/</Prefix></CommonPrefixes>
          <CommonPrefixes><Prefix>{base}ETHUSDC/</Prefix></CommonPrefixes></ListBucketResult>"""

        def months_xml(sym, ms):
            keys = "".join(f"<Contents><Key>{base}{sym}/1m/{sym}-1m-{m}.zip</Key></Contents>"
                           f"<Contents><Key>{base}{sym}/1m/{sym}-1m-{m}.zip.CHECKSUM</Key></Contents>" for m in ms)
            return f"<ListBucketResult {NS}><IsTruncated>false</IsTruncated>{keys}</ListBucketResult>"

        def fetch(url, **kw):
            if "exchangeInfo" in url:
                return json.dumps({"symbols": [{"symbol": "AUSDT", "status": "TRADING",
                                                "onboardDate": 1, "contractType": "PERPETUAL"}]}).encode()
            if "AUSDT%2F1m" in url:
                return months_xml("AUSDT", ["2025-11", "2026-04"]).encode()
            if "DEADUSDT%2F1m" in url:
                return months_xml("DEADUSDT", ["2025-10"]).encode()
            return (page2 if "marker=" in url else page1).encode()

        syms = universe.build(self.mf, self.st, fetch=fetch, log=self.log, sleep=lambda _: None)
        self.assertEqual(syms, ["AUSDT", "DEADUSDT"])
        rows = dict((r[0], r[1:]) for r in self.mf.db.execute(
            "SELECT symbol, trading_now, first_month, last_month, status_now FROM symbols"))
        self.assertEqual(rows["AUSDT"], (1, "2025-11", "2026-04", "TRADING"))
        self.assertEqual(rows["DEADUSDT"], (0, "2025-10", "2025-10", "NOT_IN_EXCHANGEINFO"))

    def test_empty_listing_fails_loudly(self):
        empty = f"<ListBucketResult {NS}><IsTruncated>false</IsTruncated></ListBucketResult>".encode()
        with self.assertRaises(RuntimeError):
            universe.build(self.mf, self.st, fetch=lambda u, **k: empty, log=self.log)


class TestHoldout(Base):
    def test_locked_unlock_logged_and_tamper_detected(self):
        arc = FakeArchive()
        arc.add_month("XUSDT", "2026-08", kline_csv([1785542400000]))  # 2026-08-01
        klines.fetch_month(self.mf, self.st, "klines", "XUSDT", "2026-08", fetch=arc, log=self.log)
        self.assertEqual(holdout.seal(self.st, self.mf), 1)
        with self.assertRaises(holdout.HoldoutLocked):
            holdout.read_klines(self.st, "XUSDT", ["2026-08"], purpose="peek")
        with mock.patch.dict(os.environ, {"GHR_HOLDOUT_UNLOCK": holdout.UNLOCK_PHRASE}):
            self.assertEqual(len(holdout.read_klines(self.st, "XUSDT", ["2026-08"], purpose="final")), 1)
            self.assertTrue(os.path.exists(os.path.join(self.st.root, "holdout_access.log")))
            path = self.mf.db.execute("SELECT path FROM files").fetchone()[0]
            with open(path, "ab") as f:
                f.write(b"x")
            with self.assertRaises(RuntimeError):
                holdout.read_klines(self.st, "XUSDT", ["2026-08"], purpose="final")

    def test_development_months_readable(self):
        arc = FakeArchive()
        arc.add_month("XUSDT", APR, kline_csv([APR_START]))
        klines.fetch_month(self.mf, self.st, "klines", "XUSDT", APR, fetch=arc, log=self.log)
        self.assertEqual(len(holdout.read_klines(self.st, "XUSDT", [APR], purpose="dev")), 1)


class TestFunding(Base):
    def test_paginates_and_dedupes(self):
        calls = []

        def fetch(url, **kw):
            calls.append(url)
            if len(calls) == 1:
                return json.dumps([{"fundingTime": 1000 + i * 8, "fundingRate": "0.0001",
                                    "markPrice": ""} for i in range(1000)]).encode()
            return json.dumps([{"fundingTime": 1000 + 999 * 8, "fundingRate": "0.0001", "markPrice": "1"},
                               {"fundingTime": 99999, "fundingRate": "-0.002", "markPrice": "2"}]).encode()

        st = funding.fetch_symbol(self.mf, self.st, "XUSDT", 0, 10**6, fetch=fetch,
                                  log=self.log, sleep=lambda _: None)
        self.assertEqual(st, "ok")
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.mf.db.execute("SELECT rows FROM funding").fetchone()[0], 1001)


class TestNet(unittest.TestCase):
    def serve(self, codes):
        seq = list(codes)

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                code = seq.pop(0) if seq else 200
                self.send_response(code)
                if code == 429:
                    self.send_header("Retry-After", "0")
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *a):
                pass

        srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        return f"http://127.0.0.1:{srv.server_port}/x"

    def test_retry_after_429(self):
        self.assertEqual(net.get(self.serve([429, 200]), log=lambda *_: None, sleep=lambda _: None), b"ok")

    def test_418_stops(self):
        with self.assertRaises(net.Banned):
            net.get(self.serve([418]), log=lambda *_: None, sleep=lambda _: None)

    def test_404(self):
        with self.assertRaises(net.NotFound):
            net.get(self.serve([404]))


class TestCli(unittest.TestCase):
    def test_month_range(self):
        self.assertEqual(cli.month_range("2025-11:2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"])
        self.assertEqual(len(cli.month_range("2025-10:2026-09")), 12)


if __name__ == "__main__":
    unittest.main()
