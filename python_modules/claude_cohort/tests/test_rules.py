"""Claude cohort rule tests.

The regression test that matters most is `test_flow_flip_ignores_a_single_sign_change`
— the first version of the flow-flip exit used a bare sign change and produced a
median hold of one minute against a design of 15 minutes to 2 hours.
"""
from __future__ import annotations

import pytest

from claude_cohort.config import Params, assert_causal, is_banned, round_trip_charges
from claude_cohort.rules import (
    SETUP_A,
    SETUP_B,
    Position,
    SessionState,
    detect_break,
    detect_fade,
    evaluate_exit,
    liquidity_gate,
    session_open_for_entries,
    stop_distance,
    wall_room_pts,
)


def base_row(**over):
    row = {
        "timestamp": 1_789_000_000.0,
        "underlying_ltp": 23400.0,
        "is_market_open": 1,
        "minutes_from_open": 60.0,
        "minutes_to_close": 200.0,
        "lunch_session_flag": 0.0,
        "time_since_chain_sec": 20.0,
        "adx_5min": 30.0,
        "rsi_14_5min": 55.0,
        "underlying_ofi_20": 120.0,
        "underlying_ofi_50": 200.0,
        "underlying_tick_imbalance_20": 0.4,
        "underlying_realized_vol_20": 2.0,
        "distance_to_opening_range_high_pct": 0.2,
        "distance_to_opening_range_low_pct": 0.5,
        "distance_to_day_high_pct": -0.1,
        "distance_to_day_low_pct": 1.0,
        "oi_weighted_ce_resistance_strike": 23800.0,
        "oi_weighted_pe_support_strike": 23000.0,
        "atm_ce_delta": 0.52,
        "atm_pe_delta": -0.48,
        "opt_0_ce_bid": 100.0,
        "opt_0_ce_ask": 100.5,
        "opt_0_pe_bid": 98.0,
        "opt_0_pe_ask": 98.5,
    }
    row.update(over)
    return row


# ── look-ahead guard ─────────────────────────────────────────────────────


def test_forward_labels_are_banned():
    for col in ("max_upside_60s", "direction_persists_300s", "trend_x_900s", "swing_magnitude_3600s"):
        assert is_banned(col), col
    for col in ("underlying_ltp", "adx_5min", "chain_pcr_atm"):
        assert not is_banned(col), col


def test_assert_causal_raises_on_a_forward_label():
    assert_causal(["underlying_ltp", "adx_5min"])  # fine
    with pytest.raises(ValueError, match="LOOK-AHEAD"):
        assert_causal(["underlying_ltp", "max_upside_300s"])


# ── session gate ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "over,why",
    [
        ({"is_market_open": 0}, "market_closed"),
        ({"minutes_from_open": 5.0}, "opening_noise"),
        ({"minutes_to_close": 10.0}, "closing_window"),
        ({"lunch_session_flag": 1.0}, "lunch"),
        ({"time_since_chain_sec": 600.0}, "chain_stale"),
    ],
)
def test_session_gate_blocks(over, why):
    ok, reason = session_open_for_entries(base_row(**over), Params())
    assert not ok and reason == why


def test_session_gate_allows_a_normal_row():
    ok, _ = session_open_for_entries(base_row(), Params())
    assert ok


# ── stop sizing ──────────────────────────────────────────────────────────


def test_stop_is_scale_invariant():
    """Findings bug 8: a flat percentage is meaningless across instruments."""
    p = Params(stop_pct=0.10, min_stop_pts=8.0)
    # NIFTY at 23400 -> 23.4 pts, above the floor
    assert stop_distance(base_row(), p) == pytest.approx(23.4)
    # A cheap instrument would give a sub-point stop; the floor rescues it.
    assert stop_distance(base_row(underlying_ltp=200.0), p) == 8.0


# ── walls ────────────────────────────────────────────────────────────────


def test_wall_room_is_directional():
    row = base_row()
    assert wall_room_pts(row, "CE") == pytest.approx(400.0)   # 23800 - 23400
    assert wall_room_pts(row, "PE") == pytest.approx(400.0)   # 23400 - 23000


