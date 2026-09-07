"""Fast-flow watch (Partha 2026-09-07): WHERE buyers/sellers are entering and
exiting QUICKLY, per strike-leg.

From each strike-leg's tick stream we keep a short history of (ts, oi, volume,
ltp) and compute, per window:
  oi_rate   — OI change over the window / current OI (signed, fraction)
  vol_burst — volume traded in the window vs the average window before it
  klass     — +2 long-buildup (price↑ OI↑) · +1 short-cover (price↑ OI↓)
              −1 long-unwind (price↓ OI↓) · −2 short-buildup (price↓ OI↑) · 0 quiet
Order-book imbalance comes free from the tick's total_buy / total_sell.
"""
from __future__ import annotations

from collections import deque


class FlowTracker:
    """One strike-leg's rolling flow state."""

    def __init__(self, windows_sec: tuple[int, ...]):
        self.windows = windows_sec
        self._hist: deque[tuple[float, float, float, float]] = deque()  # ts, oi, cumvol, ltp
        self._max_keep = max(windows_sec) * 2 + 60
        self.imbalance = 0.0  # (total_buy − total_sell) / (sum), last tick

    def add(self, ts: float, oi: float, cum_volume: float, ltp: float,
            total_buy: float = 0.0, total_sell: float = 0.0) -> None:
        self._hist.append((ts, oi, cum_volume, ltp))
        while self._hist and ts - self._hist[0][0] > self._max_keep:
            self._hist.popleft()
        tot = total_buy + total_sell
        if tot > 0:
            self.imbalance = (total_buy - total_sell) / tot

    def _at_or_before(self, ts: float):
        best = None
        for row in self._hist:
            if row[0] <= ts:
                best = row
            else:
                break
        return best

    def features(self, now_ts: float, prefix: str) -> dict[str, float]:
        nan = float("nan")
        out: dict[str, float] = {f"{prefix}_imbalance": self.imbalance if self._hist else nan}
        cur = self._hist[-1] if self._hist else None
        for w in self.windows:
            tag = f"{prefix}_{w}s"
            oi_rate = vol_burst = klass = nan
            if cur is not None:
                past = self._at_or_before(now_ts - w)
                past2 = self._at_or_before(now_ts - 2 * w)
                if past is not None:
                    _, oi0, vol0, ltp0 = past
                    _, oi1, vol1, ltp1 = cur
                    if oi1 > 0:
                        oi_rate = (oi1 - oi0) / oi1
                    win_vol = max(0.0, vol1 - vol0)
                    if past2 is not None:
                        prev_vol = max(0.0, vol0 - past2[2])
                        vol_burst = win_vol / prev_vol if prev_vol > 0 else (2.0 if win_vol > 0 else 0.0)
                    price_up = ltp1 > ltp0
                    oi_up = oi1 > oi0
                    if oi1 == oi0 and ltp1 == ltp0:
                        klass = 0.0
                    elif price_up and oi_up:
                        klass = 2.0    # long buildup — buyers piling in
                    elif price_up and not oi_up:
                        klass = 1.0    # short covering — sellers fleeing
                    elif not price_up and oi_up:
                        klass = -2.0   # short buildup — writers walling
                    else:
                        klass = -1.0   # long unwind — buyers leaving
            out[f"{tag}_oi_rate"] = oi_rate
            out[f"{tag}_vol_burst"] = vol_burst
            out[f"{tag}_class"] = klass
        return out
