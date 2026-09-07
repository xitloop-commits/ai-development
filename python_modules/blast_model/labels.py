"""Labels, graded on the LOCKED strike's continuous premium (spec D-label):

ENTER = the premium rises more than +blast_pct within blast_window_min minutes
        of the decision candle's close (a "blast" — measured on candle HIGHS,
        the move a rider could actually catch).
EXIT  = the premium falls more than −drop_pct within drop_window_min (the
        blast is over / the drop is coming).

Rows too close to session end to see the full window get NaN labels and are
excluded from training (never guessed)."""
from __future__ import annotations

from .candles import Candle


def blast_labels(candles: list[Candle], i: int, blast_pct: float, window_sec: int,
                 drop_pct: float, drop_window_sec: int) -> tuple[float, float]:
    """(enter_label, exit_label) for a decision at candles[i]'s close."""
    nan = float("nan")
    if i < 0 or i >= len(candles):
        return nan, nan
    c0 = candles[i]
    base = c0.close
    if base <= 0:
        return nan, nan
    end_enter = c0.t + window_sec
    end_exit = c0.t + drop_window_sec
    hi = lo = None
    last_t = c0.t
    for c in candles[i + 1 :]:
        if c.t <= end_enter:
            hi = c.high if hi is None else max(hi, c.high)
        if c.t <= end_exit:
            lo = c.low if lo is None else min(lo, c.low)
        last_t = c.t
        if c.t > end_enter and c.t > end_exit:
            break
    # Window must be fully observable (data reaches past its end), else NaN.
    enter = nan
    if hi is not None and last_t >= end_enter:
        enter = float(hi >= base * (1.0 + blast_pct))
    exit_ = nan
    if lo is not None and last_t >= end_exit:
        exit_ = float(lo <= base * (1.0 - drop_pct))
    return enter, exit_
