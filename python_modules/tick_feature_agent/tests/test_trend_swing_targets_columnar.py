"""
tests/test_trend_swing_targets_columnar.py — T50 B.3b scaffold test.

Verifies that ``compute_trend_swing_targets_batch`` (Polars columnar)
produces the same values as ``SpotTargetBuffer.compute_targets``
(scalar) on one synthetic spot history. Full edge-case sweep + real-
data harness ship in the B.3b execution session — see
``docs/T50_B3B_TARGETS_DESIGN.md`` § Next-session checklist.
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

from tick_feature_agent.features.trend_swing_targets import (
    SWING_HORIZONS_SEC,
    TREND_HORIZONS_SEC,
    SpotTargetBuffer,
)
from tick_feature_agent.features.trend_swing_targets_columnar import (
    compute_trend_swing_targets_batch,
)


def _scalar_for_one_emit(
    history: list[tuple[float, float]],
    t0: float,
    spot_at_t0: float,
    instrument_name: str,
    session_end_sec: float,
) -> dict[str, float | None]:
    """Run scalar SpotTargetBuffer.compute_targets for one emit point."""
    buf = SpotTargetBuffer()
    for ts, spot in history:
        buf.push(ts, spot)
    return buf.compute_targets(
        t0=t0,
        spot_at_t0=spot_at_t0,
        instrument_name=instrument_name,
        session_end_sec=session_end_sec,
    )


def _eq(a, b, *, abs_tol: float = 1e-9) -> bool:
    a_missing = a is None or (isinstance(a, float) and math.isnan(a))
    b_missing = b is None or (isinstance(b, float) and math.isnan(b))
    if a_missing and b_missing:
        return True
    if a_missing != b_missing:
        return False
    return abs(a - b) <= abs_tol


def test_smooth_uptrend_matches_scalar():
    """Synthetic linear uptrend of 1 pt/sec over the session. At t0=100s,
    spot=10100. Lookahead window 900s -> spot at t=1000s should be
    11000, magnitude=900, excursion=900, drawdown=0 (no dips), direction
    bucket = +1 for NIFTY (way above noise floor of 8pts)."""

    # Build 1-Hz history from t=0 to t=2000s, perfectly linear.
    history = [(float(t), 10_000.0 + float(t)) for t in range(0, 2001)]

    # Emit rows at t=100, 200, 500 — three points along the trend.
    emit_ts = [100.0, 200.0, 500.0]
    emit_spot = [10_000.0 + t for t in emit_ts]

    instrument = "NIFTY"
    session_end_sec = 25_200.0  # well past all horizons

    # Scalar reference.
    scalar_rows = [
        _scalar_for_one_emit(history, t, s, instrument, session_end_sec)
        for t, s in zip(emit_ts, emit_spot)
    ]

    # Columnar.
    emit_df = pl.DataFrame({
        "ts_sec": emit_ts,
        "spot_at_t0": emit_spot,
    })
    history_df = pl.DataFrame({
        "ts_sec": [h[0] for h in history],
        "spot": [h[1] for h in history],
    })
    out_df = compute_trend_swing_targets_batch(
        emit_df, history_df,
        instrument_name=instrument,
        session_end_sec=session_end_sec,
    )
    assert len(out_df) == len(emit_ts)

    # Compare row-by-row across all 24 target columns.
    target_cols = [
        f"{layer}_{stat}_{w}s"
        for layer, horizons in (("trend", TREND_HORIZONS_SEC),
                                ("swing", SWING_HORIZONS_SEC))
        for w in horizons
        for stat in ("direction", "magnitude", "max_excursion",
                     "max_drawdown", "continues", "breakout_imminent")
    ]
    for col in target_cols:
        assert col in out_df.columns, f"missing column: {col}"

    for i, scalar_out in enumerate(scalar_rows):
        col_row = out_df.row(i, named=True)
        for col in target_cols:
            s = scalar_out.get(col)
            c = col_row.get(col)
            assert _eq(s, c), f"row {i} {col}: scalar={s!r} columnar={c!r}"

    # Sanity-check the hand-computed expectations on the first emit
    # (t0=100, spot=10100). 900s horizon: lookahead is (100, 1000]
    # with spots 10101..11000.
    #   magnitude  = end_spot - spot_at_t0 = 11000 - 10100 = 900
    #   excursion  = max - spot_at_t0      = 11000 - 10100 = 900
    #   drawdown   = spot_at_t0 - min       = 10100 - 10101 = -1
    #                (smooth uptrend never dips below spot_at_t0, so the
    #                 signed drawdown is the slightly-negative gap to
    #                 the first lookahead sample)
    first = scalar_rows[0]
    assert _eq(first["trend_magnitude_900s"], 900.0)
    assert _eq(first["trend_max_excursion_900s"], 900.0)
    assert _eq(first["trend_max_drawdown_900s"], -1.0)
    # NIFTY noise floor = 8 pts; |900| >> 8 so direction = +1.
    assert first["trend_direction_900s"] == 1
