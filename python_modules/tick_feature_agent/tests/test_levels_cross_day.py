"""Tests for compute_cross_day_level_features in features/levels.py — B5."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.levels import compute_cross_day_level_features


# ── Helpers ────────────────────────────────────────────────────────────────


ALL_KEYS = [
    "distance_to_prev_day_high_pct",
    "distance_to_prev_day_low_pct",
    "distance_to_round_number_above_pct",
    "distance_to_round_number_below_pct",
    "distance_to_5d_swing_high_pct",
    "distance_to_5d_swing_low_pct",
]


def _all_nan(out: dict, keys: list[str]) -> bool:
    return all(math.isnan(out[k]) for k in keys)


# ── Null rules ────────────────────────────────────────────────────────────


def test_all_none_inputs_yield_all_nan():
    out = compute_cross_day_level_features(None, None, None, None, None, None)
    assert _all_nan(out, ALL_KEYS)


def test_missing_spot_yields_all_nan():
    out = compute_cross_day_level_features(
        spot=None,
        prev_day_high=24200,
        prev_day_low=23800,
        swing_5d_high=24500,
        swing_5d_low=23500,
        round_number_step=100,
    )
    assert _all_nan(out, ALL_KEYS)


def test_zero_spot_yields_all_nan():
    out = compute_cross_day_level_features(
        spot=0.0,
        prev_day_high=24200,
        prev_day_low=23800,
        swing_5d_high=24500,
        swing_5d_low=23500,
        round_number_step=100,
    )
    assert _all_nan(out, ALL_KEYS)


def test_negative_spot_yields_all_nan():
    out = compute_cross_day_level_features(
        spot=-100.0,
        prev_day_high=24200,
        prev_day_low=23800,
        swing_5d_high=24500,
        swing_5d_low=23500,
        round_number_step=100,
    )
    assert _all_nan(out, ALL_KEYS)


# ── Prev-day extremes (signs) ─────────────────────────────────────────────


def test_spot_above_prev_day_high_gives_positive_distance():
    out = compute_cross_day_level_features(
        spot=24300.0,
        prev_day_high=24200.0,
        prev_day_low=23800.0,
        swing_5d_high=24500.0,
        swing_5d_low=23500.0,
        round_number_step=100,
    )
    assert out["distance_to_prev_day_high_pct"] == pytest.approx(
        (24300 - 24200) / 24300 * 100
    )
    assert out["distance_to_prev_day_high_pct"] > 0


def test_spot_below_prev_day_low_gives_negative_distance():
    out = compute_cross_day_level_features(
        spot=23700.0,
        prev_day_high=24200.0,
        prev_day_low=23800.0,
        swing_5d_high=24500.0,
        swing_5d_low=23500.0,
        round_number_step=100,
    )
    assert out["distance_to_prev_day_low_pct"] == pytest.approx(
        (23700 - 23800) / 23700 * 100
    )
    assert out["distance_to_prev_day_low_pct"] < 0


# ── 5-day swing distances (signs) ─────────────────────────────────────────


def test_5d_swing_distances_signed_correctly():
    # Spot between the 5d swings → distance to high is negative, to low is positive.
    out = compute_cross_day_level_features(
        spot=24000.0,
        prev_day_high=24200.0,
        prev_day_low=23800.0,
        swing_5d_high=24500.0,
        swing_5d_low=23500.0,
        round_number_step=100,
    )
    assert out["distance_to_5d_swing_high_pct"] < 0
    assert out["distance_to_5d_swing_low_pct"] > 0
    assert out["distance_to_5d_swing_high_pct"] == pytest.approx(
        (24000 - 24500) / 24000 * 100
    )
    assert out["distance_to_5d_swing_low_pct"] == pytest.approx(
        (24000 - 23500) / 24000 * 100
    )


# ── Round numbers ─────────────────────────────────────────────────────────


def test_round_number_above_nifty_24123_step_100():
    """spot=24123 step=100 → above=24200, distance=(24123-24200)/24123*100 ≈ -0.319%."""
    out = compute_cross_day_level_features(
        spot=24123.0,
        prev_day_high=24200.0,
        prev_day_low=23800.0,
        swing_5d_high=24500.0,
        swing_5d_low=23500.0,
        round_number_step=100,
    )
    expected = (24123 - 24200) / 24123 * 100
    assert out["distance_to_round_number_above_pct"] == pytest.approx(expected)
    assert out["distance_to_round_number_above_pct"] < 0
    assert out["distance_to_round_number_above_pct"] == pytest.approx(-0.319, abs=1e-3)


def test_round_number_below_nifty_24123_step_100():
    """spot=24123 step=100 → below=24100, distance=(24123-24100)/24123*100 ≈ 0.0954%."""
    out = compute_cross_day_level_features(
        spot=24123.0,
        prev_day_high=24200.0,
        prev_day_low=23800.0,
        swing_5d_high=24500.0,
        swing_5d_low=23500.0,
        round_number_step=100,
    )
    expected = (24123 - 24100) / 24123 * 100
    assert out["distance_to_round_number_below_pct"] == pytest.approx(expected)
    assert out["distance_to_round_number_below_pct"] > 0
    assert out["distance_to_round_number_below_pct"] == pytest.approx(0.0954, abs=1e-3)


def test_spot_exactly_on_round_number_yields_zero_both_sides():
    out = compute_cross_day_level_features(
        spot=24000.0,
        prev_day_high=24200.0,
        prev_day_low=23800.0,
        swing_5d_high=24500.0,
        swing_5d_low=23500.0,
        round_number_step=100,
    )
    assert out["distance_to_round_number_above_pct"] == pytest.approx(0.0)
    assert out["distance_to_round_number_below_pct"] == pytest.approx(0.0)


def test_banknifty_scale_round_above():
    """BANKNIFTY-scale: spot=51234 step=1000 → above=52000."""
    out = compute_cross_day_level_features(
        spot=51234.0,
        prev_day_high=51800.0,
        prev_day_low=50800.0,
        swing_5d_high=52500.0,
        swing_5d_low=50000.0,
        round_number_step=1000,
    )
    expected_above = (51234 - 52000) / 51234 * 100
    expected_below = (51234 - 51000) / 51234 * 100
    assert out["distance_to_round_number_above_pct"] == pytest.approx(expected_above)
    assert out["distance_to_round_number_below_pct"] == pytest.approx(expected_below)


def test_naturalgas_scale_round_numbers():
    """NATURALGAS-scale: spot=247.5 step=10 → above=250, below=240."""
    out = compute_cross_day_level_features(
        spot=247.5,
        prev_day_high=250.0,
        prev_day_low=245.0,
        swing_5d_high=255.0,
        swing_5d_low=240.0,
        round_number_step=10,
    )
    expected_above = (247.5 - 250) / 247.5 * 100
    expected_below = (247.5 - 240) / 247.5 * 100
    assert out["distance_to_round_number_above_pct"] == pytest.approx(expected_above)
    assert out["distance_to_round_number_below_pct"] == pytest.approx(expected_below)


# ── round_number_step missing / invalid ───────────────────────────────────


def test_missing_round_number_step_only_round_features_nan():
    out = compute_cross_day_level_features(
        spot=24123.0,
        prev_day_high=24200.0,
        prev_day_low=23800.0,
        swing_5d_high=24500.0,
        swing_5d_low=23500.0,
        round_number_step=None,
    )
    assert math.isnan(out["distance_to_round_number_above_pct"])
    assert math.isnan(out["distance_to_round_number_below_pct"])
    assert math.isfinite(out["distance_to_prev_day_high_pct"])
    assert math.isfinite(out["distance_to_prev_day_low_pct"])
    assert math.isfinite(out["distance_to_5d_swing_high_pct"])
    assert math.isfinite(out["distance_to_5d_swing_low_pct"])


def test_negative_round_number_step_only_round_features_nan():
    out = compute_cross_day_level_features(
        spot=24123.0,
        prev_day_high=24200.0,
        prev_day_low=23800.0,
        swing_5d_high=24500.0,
        swing_5d_low=23500.0,
        round_number_step=-100,
    )
    assert math.isnan(out["distance_to_round_number_above_pct"])
    assert math.isnan(out["distance_to_round_number_below_pct"])
    assert math.isfinite(out["distance_to_prev_day_high_pct"])
    assert math.isfinite(out["distance_to_prev_day_low_pct"])
    assert math.isfinite(out["distance_to_5d_swing_high_pct"])
    assert math.isfinite(out["distance_to_5d_swing_low_pct"])


def test_zero_round_number_step_only_round_features_nan():
    out = compute_cross_day_level_features(
        spot=24123.0,
        prev_day_high=24200.0,
        prev_day_low=23800.0,
        swing_5d_high=24500.0,
        swing_5d_low=23500.0,
        round_number_step=0,
    )
    assert math.isnan(out["distance_to_round_number_above_pct"])
    assert math.isnan(out["distance_to_round_number_below_pct"])
    assert math.isfinite(out["distance_to_prev_day_high_pct"])


# ── Partial inputs: only the affected feature NaN ─────────────────────────


def test_missing_prev_day_high_only_isolates_that_feature():
    out = compute_cross_day_level_features(
        spot=24000.0,
        prev_day_high=None,
        prev_day_low=23800.0,
        swing_5d_high=24500.0,
        swing_5d_low=23500.0,
        round_number_step=100,
    )
    assert math.isnan(out["distance_to_prev_day_high_pct"])
    assert math.isfinite(out["distance_to_prev_day_low_pct"])
    assert math.isfinite(out["distance_to_5d_swing_high_pct"])
    assert math.isfinite(out["distance_to_5d_swing_low_pct"])
    assert math.isfinite(out["distance_to_round_number_above_pct"])
    assert math.isfinite(out["distance_to_round_number_below_pct"])


def test_missing_swing_5d_low_only_isolates_that_feature():
    out = compute_cross_day_level_features(
        spot=24000.0,
        prev_day_high=24200.0,
        prev_day_low=23800.0,
        swing_5d_high=24500.0,
        swing_5d_low=None,
        round_number_step=100,
    )
    assert math.isnan(out["distance_to_5d_swing_low_pct"])
    assert math.isfinite(out["distance_to_prev_day_high_pct"])
    assert math.isfinite(out["distance_to_prev_day_low_pct"])
    assert math.isfinite(out["distance_to_5d_swing_high_pct"])
    assert math.isfinite(out["distance_to_round_number_above_pct"])
    assert math.isfinite(out["distance_to_round_number_below_pct"])


def test_missing_prev_day_low_only_isolates_that_feature():
    out = compute_cross_day_level_features(
        spot=24000.0,
        prev_day_high=24200.0,
        prev_day_low=None,
        swing_5d_high=24500.0,
        swing_5d_low=23500.0,
        round_number_step=100,
    )
    assert math.isnan(out["distance_to_prev_day_low_pct"])
    assert math.isfinite(out["distance_to_prev_day_high_pct"])


def test_zero_prev_day_high_treated_as_missing():
    """Broker may send 0 for pre-market — divisor guard must NaN that feature."""
    out = compute_cross_day_level_features(
        spot=24000.0,
        prev_day_high=0.0,
        prev_day_low=23800.0,
        swing_5d_high=24500.0,
        swing_5d_low=23500.0,
        round_number_step=100,
    )
    assert math.isnan(out["distance_to_prev_day_high_pct"])
    assert math.isfinite(out["distance_to_prev_day_low_pct"])
