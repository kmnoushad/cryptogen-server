"""Minimal HTTP GET with retry/backoff. Honors 429 Retry-After. stdlib only."""
import time
import urllib.error
import urllib.request

UA = "nexio-golden-hour-research/0.1"


class NotFound(Exception):
    pass


class Banned(Exception):
    """HTTP 418 = IP ban. Stop the whole job: the live workers share this IP."""


def get(url, timeout=60.0, retries=5, log=print, sleep=time.sleep):
    delay = 2.0
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise NotFound(url) from None
            if e.code == 418:
                raise Banned(url) from None
            if (e.code == 429 or e.code >= 500) and attempt < retries:
                wait = float(e.headers.get("Retry-After") or delay)
                log(f"HTTP {e.code} on {url}; waiting {wait:.0f}s")
                sleep(wait)
                delay = min(delay * 2, 300)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == retries:
                raise
            log(f"network error {e!r}; retry in {delay:.0f}s")
            sleep(delay)
            delay = min(delay * 2, 300)
    raise RuntimeError(f"gave up after {retries} retries: {url}")
