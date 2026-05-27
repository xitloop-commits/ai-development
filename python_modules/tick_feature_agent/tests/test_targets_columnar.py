"""
tests/test_targets_columnar.py — T50 B.3b scaffold test (targets.py side).

Verifies that ``compute_targets_batch_spot`` (Polars columnar)
produces the same SPOT-BASED target values as
``TargetBuffer.compute_targets`` (scalar) on one synthetic spot
history + emit row. Per-strike CE/PE targets are deferred to the
B.3b execution session — see
``docs/T50_B3B_TARGETS_DESIGN.md`` § Pass 2.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import polars as pl

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

from tick_feature_agent.features.targets import TargetBuffer
from tick_feature_agent.features.targets_columnar import (
    compute_targets_batch_spot,
)

_SPOT_BASED_KEYS_PER_WINDOW = (
    "direction_{w}s",
    "direction_{w}s_magnitude",
    "direction_persists_{w}s",
    "breakout_in_{w}s",
    "exit_signal_{w}s",
)


def _scalar_one(
    history: list[tuple[float, float]],
    t0: float,
    spot_at_t0: float,
    active_strikes: dict,
    session_end_sec: float,
    day_high: float | None,
    day_low: float | None,
    target_windows_sec: tuple[int, ...],
) -> dict:
    """Run TargetBuffer.compute_targets and return its dict.

    active_strikes is required by the scalar API even when we only
    care about spot-based outputs — pass a stub so we don't blow up
    on the "no active strikes -> NaN" guard.
    """
    # Long retention so the buffer keeps every history entry — scalar's
    # default retention=max_window would evict the lookahead range we
    # want to inspect in this offline test (it's designed for online use
    # where compute_targets is called soon after t0).
    buf = TargetBuffer(
        target_windows_sec=target_windows_sec,
        retention_window_sec=10_000,
    )
    for ts, spot in history:
        # active_strikes empty per-tick is fine for spot-based features
        buf.push(ts, spot, {})
    return buf.compute_targets(
        t0=t0,
        spot_at_t0=spot_at_t0,
        active_strike_ltps_at_t0=active_strikes,
        session_end_sec=session_end_sec,
        day_high_at_t0=day_high,
        day_low_at_t0=day_low,
    )


def _eq(a, b, *, abs_tol: float = 1e-9, rel_tol: float = 1e-9) -> bool:
    a_missing = a is None or (isinstance(a, float) and math.isnan(a))
    b_missing = b is None or (isinstance(b, float) and math.isnan(b))
    if a_missing and b_missing:
        return True
    if a_missing != b_missing:
        return False
    return abs(a - b) <= abs_tol + rel_tol * abs(a)


def test_smooth_uptrend_with_breakout_in_lookahead():
    """1-Hz history climbing 1 pt/sec for 200s. Emit at t=10, spot=110.
    Day high observed at t=10 is 110; day low is 100. Lookahead at
    w=30 sees spot=140 (which exceeds day_high of 110) -> breakout=1.
    Lookahead never crosses below entry (uptrend) -> persists=1.
    Excursion (140-110)/110 ~ 27% > 1% -> exit_signal=1.
    """
    history = [(float(t), 100.0 + float(t)) for t in range(0, 201)]
    t0 = 10.0
    spot0 = 110.0
    day_high = 110.0   # high seen UP TO t0
    day_low = 100.0
    active_strikes = {25_000: (50.0, 50.0)}  # not used by spot-based code
    session_end_sec = 3_600.0
    windows = (30, 60)

    scalar_out = _scalar_one(
        history, t0, spot0, active_strikes, session_end_sec,
        day_high, day_low, windows,
    )

    emit_df = pl.DataFrame({
        "ts_sec": [t0],
        "spot_at_t0": [spot0],
        "day_high_at_t0": [day_high],
        "day_low_at_t0": [day_low],
    })
    history_df = pl.DataFrame({
        "ts_sec": [h[0] for h in history],
        "spot": [h[1] for h in history],
    })
    out_df = compute_targets_batch_spot(
        emit_df, history_df,
        target_windows_sec=windows,
        session_end_sec=session_end_sec,
    )
    assert len(out_df) == 1
    row = out_df.row(0, named=True)

    # Compare every spot-based column for every window.
    for w in windows:
        for key_tmpl in _SPOT_BASED_KEYS_PER_WINDOW:
            key = key_tmpl.format(w=w)
            s = scalar_out.get(key)
            c = row.get(key)
            assert _eq(s, c), f"{key}: scalar={s!r} columnar={c!r}"

    # Sanity-check the hand-computed expectations on w=30:
    # lookahead spots are 111..140; end_spot=140.
    #   direction_30s = 1 (140 > 110)
    #   direction_30s_magnitude = 30 / 110 ~ 0.2727
    #   direction_persists_30s = 1 (uptrend, no dips below 110)
    #   breakout_in_30s = 1 (max_spot 140 > day_high 110)
    #   exit_signal_30s = 1 (max_excursion_pct 27% > 1%)
    assert scalar_out["direction_30s"] == 1
    assert _eq(scalar_out["direction_30s_magnitude"], 30.0 / 110.0)
    assert scalar_out["direction_persists_30s"] == 1
    assert scalar_out["breakout_in_30s"] == 1
    assert scalar_out["exit_signal_30s"] == 1
