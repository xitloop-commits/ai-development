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
    compute_targets_batch_per_strike,
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


# ── Per-strike tests ────────────────────────────────────────────────────────


def _scalar_per_strike(
    history_full: list[tuple[float, float, dict[int, tuple[float, float]]]],
    t0: float,
    spot_at_t0: float,
    active_strikes: dict[int, tuple[float, float]],
    session_end_sec: float,
    target_windows_sec: tuple[int, ...],
) -> dict:
    """Run TargetBuffer.compute_targets with per-strike LTPs populated."""
    buf = TargetBuffer(
        target_windows_sec=target_windows_sec,
        retention_window_sec=10_000,
    )
    for ts, spot, strike_ltps in history_full:
        buf.push(ts, spot, strike_ltps)
    return buf.compute_targets(
        t0=t0,
        spot_at_t0=spot_at_t0,
        active_strike_ltps_at_t0=active_strikes,
        session_end_sec=session_end_sec,
    )


def test_per_strike_matches_scalar_on_simple_history():
    """Two active strikes at t0; per-strike CE history climbs in
    lookahead. max_upside picks the strike with the biggest gain;
    premium_decay sums (now − last) across both active strikes."""

    # Build per-tick history with per-strike LTPs from t=0..200.
    # Strike 24900: CE climbs from 100 -> 130 over 200 sec (1.5x at end).
    # Strike 25000: CE climbs from 50  -> 65  over 200 sec.
    history_full: list[tuple[float, float, dict[int, tuple[float, float]]]] = []
    for t in range(0, 201):
        ce_24900 = 100.0 + 0.15 * t
        pe_24900 = 50.0 - 0.05 * t
        ce_25000 = 50.0 + 0.075 * t
        pe_25000 = 100.0 + 0.05 * t
        history_full.append((
            float(t),
            25_000.0 + float(t) * 0.5,
            {
                24900: (ce_24900, pe_24900),
                25000: (ce_25000, pe_25000),
            },
        ))

    t0 = 10.0
    # active strikes at t0: snapshot from the history at t=10
    spot0 = 25_000.0 + 10.0 * 0.5
    active = {
        24900: (100.0 + 0.15 * 10, 50.0 - 0.05 * 10),
        25000: (50.0 + 0.075 * 10, 100.0 + 0.05 * 10),
    }
    session_end_sec = 3_600.0
    windows = (30, 60)

    scalar_out = _scalar_per_strike(
        history_full, t0, spot0, active, session_end_sec, windows,
    )

    # Build columnar inputs.
    emit_df = pl.DataFrame({
        "ts_sec": [t0],
        "spot_at_t0": [spot0],
        "active_strikes_at_t0": [
            [
                {"strike": k, "ce_now": v[0], "pe_now": v[1]}
                for k, v in active.items()
            ],
        ],
    })
    strike_history_rows: list[dict] = []
    for ts, _spot, strike_ltps in history_full:
        for strike, (ce, pe) in strike_ltps.items():
            strike_history_rows.append({
                "ts_sec": ts, "strike": strike, "ce_ltp": ce, "pe_ltp": pe,
            })
    strike_history_df = pl.DataFrame(strike_history_rows)

    out_df = compute_targets_batch_per_strike(
        emit_df, strike_history_df,
        target_windows_sec=windows,
        session_end_sec=session_end_sec,
    )
    assert len(out_df) == 1
    row = out_df.row(0, named=True)

    # Compare all 7 per-strike columns × 2 windows = 14 cols.
    per_strike_keys = (
        "max_upside_{w}s",
        "max_drawdown_{w}s",
        "risk_reward_ratio_{w}s",
        "total_premium_decay_{w}s",
        "avg_decay_per_strike_{w}s",
        "max_upside_pe_{w}s",
        "max_drawdown_pe_{w}s",
    )
    for w in windows:
        for tmpl in per_strike_keys:
            key = tmpl.format(w=w)
            s = scalar_out.get(key)
            c = row.get(key)
            assert _eq(s, c), f"{key}: scalar={s!r} columnar={c!r}"


def test_per_strike_no_active_strikes_yields_nan():
    """Empty active_strikes_at_t0 -> all per-strike cols NaN per scalar.

    Note: TargetBuffer.compute_targets with active_strike_ltps_at_t0={}
    has has_active=False, which short-circuits every per-strike branch
    to NaN.
    """
    history_full = [
        (float(t), 25_000.0, {24900: (100.0 + t, 50.0)}) for t in range(0, 100)
    ]
    t0 = 10.0
    spot0 = 25_000.0
    active: dict[int, tuple[float, float]] = {}  # empty
    session_end_sec = 3_600.0
    windows = (30,)

    scalar_out = _scalar_per_strike(
        history_full, t0, spot0, active, session_end_sec, windows,
    )

    emit_df = pl.DataFrame({
        "ts_sec": [t0],
        "spot_at_t0": [spot0],
        "active_strikes_at_t0": [
            pl.Series(
                "active_strikes_at_t0",
                [[]],
                dtype=pl.List(pl.Struct({
                    "strike": pl.Int64, "ce_now": pl.Float64, "pe_now": pl.Float64,
                })),
            )[0],
        ],
    }, schema={
        "ts_sec": pl.Float64,
        "spot_at_t0": pl.Float64,
        "active_strikes_at_t0": pl.List(pl.Struct({
            "strike": pl.Int64, "ce_now": pl.Float64, "pe_now": pl.Float64,
        })),
    })
    strike_history_df = pl.DataFrame({
        "ts_sec": [float(t) for t in range(0, 100)],
        "strike": [24900] * 100,
        "ce_ltp": [100.0 + float(t) for t in range(0, 100)],
        "pe_ltp": [50.0] * 100,
    })

    out_df = compute_targets_batch_per_strike(
        emit_df, strike_history_df,
        target_windows_sec=windows,
        session_end_sec=session_end_sec,
    )
    row = out_df.row(0, named=True)
    for w in windows:
        for tmpl in (
            "max_upside_{w}s", "max_drawdown_{w}s",
            "max_upside_pe_{w}s", "max_drawdown_pe_{w}s",
            "total_premium_decay_{w}s", "avg_decay_per_strike_{w}s",
            "risk_reward_ratio_{w}s",
        ):
            key = tmpl.format(w=w)
            s = scalar_out.get(key)
            c = row.get(key)
            assert _eq(s, c), f"{key}: scalar={s!r} columnar={c!r}"
