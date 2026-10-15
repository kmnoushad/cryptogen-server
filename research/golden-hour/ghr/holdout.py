"""Untouched-holdout enforcement.

Holdout months ARE downloaded (so the data exists and is checksummed), but every
analysis read goes through `read_klines`, which refuses those months until the
one-shot unlock phrase is set. Sealing records a SHA-256 of each holdout file so
any later modification is detected. Every unlocked access is appended to a log.
"""
import hashlib
import json
import os
import time

import pyarrow.parquet as pq

UNLOCK_PHRASE = "ONE-SHOT-FINAL-EVALUATION"


class HoldoutLocked(PermissionError):
    pass


def _sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def seal(settings, manifest):
    rows = manifest.db.execute(
        f"SELECT path FROM files WHERE status='ok' AND month IN "
        f"({','.join('?' * len(settings.holdout_months))})", settings.holdout_months).fetchall()
    lock = {"months": list(settings.holdout_months), "sealed_at": time.time(),
            "files": {p: _sha(p) for (p,) in rows}}
    if os.path.exists(settings.holdout_lock_path):
        with open(settings.holdout_lock_path) as f:
            old = json.load(f)
        for p, h in old["files"].items():  # sealing again never silently re-blesses edits
            if p in lock["files"] and lock["files"][p] != h:
                raise RuntimeError(f"holdout file changed since sealing: {p}")
        old["files"].update(lock["files"])
        lock = dict(old, months=sorted(set(old["months"]) | set(lock["months"])))
    tmp = settings.holdout_lock_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(lock, f, indent=1)
    os.replace(tmp, settings.holdout_lock_path)
    return len(lock["files"])


def assert_readable(settings, month, path, purpose):
    if month not in settings.holdout_months:
        return
    if os.environ.get("GHR_HOLDOUT_UNLOCK") != UNLOCK_PHRASE:
        raise HoldoutLocked(
            f"{month} is holdout. Reading it requires the one-shot unlock "
            f"after the strategy is frozen (purpose given: {purpose!r}).")
    with open(settings.holdout_lock_path) as f:
        lock = json.load(f)
    if path in lock["files"] and _sha(path) != lock["files"][path]:
        raise RuntimeError(f"holdout file modified after sealing: {path}")
    with open(os.path.join(settings.root, "holdout_access.log"), "a") as f:
        f.write(json.dumps({"t": time.time(), "month": month, "path": path,
                            "purpose": purpose}) + "\n")


def read_klines(settings, symbol, months, purpose, dataset="klines", columns=None):
    """The only sanctioned way for analysis code to read klines."""
    tables = []
    for m in months:
        path = os.path.join(settings.data_dir, dataset, settings.interval, symbol, f"{m}.parquet")
        if not os.path.exists(path):
            continue  # absence is reported by the manifest, never filled here
        assert_readable(settings, m, path, purpose)
        tables.append(pq.read_table(path, columns=columns))
    return tables
