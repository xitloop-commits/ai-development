"""TCS2 - Dhan's historical API, used for CHECKING rather than as a source.

Spec: docs/systems/14_tcs2.md  (D32, D33, D34, D43)

D33 dropped backfill: Dhan's history is not a data source. TCS2 records every
contract from its first day, so the gap closes by itself, and the history's
quality is doubtful - T189 found its daily OI reading **3,889,340 identical on
two consecutive days** while our own recording moved 6,604,520 -> 8,520,590.

It is kept for two jobs where it is the only thing that can answer:

  1. **Checking** our own numbers. Used that way it corrected our OI cadence
     figure (D32) and found the closing-OI problem below.
  2. **The official closing OI** (D34). The exchange revises OI after the close
     and the feed's last value is not the official one - crude 9500 CE read
     6,678 against an official 5,643, out by **15.5%**.

**It rate-limits.** Rapid calls return HTTP 429; ~1.3 s between calls ran clean
(D32c). The throttle is built in rather than left to each caller, because a
backfill that silently loses contracts to 429s is the T185 failure with a
different cause.
"""
from __future__ import annotations

import datetime as dt
import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

DAILY_URL = "https://api.dhan.co/v2/charts/historical"
INTRADAY_URL = "https://api.dhan.co/v2/charts/intraday"

# Measured 2026-09-24: rapid calls return 429, ~1.3 s apart ran clean.
MIN_INTERVAL_SEC = 1.3
MAX_RETRIES = 4
TIMEOUT_SEC = 45.0


class HistoryError(RuntimeError):
    pass


@dataclass
class HistoryStats:
    calls: int = 0
    rate_limited: int = 0
    failures: int = 0
    empty: int = 0
    seconds_waiting: float = 0.0
    errors: list[str] = field(default_factory=list)


@dataclass
class Candle:
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: int
    oi: int


