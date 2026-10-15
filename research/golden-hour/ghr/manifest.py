"""SQLite manifest: makes every job resumable, idempotent and auditable.

Missing data is recorded explicitly, never filled or invented.
"""
import sqlite3
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS files(
  dataset TEXT, symbol TEXT, interval TEXT, month TEXT,
  status TEXT,                 -- ok | missing | invalid | error
  sha256 TEXT, rows INTEGER, expected_rows INTEGER,
  gaps INTEGER, missing_minutes INTEGER, longest_gap_min INTEGER,
  duplicates INTEGER, bad_ohlc INTEGER, zero_volume_min INTEGER,
  first_ms INTEGER, last_ms INTEGER,
  bytes_zip INTEGER, bytes_parquet INTEGER, path TEXT,
  detail TEXT, updated_at REAL,
  PRIMARY KEY(dataset, symbol, interval, month));
CREATE TABLE IF NOT EXISTS symbols(
  symbol TEXT PRIMARY KEY,
  in_archive INTEGER, trading_now INTEGER,
  first_month TEXT, last_month TEXT,
  onboard_ms INTEGER, contract_type TEXT, status_now TEXT,
  updated_at REAL);
CREATE TABLE IF NOT EXISTS funding(
  symbol TEXT PRIMARY KEY, status TEXT, rows INTEGER,
  first_ms INTEGER, last_ms INTEGER, path TEXT, detail TEXT, updated_at REAL);
"""


class Manifest:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.executescript(SCHEMA)

    def close(self):
        self.db.close()

    def done(self, dataset, symbol, interval, month):
        r = self.db.execute(
            "SELECT status FROM files WHERE dataset=? AND symbol=? AND interval=? AND month=?",
            (dataset, symbol, interval, month)).fetchone()
        # 'invalid' and 'error' are retried on the next run; ok/missing are final.
        return r is not None and r[0] in ("ok", "missing")

    def _upsert(self, table, key_cols, row):
        row = dict(row, updated_at=time.time())
        cols = list(row)
        updates = ",".join(f"{c}=excluded.{c}" for c in cols if c not in key_cols)
        self.db.execute(
            f"INSERT INTO {table}({','.join(cols)}) VALUES({','.join('?' * len(cols))}) "
            f"ON CONFLICT({','.join(key_cols)}) DO UPDATE SET {updates}",
            [row[c] for c in cols])
        self.db.commit()

    def record(self, dataset, symbol, interval, month, status, **kw):
        self._upsert("files", ("dataset", "symbol", "interval", "month"),
                     dict(dataset=dataset, symbol=symbol, interval=interval,
                          month=month, status=status, **kw))

    def upsert_symbol(self, symbol, **kw):
        self._upsert("symbols", ("symbol",), dict(symbol=symbol, **kw))

    def record_funding(self, symbol, status, **kw):
        self._upsert("funding", ("symbol",), dict(symbol=symbol, status=status, **kw))

    def symbols(self):
        return [r[0] for r in self.db.execute(
            "SELECT symbol FROM symbols WHERE in_archive=1 ORDER BY symbol")]

    def summary(self):
        return self.db.execute(
            "SELECT dataset, status, COUNT(*), COALESCE(SUM(bytes_zip),0), "
            "COALESCE(SUM(bytes_parquet),0), COALESCE(SUM(missing_minutes),0) "
            "FROM files GROUP BY dataset, status ORDER BY dataset, status").fetchall()