def test_missing_wall_is_nan_not_zero():
    """NaN means 'unknown', which callers treat as permissive. Zero would mean
    'the wall is exactly here' and would block every trade."""
    import math

    assert math.isnan(wall_room_pts(base_row(oi_weighted_ce_resistance_strike=0.0), "CE"))


# ── liquidity gate ───────────────────────────────────────────────────────


def test_liquidity_gate_passes_a_tight_spread():
    ok, _ = liquidity_gate(base_row(), "CE", target_pts=46.8, p=Params())
    assert ok


def test_liquidity_gate_rejects_a_wide_spread():
    row = base_row(opt_0_ce_bid=90.0, opt_0_ce_ask=120.0)
    ok, why = liquidity_gate(row, "CE", target_pts=46.8, p=Params())
    assert not ok and why == "spread_too_wide"


def test_liquidity_gate_rejects_delta_outside_the_band():
    ok, why = liquidity_gate(base_row(atm_ce_delta=0.90), "CE", 46.8, Params())
    assert not ok and why == "delta_band"


# ── setup A ──────────────────────────────────────────────────────────────


def _state_with_vol(v=1.0, n=30):
    s = SessionState()
    s.vol_samples = [v] * n
    s.ofi_samples = [100.0] * n
    return s


def test_break_fires_on_flow_backed_upside_break():
    assert detect_break(base_row(), _state_with_vol(), Params()) == "CE"


def test_break_is_blocked_when_chopping():
    assert detect_break(base_row(adx_5min=10.0), _state_with_vol(), Params()) is None


def test_break_is_blocked_without_range_expansion():
    """Drifting into the level is not the same as breaking through it."""
    assert detect_break(base_row(underlying_realized_vol_20=0.2), _state_with_vol(v=5.0), Params()) is None


def test_break_is_blocked_when_exhausted():
    assert detect_break(base_row(rsi_14_5min=90.0), _state_with_vol(), Params()) is None


def test_break_needs_flow_in_the_same_direction():
    row = base_row(underlying_ofi_20=-500.0, underlying_tick_imbalance_20=-0.5)
    assert detect_break(row, _state_with_vol(), Params()) is None


# ── setup B ──────────────────────────────────────────────────────────────


def test_fade_fires_after_a_failed_upside_break():
    s = _state_with_vol()
    ts = 1_789_000_000.0
    # poked above the opening range 3 minutes ago, flow was positive then
    s.recent.append((ts - 180.0, True, False, 1))
    row = base_row(
        timestamp=ts,
        distance_to_opening_range_high_pct=-0.1,   # back below
        underlying_ofi_20=-300.0,                  # flow flipped down
    )
    assert detect_fade(row, s, Params()) == "PE"


def test_fade_does_not_fire_while_still_above_the_level():
    s = _state_with_vol()
    ts = 1_789_000_000.0
    s.recent.append((ts - 180.0, True, False, 1))
    row = base_row(timestamp=ts, distance_to_opening_range_high_pct=0.3, underlying_ofi_20=-300.0)
    assert detect_fade(row, s, Params()) is None


def test_fade_expires_outside_the_window():
    s = _state_with_vol()
    ts = 1_789_000_000.0
    s.recent.append((ts - 3600.0, True, False, 1))   # an hour ago
    row = base_row(timestamp=ts, distance_to_opening_range_high_pct=-0.1, underlying_ofi_20=-300.0)
    assert detect_fade(row, s, Params()) is None


# ── exits ────────────────────────────────────────────────────────────────


def _pos(**over):
    kw = dict(
        setup=SETUP_A,
        leg="CE",
        entry_ts=1_789_000_000.0,
        entry_underlying=23400.0,
        entry_premium=100.5,
        stop_pts=23.4,
        target_pts=46.8,
        entry_ofi_sign=1,
    )
    kw.update(over)
    return Position(**kw)


