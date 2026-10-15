"""Historical USD-M symbol universe, including delisted contracts.

Primary source: the archive's S3 listing (contains symbols that stopped trading).
Secondary: current exchangeInfo, used only to annotate (onboard date, type,
current status). A symbol is never dropped because it is absent today.
"""
import json
import re
import time
import urllib.parse
import xml.etree.ElementTree as ET

from . import net
from .config import FAPI_BASE, LISTING_BASE

S3_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"
MONTH_RE = re.compile(r"-(\d{4}-\d{2})\.zip$")


def list_prefix(prefix, fetch=net.get, delimiter="/"):
    """Yield (common_prefixes, keys) pages for an S3 prefix, following markers."""
    marker = ""
    while True:
        q = {"delimiter": delimiter, "prefix": prefix}
        if marker:
            q["marker"] = marker
        root = ET.fromstring(fetch(f"{LISTING_BASE}?{urllib.parse.urlencode(q)}"))
        prefixes = [e.findtext(f"{S3_NS}Prefix") for e in root.iter(f"{S3_NS}CommonPrefixes")]
        keys = [e.findtext(f"{S3_NS}Key") for e in root.iter(f"{S3_NS}Contents")]
        yield prefixes, keys
        if root.findtext(f"{S3_NS}IsTruncated") != "true":
            return
        marker = root.findtext(f"{S3_NS}NextMarker") or (keys[-1] if keys else prefixes[-1])


def archive_symbols(fetch=net.get):
    base = "data/futures/um/monthly/klines/"
    out = []
    for prefixes, _ in list_prefix(base, fetch):
        out += [p[len(base):].strip("/") for p in prefixes]
    return sorted(set(out))


def archive_months(symbol, interval="1m", dataset="klines", fetch=net.get):
    prefix = f"data/futures/um/monthly/{dataset}/{symbol}/{interval}/"
    months = set()
    for _, keys in list_prefix(prefix, fetch):
        for k in keys:
            m = MONTH_RE.search(k)
            if m and not k.endswith(".CHECKSUM"):
                months.add(m.group(1))
    return sorted(months)


def eligible(symbol, quote_assets=("USDT",)):
    # Perpetuals only: delivery contracts carry an expiry suffix like _260327.
    return "_" not in symbol and any(symbol.endswith(q) for q in quote_assets)


def exchange_info(fetch=net.get):
    data = json.loads(fetch(f"{FAPI_BASE}/fapi/v1/exchangeInfo"))
    return {s["symbol"]: s for s in data.get("symbols", [])}


def build(manifest, settings, fetch=net.get, log=print, sleep=time.sleep):
    """Populate the symbols table. Fails loudly if the archive listing is empty."""
    syms = [s for s in archive_symbols(fetch) if eligible(s, settings.quote_assets)]
    if not syms:
        raise RuntimeError("archive listing returned no eligible symbols; refusing to continue")
    try:
        info = exchange_info(fetch)
    except Exception as e:  # annotation only; never blocks the archive universe
        log(f"exchangeInfo unavailable ({e!r}); continuing without annotations")
        info = {}
    for i, s in enumerate(syms, 1):
        months = archive_months(s, settings.interval, fetch=fetch)
        meta = info.get(s, {})
        manifest.upsert_symbol(
            s, in_archive=1,
            trading_now=int(meta.get("status") == "TRADING"),
            first_month=months[0] if months else None,
            last_month=months[-1] if months else None,
            onboard_ms=meta.get("onboardDate"),
            contract_type=meta.get("contractType") or meta.get("underlyingType"),
            status_now=meta.get("status", "NOT_IN_EXCHANGEINFO"))
        if i % 50 == 0:
            log(f"universe: {i}/{len(syms)} symbols indexed")
        sleep(settings.archive_delay_s)
    log(f"universe: {len(syms)} eligible symbols "
        f"({sum(1 for s in syms if info.get(s, {}).get('status') != 'TRADING')} not trading today)")
    return syms