class DhanHistory:
    """Throttled client for Dhan's candle endpoints."""

    def __init__(self, access_token: str, client_id: str,
                 min_interval_sec: float = MIN_INTERVAL_SEC) -> None:
        self._token = access_token
        self._client_id = str(client_id)
        self.min_interval_sec = min_interval_sec
        self.stats = HistoryStats()
        self._last_call = 0.0

    # -- transport -------------------------------------------------------

    def _throttle(self) -> None:
        gap = time.time() - self._last_call
        if gap < self.min_interval_sec:
            wait = self.min_interval_sec - gap
            self.stats.seconds_waiting += wait
            time.sleep(wait)

    def _post(self, url: str, body: dict) -> dict:
        for attempt in range(MAX_RETRIES):
            self._throttle()
            req = urllib.request.Request(
                url, data=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json",
                         "access-token": self._token,
                         "client-id": self._client_id})
            try:
                self.stats.calls += 1
                with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as r:
                    self._last_call = time.time()
                    return json.loads(r.read())
            except urllib.error.HTTPError as exc:
                self._last_call = time.time()
                if exc.code == 429:
                    self.stats.rate_limited += 1
                    # Back off progressively. Giving up on a 429 would drop a
                    # contract silently, which is the failure mode this client
                    # exists to avoid.
                    time.sleep(self.min_interval_sec * (attempt + 2))
                    continue
                self.stats.failures += 1
                self.stats.errors.append(f"HTTP {exc.code} {url}")
                raise HistoryError(f"HTTP {exc.code}") from exc
            except (urllib.error.URLError, TimeoutError) as exc:
                self._last_call = time.time()
                self.stats.failures += 1
                self.stats.errors.append(f"{type(exc).__name__}: {exc}"[:120])
                if attempt == MAX_RETRIES - 1:
                    raise HistoryError(str(exc)) from exc
                time.sleep(self.min_interval_sec * (attempt + 1))
        raise HistoryError("rate limited past every retry")

    # -- candles ---------------------------------------------------------

    @staticmethod
    def _to_candles(payload: dict) -> list[Candle]:
        ts = payload.get("timestamp") or []
        oi = payload.get("open_interest") or payload.get("openInterest") or []
        o = payload.get("open") or []
        h = payload.get("high") or []
        lo = payload.get("low") or []
        c = payload.get("close") or []
        v = payload.get("volume") or []

        def at(seq, i, default=0):
            return seq[i] if i < len(seq) else default

        out = []
        for i, t in enumerate(ts):
            out.append(Candle(
                date=dt.datetime.fromtimestamp(t).date().isoformat(),
                open=float(at(o, i, 0.0)), high=float(at(h, i, 0.0)),
                low=float(at(lo, i, 0.0)), close=float(at(c, i, 0.0)),
                volume=int(at(v, i, 0)), oi=int(at(oi, i, 0))))
        return out

    def daily(self, security_id: str, segment: str, instrument: str,
              from_date: str, to_date: str) -> list[Candle]:
        """Daily candles with open interest.

        This is the endpoint that carries the **official** closing OI (D34), and
        also the one T189 found repeating a value across two days - so a caller
        must sanity-check what comes back rather than trust it.
        """
        payload = self._post(DAILY_URL, {
            "securityId": str(security_id), "exchangeSegment": segment,
            "instrument": instrument, "oi": True,
            "fromDate": from_date, "toDate": to_date})
        candles = self._to_candles(payload)
        if not candles:
            self.stats.empty += 1
        return candles

    def intraday(self, security_id: str, segment: str, instrument: str,
                 date: str, interval: str = "1") -> list[Candle]:
        """Minute candles with OI, for one day.

        Used for checking rather than for storage: this is how the OI cadence in
        D32 was measured, after our own recordings suggested one change every 3.2
        minutes and Dhan showed roughly one per minute.
        """
        payload = self._post(INTRADAY_URL, {
            "securityId": str(security_id), "exchangeSegment": segment,
            "instrument": instrument, "interval": interval, "oi": True,
            "fromDate": date, "toDate": date})
        candles = self._to_candles(payload)
        if not candles:
            self.stats.empty += 1
        return candles

    def official_oi(self, security_id: str, segment: str, instrument: str,
                    trade_date: str, window_days: int = 7) -> int | None:
        """The exchange's revised closing OI for one contract on one day.

        **A window is requested, not a single day.** Measured 2026-09-25: Dhan
        returns HTTP 400 for `fromDate == toDate`, whether that day is today or a
        settled day in the past. Asking 2026-09-18 -> 2026-09-25 returned four
        candles; asking 2026-09-23 -> 2026-09-23 was rejected outright.

        Returns None when Dhan has no candle for that date, which happens in two
        different situations and **must never be mistaken for an OI of zero**:
          * the day has not been published yet - measured on 2026-09-25, the most
            recent daily candle was 2026-09-23, so a day's official figure is not
            available immediately after its own close
          * the contract is an old expiry - a 2026-06-16 contract returned no
            candles at all
        """
        d = dt.date.fromisoformat(trade_date)
        lo = (d - dt.timedelta(days=window_days)).isoformat()
        hi = (d + dt.timedelta(days=1)).isoformat()
        for c in self.daily(security_id, segment, instrument, lo, hi):
            if c.date == trade_date:
                return c.oi
        return None

    def latest_published_day(self, security_id: str, segment: str,
                             instrument: str, window_days: int = 10
                             ) -> str | None:
        """The most recent day Dhan has a daily candle for.

        Worth checking before starting a correction pass: if the target day is
        not published yet, an 88-minute run would return `missing` for every leg.
        """
        today = dt.date.today()
        lo = (today - dt.timedelta(days=window_days)).isoformat()
        hi = (today + dt.timedelta(days=1)).isoformat()
        candles = self.daily(security_id, segment, instrument, lo, hi)
        return candles[-1].date if candles else None


def estimate_runtime(n_contracts: int,
                     min_interval_sec: float = MIN_INTERVAL_SEC) -> float:
    """Seconds a correction pass over `n_contracts` will take.

    Worth calling before starting one: at 1.3 s a call, 4,060 legs is about 88
    minutes, which is why D34 made this a post-session job rather than something
    the 08:54 startup waits for.
    """
    return n_contracts * min_interval_sec
