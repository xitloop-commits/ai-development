"""Tests for features/opening_range.py — B5 opening-range features."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.opening_range import (
    OpeningRangeState,
    compute_opening_range_features,
)


# ── State configuration ───────────────────────────────────────────────────


def test_unconfigured_state_yields_nan():
    state = OpeningRangeState()
    out = compute_opening_range_features(state, spot=100.0, now_ts=1_000_000.0)
    assert math.isnan(out["distance_to_opening_range_high_pct"])
    assert math.isnan(out["distance_to_opening_range_low_pct"])


def test_none_state_yields_nan():
    out = compute_opening_range_features(None, spot=100.0, now_ts=1_000_000.0)
    assert math.isnan(out["distance_to_opening_range_high_pct"])


def test_configure_with_invalid_ts_raises():
    state = OpeningRangeState()
    with pytest.raises(ValueError):
        state.configure(window_end_ts=float("nan"))
    with pytest.raises(ValueError):
        state.configure(window_end_ts=None)  # type: ignore[arg-type]


def test_configure_resets_extremes():
    state = OpeningRangeState()
    state.configure(window_end_ts=1_000_900.0)
    state.update(ts=1_000_000.0, ltp=100.0)
    state.update(ts=1_000_100.0, ltp=105.0)
    assert state.or_high == 105.0
    # Re-configure for new session → extremes clear.
    state.configure(window_end_ts=2_000_900.0)
    assert state.or_high is None
    assert state.or_low is None


# ── During forming window ─────────────────────────────────────────────────


def test_forming_window_yields_nan_even_with_ticks():
    state = OpeningRangeState()
    state.configure(window_end_ts=1_000_900.0)  # window ends at 1_000_900
    state.update(ts=1_000_000.0, ltp=100.0)
    state.update(ts=1_000_100.0, ltp=105.0)
    # now_ts still inside the window
    out = compute_opening_range_features(state, spot=103.0, now_ts=1_000_200.0)
    assert math.isnan(out["distance_to_opening_range_high_pct"])
    assert math.isnan(out["distance_to_opening_range_low_pct"])


# ── After window locks ────────────────────────────────────────────────────


def test_features_zero_when_spot_at_or_high():
    state = OpeningRangeState()
    state.configure(window_end_ts=1_000_900.0)
    state.update(ts=1_000_000.0, ltp=100.0)
    state.update(ts=1_000_100.0, ltp=110.0)  # high
    state.update(ts=1_000_200.0, ltp=95.0)   # low
    out = compute_opening_range_features(state, spot=110.0, now_ts=1_001_000.0)
    assert out["distance_to_opening_range_high_pct"] == pytest.approx(0.0)


def test_features_positive_above_high_negative_below_low():
    state = OpeningRangeState()
    state.configure(window_end_ts=1_000_900.0)
    state.update(ts=1_000_000.0, ltp=100.0)
    state.update(ts=1_000_100.0, ltp=110.0)  # high
    state.update(ts=1_000_200.0, ltp=95.0)   # low
    # Spot above the OR high
    out_above = compute_opening_range_features(state, spot=115.0, now_ts=1_001_000.0)
    assert out_above["distance_to_opening_range_high_pct"] > 0
    assert out_above["distance_to_opening_range_low_pct"] > 0
    # Spot below the OR low
    out_below = compute_opening_range_features(state, spot=90.0, now_ts=1_001_000.0)
    assert out_below["distance_to_opening_range_high_pct"] < 0
    assert out_below["distance_to_opening_range_low_pct"] < 0


def test_distance_uses_spot_as_denominator():
    state = OpeningRangeState()
    state.configure(window_end_ts=1_000_900.0)
    state.update(ts=1_000_000.0, ltp=100.0)
    state.update(ts=1_000_100.0, ltp=110.0)
    out = compute_opening_range_features(state, spot=120.0, now_ts=1_001_000.0)
    # (120 - 110)/120 * 100 = 8.333...
    assert out["distance_to_opening_range_high_pct"] == pytest.approx((120 - 110) / 120 * 100)


# ── Tick window guard ─────────────────────────────────────────────────────


def test_tick_at_window_end_is_excluded():
    state = OpeningRangeState()
    state.configure(window_end_ts=1_000_900.0)
    state.update(ts=1_000_000.0, ltp=100.0)
    # Exactly at end_ts — should NOT update extremes (window is [start, end))
    state.update(ts=1_000_900.0, ltp=200.0)
    assert state.or_high == 100.0


def test_tick_after_window_end_ignored():
    state = OpeningRangeState()
    state.configure(window_end_ts=1_000_900.0)
    state.update(ts=1_000_000.0, ltp=100.0)
    state.update(ts=1_000_950.0, ltp=300.0)  # past window — ignored
    out = compute_opening_range_features(state, spot=110.0, now_ts=1_001_000.0)
    assert state.or_high == 100.0  # unchanged
    assert out["distance_to_opening_range_high_pct"] == pytest.approx(
        (110 - 100) / 110 * 100
    )


def test_no_in_window_tick_yields_nan_post_window():
    state = OpeningRangeState()
    state.configure(window_end_ts=1_000_900.0)
    # No tick before window_end_ts — first tick after the window doesn't count.
    state.update(ts=1_000_950.0, ltp=200.0)
    out = compute_opening_range_features(state, spot=200.0, now_ts=1_001_000.0)
    assert math.isnan(out["distance_to_opening_range_high_pct"])
    assert math.isnan(out["distance_to_opening_range_low_pct"])


# ── Bad input handling ────────────────────────────────────────────────────


def test_invalid_tick_ltp_ignored():
    state = OpeningRangeState()
    state.configure(window_end_ts=1_000_900.0)
    state.update(ts=1_000_000.0, ltp=100.0)
    state.update(ts=1_000_100.0, ltp=float("nan"))
    state.update(ts=1_000_200.0, ltp=-50.0)
    state.update(ts=1_000_300.0, ltp=0.0)
    assert state.or_high == 100.0
    assert state.or_low == 100.0


def test_compute_with_invalid_spot_yields_nan():
    state = OpeningRangeState()
    state.configure(window_end_ts=1_000_900.0)
    state.update(ts=1_000_000.0, ltp=100.0)
    out = compute_opening_range_features(state, spot=None, now_ts=1_001_000.0)
    assert math.isnan(out["distance_to_opening_range_high_pct"])


# ── reset ─────────────────────────────────────────────────────────────────


def test_reset_clears_everything():
    state = OpeningRangeState()
    state.configure(window_end_ts=1_000_900.0)
    state.update(ts=1_000_000.0, ltp=100.0)
    state.reset()
    assert state.window_end_ts is None
    assert state.or_high is None
    out = compute_opening_range_features(state, spot=100.0, now_ts=1_001_000.0)
    assert math.isnan(out["distance_to_opening_range_high_pct"])
