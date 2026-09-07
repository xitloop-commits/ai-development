"""Candles + the HH/HL premium structure — the model's gate lens.

Structure features per timeframe (computed fresh, no old-stack code):
  hh / hl flags, consecutive HH & HL counts, range position over a lookback,
  new-range-high/low flags, distance to last swing high/low (%), bars since
  the last pivot, up-leg fraction of the recent range.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Candle:
    t: int          # bucket start, epoch sec
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


class CandleBuilder:
    """Bucket ticks (ts, price, qty) into fixed-second candles."""

    def __init__(self, bucket_sec: int):
        self.bucket_sec = bucket_sec
        self.candles: list[Candle] = []
        self._cur: Candle | None = None

    def add(self, ts: float, price: float, qty: float = 0.0) -> Candle | None:
        """Feed one tick; returns the JUST-CLOSED candle when a bucket rolls."""
        if price <= 0:
            return None
        bucket = int(ts // self.bucket_sec) * self.bucket_sec
        cur = self._cur
        if cur is None:
            self._cur = Candle(bucket, price, price, price, price, qty)
            return None
        if bucket == cur.t:
            cur.high = max(cur.high, price)
            cur.low = min(cur.low, price)
            cur.close = price
            cur.volume += qty
            return None
        closed = cur
        self.candles.append(closed)
        self._cur = Candle(bucket, price, price, price, price, qty)
        return closed

    @property
    def last_close(self) -> float | None:
        if self._cur is not None:
            return self._cur.close
        return self.candles[-1].close if self.candles else None


def _pivots(candles: list[Candle], w: int) -> tuple[list[int], list[int]]:
    """Indices of swing highs / swing lows (w candles each side)."""
    highs, lows = [], []
    for i in range(w, len(candles) - w):
        seg = candles[i - w : i + w + 1]
        if candles[i].high == max(c.high for c in seg):
            highs.append(i)
        if candles[i].low == min(c.low for c in seg):
            lows.append(i)
    return highs, lows


def structure_features(candles: list[Candle], swing_window: int, range_lookback: int,
                       prefix: str) -> dict[str, float]:
    """The HH/HL lens over a closed-candle list (call at decision time)."""
    nan = float("nan")
    out = {
        f"{prefix}_hh": nan, f"{prefix}_hl": nan,
        f"{prefix}_consec_hh": nan, f"{prefix}_consec_hl": nan,
        f"{prefix}_range_pos": nan,
        f"{prefix}_new_range_high": nan, f"{prefix}_new_range_low": nan,
        f"{prefix}_dist_swing_high": nan, f"{prefix}_dist_swing_low": nan,
        f"{prefix}_bars_since_pivot": nan, f"{prefix}_upleg_frac": nan,
    }
    n = len(candles)
    if n < swing_window * 2 + 2:
        return out
    close = candles[-1].close
    lb = candles[-min(n, range_lookback):]
    rng_hi = max(c.high for c in lb)
    rng_lo = min(c.low for c in lb)
    rng = rng_hi - rng_lo
    out[f"{prefix}_range_pos"] = (close - rng_lo) / rng if rng > 0 else 0.5
    prev = lb[:-1]
    out[f"{prefix}_new_range_high"] = float(close >= max(c.high for c in prev)) if prev else 0.0
    out[f"{prefix}_new_range_low"] = float(close <= min(c.low for c in prev)) if prev else 0.0

    highs_i, lows_i = _pivots(candles, swing_window)
    sw_highs = [candles[i].high for i in highs_i]
    sw_lows = [candles[i].low for i in lows_i]
    if len(sw_highs) >= 2:
        out[f"{prefix}_hh"] = float(sw_highs[-1] > sw_highs[-2])
        c = 0
        for a, b in zip(reversed(sw_highs[1:]), reversed(sw_highs[:-1])):
            if a > b:
                c += 1
            else:
                break
        out[f"{prefix}_consec_hh"] = float(c)
    if len(sw_lows) >= 2:
        out[f"{prefix}_hl"] = float(sw_lows[-1] > sw_lows[-2])
        c = 0
        for a, b in zip(reversed(sw_lows[1:]), reversed(sw_lows[:-1])):
            if a > b:
                c += 1
            else:
                break
        out[f"{prefix}_consec_hl"] = float(c)
    if sw_highs and close > 0:
        out[f"{prefix}_dist_swing_high"] = (sw_highs[-1] - close) / close
    if sw_lows and close > 0:
        out[f"{prefix}_dist_swing_low"] = (close - sw_lows[-1]) / close
    last_piv = max(highs_i[-1] if highs_i else -1, lows_i[-1] if lows_i else -1)
    if last_piv >= 0:
        out[f"{prefix}_bars_since_pivot"] = float(n - 1 - last_piv)
    # Up-leg fraction: how much of the recent range the current up-leg covers.
    if rng > 0 and sw_lows:
        out[f"{prefix}_upleg_frac"] = max(0.0, min(1.0, (close - sw_lows[-1]) / rng))
    return out
