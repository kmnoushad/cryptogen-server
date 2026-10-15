"""Static configuration. Overridable via environment variables. No secrets."""
import os
from dataclasses import dataclass, field

ARCHIVE_BASE = os.environ.get("GHR_ARCHIVE_BASE", "https://data.binance.vision")
# The S3 bucket behind data.binance.vision. Its XML listing includes symbols that
# no longer trade, unlike exchangeInfo (Binance's own helper script uses
# exchangeInfo, which silently builds survivorship bias into the universe).
LISTING_BASE = os.environ.get(
    "GHR_LISTING_BASE", "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision")
FAPI_BASE = os.environ.get("GHR_FAPI_BASE", "https://fapi.binance.com")

# Archive dataset names under data/futures/um/monthly/
DATASETS = ("klines", "markPriceKlines", "premiumIndexKlines")


def _months(env, default):
    return tuple(m.strip() for m in os.environ.get(env, default).split(",") if m.strip())


@dataclass
class Settings:
    root: str = os.environ.get("GHR_ROOT", "/srv/nexio-research/golden-hour")
    interval: str = "1m"
    # Downloader halts (does not delete anything) below this much free disk.
    min_free_gb: float = float(os.environ.get("GHR_MIN_FREE_GB", "15"))
    # Pacing. The archive is a CDN; REST shares IP weight with the live workers.
    archive_delay_s: float = float(os.environ.get("GHR_ARCHIVE_DELAY_S", "0.25"))
    rest_delay_s: float = float(os.environ.get("GHR_REST_DELAY_S", "2.0"))
    timeout_s: float = 60.0
    retries: int = 5
    quote_assets: tuple = ("USDT",)
    # Downloaded, but analysis readers refuse these until explicitly unlocked.
    holdout_months: tuple = field(
        default_factory=lambda: _months("GHR_HOLDOUT_MONTHS", "2026-07,2026-08,2026-09"))
    # Already inspected by earlier NEXIO research (4 Oct 2026 entry rebuild).
    seen_months: tuple = field(default_factory=lambda: _months("GHR_SEEN_MONTHS", "2026-09"))

    @property
    def data_dir(self):
        return os.path.join(self.root, "data")

    @property
    def manifest_path(self):
        return os.path.join(self.root, "manifest.sqlite")

    @property
    def holdout_lock_path(self):
        return os.path.join(self.root, "HOLDOUT.lock.json")
