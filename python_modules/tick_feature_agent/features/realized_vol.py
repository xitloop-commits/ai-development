"""
realized_vol.py — §8.19 Realized Volatility.

Features:
    underlying_realized_vol_5     std(log_returns) over last  5 ticks, NaN if < 5
    underlying_realized_vol_20    std(log_returns) over last 20 ticks, NaN if < 20
    underlying_realized_vol_50    std(log_returns) over last 50 ticks, NaN if < 50

Formula:
    log_returns_N = [log(ltp[i] / ltp[i-1]) for i in 1 .. N-1]
    realized_vol_N = sample_std(log_returns_N)          (ddof=1)

Output is the raw rolling sample standard deviation of log returns — not
annualized.  The ML model learns the scale from session context.

Null guard:
    NaN until N ticks are in the buffer.
    0.0 when all N prices are identical (valid zero-volatility state — not NaN).
    NaN if any ltp in the window is ≤ 0 (undefined log return).
"""

from __future__ import annotations

import math
import statistics

from tick_feature_agent.buffers.tick_buffer import CircularBuffer

_NAN = float("nan")
_VOL_WINDOWS = (5, 20, 50)


def compute_realized_vol_features(buffer: CircularBuffer) -> dict:
    """
    Compute all §8.19 realized volatility features.

    Args:
        buffer: CircularBuffer with the current tick already pushed.
                Maxlen=50 assumed (standard underlying buffer).

    Returns:
        Dict of 3 float features.  NaN until N ticks are available or if any
        LTP in the window is ≤ 0.  0.0 when all prices are identical.
    """
    n = len(buffer)

    out: dict = {
        "underlying_realized_vol_5":  _NAN,
        "underlying_realized_vol_20": _NAN,
        "underlying_realized_vol_50": _NAN,
    }

    if n == 0:
        return out

    ticks = buffer.get_last(n)   # list[UnderlyingTick], oldest → newest

    for w in _VOL_WINDOWS:
        if n < w:
            continue   # leaves NaN

        window = ticks[-w:]   # length == w, oldest first
        prices = [float(t.ltp) for t in window]

        # Guard: NaN if any price is zero or negative (log undefined)
        if any(p <= 0.0 for p in prices):
            continue   # leaves NaN

        # N prices → N-1 log returns (no tick before the window needed)
        log_returns = [
            math.log(prices[i] / prices[i - 1])
            for i in range(1, w)
        ]
        # len(log_returns) == w - 1 >= 4 for w >= 5 → stdev is always valid

        out[f"underlying_realized_vol_{w}"] = statistics.stdev(log_returns)

    return out
