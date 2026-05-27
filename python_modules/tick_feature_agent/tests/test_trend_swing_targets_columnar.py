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
    # NIFTY noise floor = 8 pts; magnitude=900 > 8 so direction = 1.0.
    assert first["trend_direction_900s"] == 1.0


# ── Edge-case sweep ─────────────────────────────────────────────────────────


def _compare_emits(history, emit_ts_list, emit_spot_list, instrument, session_end_sec):
    """Run scalar + columnar across a list of emit rows; return pairs of
    (scalar_row_dict, columnar_row_dict) for assertion."""
    scalar_rows = [
        _scalar_for_one_emit(history, t, s, instrument, session_end_sec)
        for t, s in zip(emit_ts_list, emit_spot_list)
    ]
    emit_df = pl.DataFrame({"ts_sec": emit_ts_list, "spot_at_t0": emit_spot_list})
    history_df = pl.DataFrame({
        "ts_sec": [h[0] for h in history],
        "spot": [h[1] for h in history],
    })
    out_df = compute_trend_swing_targets_batch(
        emit_df, history_df,
        instrument_name=instrument,
        session_end_sec=session_end_sec,
    )
    return scalar_rows, out_df


def _all_target_cols() -> list[str]:
    return [
        f"{layer}_{stat}_{w}s"
        for layer, horizons in (("trend", TREND_HORIZONS_SEC),
                                ("swing", SWING_HORIZONS_SEC))
        for w in horizons
        for stat in ("direction", "magnitude", "max_excursion",
                     "max_drawdown", "continues", "breakout_imminent")
    ]


def test_downtrend_direction_is_zero():
    """Direction is BINARY (1.0 iff magnitude > noise_floor). Downtrends
    produce direction=0 because magnitude is negative. This is the bug
    a {-1,0,+1} bucketed implementation would miss."""
    # Linear DOWNtrend: 1 pt/sec drop over 2000 sec.
    history = [(float(t), 12_000.0 - float(t)) for t in range(0, 2001)]
    scalar_rows, out_df = _compare_emits(
        history, [100.0], [12_000.0 - 100.0],
        "NIFTY", session_end_sec=25_200.0,
    )
    for col in _all_target_cols():
        s = scalar_rows[0].get(col)
        c = out_df.row(0, named=True).get(col)
        assert _eq(s, c), f"{col}: scalar={s!r} columnar={c!r}"
    # Specifically: magnitude=-900, direction must be 0.0 (NOT -1).
    assert _eq(scalar_rows[0]["trend_magnitude_900s"], -900.0)
    assert scalar_rows[0]["trend_direction_900s"] == 0.0


def test_below_noise_floor_direction_is_zero():
    """|magnitude| < noise_floor -> direction=0 even if positive."""
    # Slow drift: 0.005 pt/sec * 900 sec = 4.5 pts < NIFTY 8 pt noise floor.
    history = [(float(t), 25_000.0 + 0.005 * t) for t in range(0, 2001)]
    scalar_rows, out_df = _compare_emits(
        history, [100.0], [25_000.0 + 0.5],
        "NIFTY", session_end_sec=25_200.0,
    )
    for col in _all_target_cols():
        s = scalar_rows[0].get(col)
        c = out_df.row(0, named=True).get(col)
        assert _eq(s, c), f"{col}: scalar={s!r} columnar={c!r}"
    # magnitude ~ 4.5, noise floor 8 -> direction = 0.0
    assert scalar_rows[0]["trend_direction_900s"] == 0.0


def test_continues_one_when_same_sign_and_above_noise():
    """continues=1 requires same-sign prior + forward AND |mag| >= noise."""
    # Sustained uptrend over [t-300, t+900], well above noise floor.
    history = [(float(t), 20_000.0 + float(t)) for t in range(0, 2001)]
    scalar_rows, out_df = _compare_emits(
        history, [500.0], [20_500.0],  # t=500, mid-trend
        "NIFTY", session_end_sec=25_200.0,
    )
    for col in _all_target_cols():
        s = scalar_rows[0].get(col)
        c = out_df.row(0, named=True).get(col)
        assert _eq(s, c), f"{col}: scalar={s!r} columnar={c!r}"
    assert scalar_rows[0]["trend_continues_900s"] == 1.0


