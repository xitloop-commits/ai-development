"""Raw-tick → per-minute market picture for one session day.

Reads the four nifty50 raw files for a date and produces:
  - 1-minute futures OHLC candles → Heikin-Ashi + SMA5 (candles.py math inline)
  - per-minute futures microstructure (depth, volume deltas, buy/sell totals)
  - per-minute option quotes (bid/ask/ltp) for strikes near the day's spot range
  - per-minute chain context (spot, ATM IV, OI tilt) and VIX

Everything is aligned on the candle grid: index i = i-th minute of the session
(09:15 + i). All monetary labels downstream use REAL prices from here; the
Heikin-Ashi candles are for decisions only (spec §3 HA caution).
"""
from __future__ import annotations

import gzip
import json
import re
from dataclasses import dataclass, field

import numpy as np

from .config import (
    IST_OFFSET_SEC,
    QUOTE_STALENESS_SEC,
    RAW_ROOT,
    SESSION_END_MIN,
    SESSION_START_MIN,
    SMA_PERIOD,
    STRIKE_STEP,
)

N_CANDLES = SESSION_END_MIN - SESSION_START_MIN  # 375 one-minute candles


def _minute_index(recv_ts: float) -> int:
    """Session candle index for a UTC epoch timestamp (IST minutes)."""
    ist_min = int((recv_ts + IST_OFFSET_SEC) // 60) % 1440
    return ist_min - SESSION_START_MIN


@dataclass
class DayData:
    date: str
    # Candle grid arrays, length N_CANDLES; NaN where no data.
    o: np.ndarray
    h: np.ndarray
    l: np.ndarray
    c: np.ndarray
    ha_o: np.ndarray
    ha_c: np.ndarray
    ha_h: np.ndarray
    ha_l: np.ndarray
    sma: np.ndarray
    candle_end_ts: np.ndarray            # UTC epoch of each candle close
    # Per-minute futures microstructure (sampled at candle close).
    atp: np.ndarray                      # exchange VWAP
    vol_cum: np.ndarray                  # cumulative day volume
    buy_cum: np.ndarray                  # cumulative buyer qty
    sell_cum: np.ndarray                 # cumulative seller qty
    depth_imb: np.ndarray                # (Σbid−Σask)/(Σbid+Σask), 5 levels
    spread: np.ndarray                   # ask − bid
    tick_count: np.ndarray               # futures ticks in the minute
    # Context (sampled at candle close).
    spot: np.ndarray
    atm_iv: np.ndarray
    oi_call: np.ndarray                  # ATM±3 call OI sum
    oi_put: np.ndarray                   # ATM±3 put OI sum
    doi_call: np.ndarray                 # ATM±3 call OI-change sum
    doi_put: np.ndarray
    vix: np.ndarray
    # Option quotes at candle close: {(strike, "CE"|"PE"): (bid, ask, ltp) arrays}
    opt_bid: dict = field(default_factory=dict)
    opt_ask: dict = field(default_factory=dict)
    opt_ltp: dict = field(default_factory=dict)
    expiry: str = ""

    def valid_candles(self) -> np.ndarray:
        return ~np.isnan(self.c)

    def side(self) -> np.ndarray:
        """+1 candle closed above SMA5, −1 below, 0 no data yet."""
        s = np.zeros(N_CANDLES, dtype=np.int8)
        ok = ~np.isnan(self.ha_c) & ~np.isnan(self.sma)
        s[ok & (self.ha_c > self.sma)] = 1
        s[ok & (self.ha_c <= self.sma)] = -1
        return s

    def atm_strike(self, i: int) -> float:
        sp = self.spot[i]
        if np.isnan(sp):
            return np.nan
        return round(sp / STRIKE_STEP) * STRIKE_STEP

    def quote(self, strike: float, opt_type: str, i: int):
        """(bid, ask) at candle close i, or None if missing/stale/zero."""
        key = (int(strike), opt_type)
        if key not in self.opt_bid:
            return None
        bid = self.opt_bid[key][i]
        ask = self.opt_ask[key][i]
        if np.isnan(bid) or np.isnan(ask) or bid <= 0 or ask <= 0:
            return None
        return float(bid), float(ask)


def load_day(date: str, raw_root=None) -> DayData | None:
    """Build the aligned per-minute picture for one date. None if files absent."""
    root = (raw_root or RAW_ROOT) / date
    fu = root / "nifty50_underlying_ticks.ndjson.gz"
    fo = root / "nifty50_option_ticks.ndjson.gz"
    fc = root / "nifty50_chain_snapshots.ndjson.gz"
    fv = root / "nifty50_vix_ticks.ndjson.gz"
    if not (fu.exists() and fo.exists() and fc.exists()):
        return None

    n = N_CANDLES
    nan = lambda: np.full(n, np.nan)
    day = DayData(
        date=date,
        o=nan(), h=nan(), l=nan(), c=nan(),
        ha_o=nan(), ha_c=nan(), ha_h=nan(), ha_l=nan(),
        sma=nan(), candle_end_ts=nan(),
        atp=nan(), vol_cum=nan(), buy_cum=nan(), sell_cum=nan(),
        depth_imb=nan(), spread=nan(), tick_count=np.zeros(n),
        spot=nan(), atm_iv=nan(),
        oi_call=nan(), oi_put=nan(), doi_call=nan(), doi_put=nan(),
        vix=nan(),
    )

    # ── 1. Chain snapshots first: spot series + strike→security map ────────
    sec_to_leg: dict[str, tuple[int, str]] = {}
    chain_rows_last: dict[int, dict] = {}
    spot_events: list[tuple[float, float]] = []
    chain_by_minute: dict[int, dict] = {}
    with gzip.open(fc, "rt", encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = rec.get("recv_ts")
            sp = rec.get("spotPrice")
            if not ts or not sp:
                continue
            day.expiry = rec.get("expiry") or day.expiry
            spot_events.append((ts, sp))
            i = _minute_index(ts)
            rows = rec.get("rows") or []
            for r in rows:
                k = r.get("strike")
                if k is None:
                    continue
                if r.get("callSecurityId"):
                    sec_to_leg[str(r["callSecurityId"])] = (int(k), "CE")
                if r.get("putSecurityId"):
                    sec_to_leg[str(r["putSecurityId"])] = (int(k), "PE")
            if 0 <= i < n:
                chain_by_minute[i] = rec  # keep last snapshot of the minute

    if not spot_events:
        return None
    spot_events.sort()
    spot_ts = np.array([t for t, _ in spot_events])
    spot_px = np.array([p for _, p in spot_events])

    # Day's spot range → strikes worth keeping (±4 strikes beyond extremes).
    lo = np.floor(spot_px.min() / STRIKE_STEP) * STRIKE_STEP - 4 * STRIKE_STEP
    hi = np.ceil(spot_px.max() / STRIKE_STEP) * STRIKE_STEP + 4 * STRIKE_STEP
    wanted_ids = {
        sid for sid, (k, _t) in sec_to_leg.items() if lo <= k <= hi
    }
    for sid in wanted_ids:
        key = sec_to_leg[sid]
        day.opt_bid[key] = np.full(n, np.nan)
        day.opt_ask[key] = np.full(n, np.nan)
        day.opt_ltp[key] = np.full(n, np.nan)

    # ── 2. Futures ticks → candles + microstructure ────────────────────────
    last_state: dict[int, tuple] = {}
    with gzip.open(fu, "rt", encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = rec.get("recv_ts")
            ltp = rec.get("ltp") or 0.0
            if not ts or ltp <= 0:
                continue
            i = _minute_index(ts)
            if not (0 <= i < n):
                continue
            if np.isnan(day.o[i]):
                day.o[i] = ltp
                day.h[i] = ltp
                day.l[i] = ltp
            day.h[i] = max(day.h[i], ltp)
            day.l[i] = min(day.l[i], ltp)
            day.c[i] = ltp
            day.tick_count[i] += 1
            depth = rec.get("depth") or []
            bq = sum(d.get("bid_qty", 0) for d in depth)
            aq = sum(d.get("ask_qty", 0) for d in depth)
            imb = (bq - aq) / (bq + aq) if (bq + aq) > 0 else 0.0
            bid, ask = rec.get("bid") or 0.0, rec.get("ask") or 0.0
            last_state[i] = (
                rec.get("atp"), rec.get("volume"), rec.get("total_buy"),
                rec.get("total_sell"), imb,
                (ask - bid) if (bid > 0 and ask > 0) else np.nan, ts,
            )
    for i, (atp, vol, tb, tsell, imb, spr, ts) in last_state.items():
        day.atp[i] = atp if atp else np.nan
        day.vol_cum[i] = vol if vol is not None else np.nan
        day.buy_cum[i] = tb if tb is not None else np.nan
        day.sell_cum[i] = tsell if tsell is not None else np.nan
        day.depth_imb[i] = imb
        day.spread[i] = spr
        day.candle_end_ts[i] = ts

    # Forward-fill close for tickless minutes (rare), then HA + SMA.
    _ffill_ohlc(day)
    _heikin_ashi(day)
    _sma(day)

    # ── 3. Spot / chain context on the candle grid ─────────────────────────
    for i in range(n):
        t_end = day.candle_end_ts[i]
        if np.isnan(t_end):
            continue
        j = np.searchsorted(spot_ts, t_end, side="right") - 1
        if j >= 0 and t_end - spot_ts[j] <= QUOTE_STALENESS_SEC:
            day.spot[i] = spot_px[j]
    _fill_chain_context(day, chain_by_minute)

    # ── 4. Option ticks (prefiltered) → per-minute quotes ──────────────────
    if wanted_ids:
        pat = re.compile(
            r'"security_id": "(%s)"' % "|".join(sorted(wanted_ids))
        )
        cur: dict[tuple, tuple] = {}
        boundary = np.full(n, np.nan)  # last processed minute per key not needed; do per-tick write
        with gzip.open(fo, "rt", encoding="utf-8") as f:
            for line in f:
                m = pat.search(line)
                if not m:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = rec.get("recv_ts")
                if not ts:
                    continue
                i = _minute_index(ts)
                if not (0 <= i < n):
                    continue
                key = sec_to_leg.get(str(rec.get("security_id")))
                if key is None or key not in day.opt_bid:
                    continue
                bid, ask = rec.get("bid") or 0.0, rec.get("ask") or 0.0
                ltp = rec.get("ltp") or 0.0
                if bid > 0 and ask > 0:
                    day.opt_bid[key][i] = bid
                    day.opt_ask[key][i] = ask
                if ltp > 0:
                    day.opt_ltp[key][i] = ltp
        # Ffill quotes ≤2 minutes so a quiet minute doesn't lose the strike.
        for key in day.opt_bid:
            _ffill_limited(day.opt_bid[key], 2)
            _ffill_limited(day.opt_ask[key], 2)
            _ffill_limited(day.opt_ltp[key], 2)

    # ── 5. VIX ─────────────────────────────────────────────────────────────
    if fv.exists():
        with gzip.open(fv, "rt", encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = rec.get("recv_ts")
                ltp = rec.get("ltp") or 0.0
                if not ts or ltp <= 0:
                    continue
                i = _minute_index(ts)
                if 0 <= i < n:
                    day.vix[i] = ltp
        _ffill_limited(day.vix, 5)

    return day


def _ffill_ohlc(day: DayData) -> None:
    prev_close = np.nan
    prev_ts = np.nan
    for i in range(N_CANDLES):
        if np.isnan(day.c[i]):
            if not np.isnan(prev_close):
                day.o[i] = day.h[i] = day.l[i] = day.c[i] = prev_close
                day.candle_end_ts[i] = prev_ts + 60.0 if not np.isnan(prev_ts) else np.nan
        prev_close = day.c[i]
        prev_ts = day.candle_end_ts[i]


def _heikin_ashi(day: DayData) -> None:
    for i in range(N_CANDLES):
        if np.isnan(day.c[i]):
            continue
        day.ha_c[i] = (day.o[i] + day.h[i] + day.l[i] + day.c[i]) / 4.0
        if i == 0 or np.isnan(day.ha_o[i - 1]):
            day.ha_o[i] = (day.o[i] + day.c[i]) / 2.0
        else:
            day.ha_o[i] = (day.ha_o[i - 1] + day.ha_c[i - 1]) / 2.0
        day.ha_h[i] = max(day.h[i], day.ha_o[i], day.ha_c[i])
        day.ha_l[i] = min(day.l[i], day.ha_o[i], day.ha_c[i])


def _sma(day: DayData) -> None:
    for i in range(SMA_PERIOD - 1, N_CANDLES):
        window = day.ha_c[i - SMA_PERIOD + 1: i + 1]
        if not np.isnan(window).any():
            day.sma[i] = window.mean()


def _fill_chain_context(day: DayData, chain_by_minute: dict[int, dict]) -> None:
    last = None
    for i in range(N_CANDLES):
        rec = chain_by_minute.get(i) or last
        if rec is None:
            continue
        last = rec
        sp = day.spot[i]
        if np.isnan(sp):
            sp = rec.get("spotPrice") or np.nan
            day.spot[i] = sp
        if np.isnan(sp):
            continue
        atm = round(sp / STRIKE_STEP) * STRIKE_STEP
        oc = op = dc = dp = 0.0
        iv = np.nan
        for r in rec.get("rows") or []:
            k = r.get("strike")
            if k is None or abs(k - atm) > 3 * STRIKE_STEP:
                continue
            oc += r.get("callOI") or 0
            op += r.get("putOI") or 0
            dc += r.get("callOIChange") or 0
            dp += r.get("putOIChange") or 0
            if k == atm:
                civ, piv = r.get("callIV") or 0, r.get("putIV") or 0
                if civ > 0 and piv > 0:
                    iv = (civ + piv) / 2.0
                elif civ > 0 or piv > 0:
                    iv = max(civ, piv)
        day.oi_call[i] = oc
        day.oi_put[i] = op
        day.doi_call[i] = dc
        day.doi_put[i] = dp
        day.atm_iv[i] = iv


def _ffill_limited(arr: np.ndarray, max_gap: int) -> None:
    last = np.nan
    age = 0
    for i in range(arr.shape[0]):
        if not np.isnan(arr[i]):
            last = arr[i]
            age = 0
        else:
            age += 1
            if age <= max_gap and not np.isnan(last):
                arr[i] = last