def test_stop_fires_on_the_underlying_not_the_premium():
    pos = _pos()
    row = base_row(timestamp=pos.entry_ts + 120.0, underlying_ltp=23376.0)  # -24 pts
    assert evaluate_exit(row, pos, Params(), state=_state_with_vol()) == "stop"


def test_target_fires_at_the_target_level():
    pos = _pos()
    row = base_row(timestamp=pos.entry_ts + 120.0, underlying_ltp=23450.0)  # +50 pts
    assert evaluate_exit(row, pos, Params(), state=_state_with_vol()) == "target_half"


def test_time_stop_fires():
    pos = _pos()
    row = base_row(timestamp=pos.entry_ts + 31 * 60.0, underlying_ltp=23405.0, underlying_ofi_50=50.0)
    assert evaluate_exit(row, pos, Params(), state=_state_with_vol()) == "time_stop"


def test_flow_flip_ignores_a_single_sign_change():
    """REGRESSION. `underlying_ofi_20` changes sign ~762 times a day (measured
    2026-09-16). Treating one sign change as an exit gave a 1-minute median hold.
    A flip must be hard AND persist AND respect the minimum hold."""
    p = Params()
    state = _state_with_vol()          # session median |ofi_50| = 100
    pos = _pos()
    # adverse and hard, but only 10 minutes in and for a single instant
    row = base_row(
        timestamp=pos.entry_ts + 600.0, underlying_ltp=23405.0, underlying_ofi_50=-400.0
    )
    assert evaluate_exit(row, pos, p, state=state) is None
    assert pos.adverse_since == row["timestamp"]


def test_flow_flip_fires_once_it_persists():
    p = Params()
    state = _state_with_vol()
    pos = _pos()
    t0 = pos.entry_ts + 600.0
    r1 = base_row(timestamp=t0, underlying_ltp=23405.0, underlying_ofi_50=-400.0)
    assert evaluate_exit(r1, pos, p, state=state) is None
    r2 = base_row(timestamp=t0 + p.flow_flip_confirm_sec + 1, underlying_ltp=23405.0, underlying_ofi_50=-400.0)
    assert evaluate_exit(r2, pos, p, state=state) == "flow_flip"


def test_flow_flip_resets_when_pressure_relents():
    p = Params()
    state = _state_with_vol()
    pos = _pos()
    t0 = pos.entry_ts + 600.0
    evaluate_exit(base_row(timestamp=t0, underlying_ltp=23405.0, underlying_ofi_50=-400.0), pos, p, state=state)
    assert pos.adverse_since is not None
    # pressure eases -> the clock resets
    evaluate_exit(base_row(timestamp=t0 + 10, underlying_ltp=23405.0, underlying_ofi_50=50.0), pos, p, state=state)
    assert pos.adverse_since is None


def test_flow_flip_cannot_fire_inside_the_minimum_hold():
    p = Params()
    state = _state_with_vol()
    pos = _pos()
    row = base_row(timestamp=pos.entry_ts + 60.0, underlying_ltp=23405.0, underlying_ofi_50=-9999.0)
    assert evaluate_exit(row, pos, p, state=state) is None


def test_eod_beats_everything():
    pos = _pos()
    assert evaluate_exit(base_row(), pos, Params(), state=_state_with_vol(), eod=True) == "eod"


# ── charges ──────────────────────────────────────────────────────────────


def test_charges_match_production_rates():
    """Buy 100 x 65 = 6500, sell 120 x 65 = 7800.

    brokerage 40 | exch 0.03553% of 14300 = 5.08 | STT 0.15% of 7800 = 12
    GST 18% of 45.08 = 8.11 | SEBI 0.0001% of 14300 = 0.01 | stamp 0.003% of 6500 = 0
    """
    got = round_trip_charges(6500.0, 7800.0, "NSE")
    assert got == pytest.approx(40 + 5.08 + 12 + 8.11 + 0.01 + 0.0, abs=0.05)


def test_charges_scale_with_turnover():
    small = round_trip_charges(6500.0, 7800.0)
    big = round_trip_charges(65000.0, 78000.0)
    assert big > small * 2