def test_continues_zero_when_direction_reverses():
    """Prior 300s uptrend, then forward 900s downtrend -> continues=0."""
    # Build a V shape: rise from 0 to 500, fall from 500 to 1400.
    history: list[tuple[float, float]] = []
    for t in range(0, 501):
        history.append((float(t), 20_000.0 + float(t)))
    for t in range(501, 1501):
        history.append((float(t), 20_500.0 - (float(t) - 500.0)))
    scalar_rows, out_df = _compare_emits(
        history, [500.0], [20_500.0],  # peak of the V
        "NIFTY", session_end_sec=25_200.0,
    )
    for col in _all_target_cols():
        s = scalar_rows[0].get(col)
        c = out_df.row(0, named=True).get(col)
        assert _eq(s, c), f"{col}: scalar={s!r} columnar={c!r}"
    # Prior change positive (rose 500 in lookback). Forward magnitude
    # negative (fell from 20500 to 19600 over 900s). Different signs ->
    # continues = 0.0.
    assert scalar_rows[0]["trend_continues_900s"] == 0.0


def test_past_session_end_returns_all_nan_for_horizon():
    """If t0+w > session_end_sec the 6 cols for THAT horizon are NaN.
    Shorter horizons that fit may still produce values."""
    history = [(float(t), 30_000.0 + float(t)) for t in range(0, 4000)]
    # session_end at 1500s. t0=1000, w=900 -> 1900 > 1500 -> NaN.
    #                        t0=1000, w=1800 -> 2800 > 1500 -> NaN.
    scalar_rows, out_df = _compare_emits(
        history, [1000.0], [31_000.0],
        "NIFTY", session_end_sec=1500.0,
    )
    for col in _all_target_cols():
        s = scalar_rows[0].get(col)
        c = out_df.row(0, named=True).get(col)
        assert _eq(s, c), f"{col}: scalar={s!r} columnar={c!r}"
    # All trend + swing horizons exceed 1500 -> all 24 cols NaN.
    for col in _all_target_cols():
        v = scalar_rows[0].get(col)
        assert v is None or (isinstance(v, float) and math.isnan(v)), (
            f"{col}: expected NaN, got {v!r}"
        )


def test_empty_lookahead_returns_all_nan():
    """t0 sits past every history entry -> no lookahead -> all NaN."""
    history = [(float(t), 18_000.0 + float(t)) for t in range(0, 100)]
    # t0=200 — past every history entry. Lookahead empty for every horizon.
    scalar_rows, out_df = _compare_emits(
        history, [200.0], [18_200.0],
        "NIFTY", session_end_sec=25_200.0,
    )
    for col in _all_target_cols():
        s = scalar_rows[0].get(col)
        c = out_df.row(0, named=True).get(col)
        assert _eq(s, c), f"{col}: scalar={s!r} columnar={c!r}"


def test_breakout_threshold_inclusive():
    """breakout_imminent uses >= (inclusive), not >. A move exactly at
    noise_floor * scale should be 1.0, not 0.0."""
    # NIFTY noise=8, trend scale=3 -> threshold=24.
    # Build a history where max excursion in 900s is EXACTLY 24.
    history: list[tuple[float, float]] = []
    base = 20_000.0
    for t in range(0, 1100):
        if t == 500:
            history.append((float(t), base + 24.0))  # the peak
        elif t == 200:
            history.append((float(t), base))  # at t0
        else:
            history.append((float(t), base + 1.0))  # everywhere else
    scalar_rows, out_df = _compare_emits(
        history, [200.0], [base],
        "NIFTY", session_end_sec=25_200.0,
    )
    for col in _all_target_cols():
        s = scalar_rows[0].get(col)
        c = out_df.row(0, named=True).get(col)
        assert _eq(s, c), f"{col}: scalar={s!r} columnar={c!r}"
    # Excursion = 24 exactly, threshold = 24 -> breakout = 1.0 (>=).
    assert _eq(scalar_rows[0]["trend_max_excursion_900s"], 24.0)
    assert scalar_rows[0]["trend_breakout_imminent_900s"] == 1.0


def test_unknown_instrument_yields_nan_direction():
    """Instrument not in NOISE_FLOOR_PTS -> direction, continues,
    breakout_imminent all NaN; magnitude/excursion/drawdown still valid."""
    history = [(float(t), 50_000.0 + float(t)) for t in range(0, 2001)]
    scalar_rows, out_df = _compare_emits(
        history, [100.0], [50_100.0],
        "EXOTICOIL", session_end_sec=25_200.0,
    )
    for col in _all_target_cols():
        s = scalar_rows[0].get(col)
        c = out_df.row(0, named=True).get(col)
        assert _eq(s, c), f"{col}: scalar={s!r} columnar={c!r}"
    s = scalar_rows[0]
    assert isinstance(s["trend_direction_900s"], float) and math.isnan(s["trend_direction_900s"])
    assert _eq(s["trend_magnitude_900s"], 900.0)  # still valid
