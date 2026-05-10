"""Tests for features/levels.py — Wave 1 S/R features."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.levels import compute_level_features


# ── Helpers ────────────────────────────────────────────────────────────────


def _row(strike: int, call_oi: float = 0, put_oi: float = 0) -> dict:
    return {"strike": strike, "callOI": call_oi, "putOI": put_oi}


def _all_nan(out: dict, keys: list[str]) -> bool:
    return all(math.isnan(out[k]) for k in keys)


# ── OHLC distance features ────────────────────────────────────────────────


def test_distance_below_day_high_is_negative():
    out = compute_level_features(spot=100.0, day_high=110.0, day_low=90.0, prev_close=95.0, chain_rows=None)
    assert out["distance_to_day_high_pct"] == pytest.approx((100 - 110) / 110 * 100)
    assert out["distance_to_day_high_pct"] < 0


def test_distance_above_day_low_is_positive():
    out = compute_level_features(spot=100.0, day_high=110.0, day_low=90.0, prev_close=95.0, chain_rows=None)
    assert out["distance_to_day_low_pct"] == pytest.approx((100 - 90) / 90 * 100)
    assert out["distance_to_day_low_pct"] > 0


def test_distance_to_prev_close_signed_correctly():
    out_up = compute_level_features(100, 110, 90, 95, None)
    out_dn = compute_level_features(90, 110, 90, 95, None)
    assert out_up["distance_to_prev_close_pct"] > 0
    assert out_dn["distance_to_prev_close_pct"] < 0


def test_day_range_position_at_low_is_zero():
    out = compute_level_features(spot=90.0, day_high=110.0, day_low=90.0, prev_close=95.0, chain_rows=None)
    assert out["day_range_position"] == pytest.approx(0.0)


def test_day_range_position_at_high_is_one():
    out = compute_level_features(spot=110.0, day_high=110.0, day_low=90.0, prev_close=95.0, chain_rows=None)
    assert out["day_range_position"] == pytest.approx(1.0)


def test_day_range_position_at_mid_is_half():
    out = compute_level_features(spot=100.0, day_high=110.0, day_low=90.0, prev_close=95.0, chain_rows=None)
    assert out["day_range_position"] == pytest.approx(0.5)


def test_day_range_position_clamps_when_spot_below_low():
    """Pre-open / feed glitch where spot < day_low. Should clamp, not go negative."""
    out = compute_level_features(spot=85.0, day_high=110.0, day_low=90.0, prev_close=95.0, chain_rows=None)
    assert out["day_range_position"] == pytest.approx(0.0)


def test_day_range_position_collapsed_range_yields_nan():
    """When day_high == day_low (e.g., pre-market) the position is undefined."""
    out = compute_level_features(spot=100.0, day_high=100.0, day_low=100.0, prev_close=95.0, chain_rows=None)
    assert math.isnan(out["day_range_position"])


# ── Null rules ────────────────────────────────────────────────────────────


def test_missing_spot_yields_all_nan_distances():
    out = compute_level_features(spot=None, day_high=110, day_low=90, prev_close=95, chain_rows=None)
    keys = [
        "distance_to_day_high_pct",
        "distance_to_day_low_pct",
        "distance_to_prev_close_pct",
        "day_range_position",
    ]
    assert _all_nan(out, keys)


def test_zero_or_negative_inputs_yield_nan():
    """Broker may send 0 / negative for pre-market — must not divide by zero."""
    out = compute_level_features(spot=100, day_high=0, day_low=-1, prev_close=0, chain_rows=None)
    assert math.isnan(out["distance_to_day_high_pct"])
    assert math.isnan(out["distance_to_day_low_pct"])
    assert math.isnan(out["distance_to_prev_close_pct"])


def test_none_chain_rows_yields_oi_nan():
    out = compute_level_features(100, 110, 90, 95, chain_rows=None)
    assert math.isnan(out["max_call_oi_strike"])
    assert math.isnan(out["max_put_oi_strike"])
    assert math.isnan(out["distance_to_max_call_oi_strike_pct"])
    assert math.isnan(out["distance_to_max_put_oi_strike_pct"])


def test_empty_chain_rows_yields_oi_nan():
    out = compute_level_features(100, 110, 90, 95, chain_rows=[])
    assert math.isnan(out["max_call_oi_strike"])
    assert math.isnan(out["max_put_oi_strike"])


def test_all_zero_oi_yields_oi_nan():
    """First chain snapshot before OI ticks arrive — every row has 0 OI."""
    rows = [_row(95), _row(100), _row(105)]
    out = compute_level_features(100, 110, 90, 95, chain_rows=rows)
    assert math.isnan(out["max_call_oi_strike"])
    assert math.isnan(out["max_put_oi_strike"])


# ── OI wall identification ────────────────────────────────────────────────


def test_max_call_oi_strike_picks_highest():
    rows = [
        _row(95, call_oi=100, put_oi=2000),
        _row(100, call_oi=500, put_oi=1500),
        _row(105, call_oi=3000, put_oi=200),  # highest call OI
        _row(110, call_oi=1000, put_oi=100),
    ]
    out = compute_level_features(100, 110, 90, 95, chain_rows=rows)
    assert out["max_call_oi_strike"] == 105.0


def test_max_put_oi_strike_picks_highest():
    rows = [
        _row(95, call_oi=100, put_oi=2000),  # highest put OI
        _row(100, call_oi=500, put_oi=1500),
        _row(105, call_oi=3000, put_oi=200),
    ]
    out = compute_level_features(100, 110, 90, 95, chain_rows=rows)
    assert out["max_put_oi_strike"] == 95.0


def test_distance_to_max_call_oi_strike_signed():
    """Spot below max-call-OI strike → distance is negative (call wall is resistance above)."""
    rows = [_row(105, call_oi=3000, put_oi=200), _row(95, call_oi=100, put_oi=2000)]
    out = compute_level_features(spot=100, day_high=110, day_low=90, prev_close=95, chain_rows=rows)
    # max_call_oi_strike = 105, spot = 100 → distance = (100-105)/100*100 = -5%
    assert out["distance_to_max_call_oi_strike_pct"] == pytest.approx(-5.0)
    # max_put_oi_strike = 95 (higher put OI), spot = 100 → distance = (100-95)/100*100 = +5%
    assert out["distance_to_max_put_oi_strike_pct"] == pytest.approx(5.0)


def test_malformed_chain_row_does_not_crash():
    """Defensive: extra/missing fields shouldn't break the function."""
    rows = [
        {"strike": 100, "callOI": "garbage"},  # bad type
        _row(105, call_oi=3000, put_oi=200),  # valid
    ]
    out = compute_level_features(100, 110, 90, 95, chain_rows=rows)
    # Should NaN out the OI fields rather than throwing
    assert math.isnan(out["max_call_oi_strike"]) or out["max_call_oi_strike"] == 105.0


def test_chain_row_without_strike_is_skipped():
    rows = [
        {"callOI": 5000, "putOI": 3000},  # no strike
        _row(100, call_oi=1000, put_oi=500),
    ]
    out = compute_level_features(100, 110, 90, 95, chain_rows=rows)
    assert out["max_call_oi_strike"] == 100.0
