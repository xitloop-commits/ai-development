"""Tests for features/exhaustion.py — C5 trend-exhaustion features."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.bars import Bar
from tick_feature_agent.features.exhaustion import (
    ExhaustionState,
    compute_exhaustion_features,
)


def _bar(close: float = 100.0,
         high: float | None = None,
         low: float | None = None,
         volume: float = 1000.0) -> Bar:
    h = high if high is not None else close + 1
    l = low if low is not None else close - 1
    return Bar(start_ts=0.0, open=close, high=h, low=l, close=close,
               volume=volume, tick_count=1)


# ── trend_age_ticks via state ─────────────────────────────────────────────


def test_none_state_yields_nan_trend_age():
    out = compute_exhaustion_features(state=None, bars_5m=None)
    assert math.isnan(out["trend_age_ticks"])


def test_fresh_state_yields_nan_trend_age_before_any_update():
    state = ExhaustionState()
    out = compute_exhaustion_features(state=state, bars_5m=None)
    # We haven't observed any regime yet → can't tell "no trend" from
    # "no data". Emit NaN.
    assert math.isnan(out["trend_age_ticks"])


def test_initial_non_trend_tick_reports_zero():
    state = ExhaustionState()
    state.update("range")
    out = compute_exhaustion_features(state=state, bars_5m=None)
    assert out["trend_age_ticks"] == 0.0


def test_five_consecutive_trend_updates_yield_age_five():
    state = ExhaustionState()
    for _ in range(5):
        state.update("trend")
    out = compute_exhaustion_features(state=state, bars_5m=None)
    assert out["trend_age_ticks"] == 5.0


def test_transition_into_trend_resets_then_counts_one():
    state = ExhaustionState()
    state.update("range")        # age 0
    state.update("trend")        # fresh entry → age 1 (not 0, not 2)
    out = compute_exhaustion_features(state=state, bars_5m=None)
    assert out["trend_age_ticks"] == 1.0


def test_range_and_chop_do_not_increment():
    state = ExhaustionState()
    state.update("range")
    state.update("chop")
    state.update("range")
    state.update("chop")
    out = compute_exhaustion_features(state=state, bars_5m=None)
    assert out["trend_age_ticks"] == 0.0


def test_trend_strong_counts_same_as_trend():
    state = ExhaustionState()
    state.update("trend_strong")        # fresh entry → 1
    state.update("trend_strong")        # → 2
    state.update("trend")               # same family → 3 (no reset)
    state.update("trend_strong")        # → 4
    out = compute_exhaustion_features(state=state, bars_5m=None)
    assert out["trend_age_ticks"] == 4.0


def test_flipping_out_of_trend_resets_counter():
    state = ExhaustionState()
    for _ in range(7):
        state.update("trend")
    state.update("range")    # leaves trend → counter snaps to 0
    out = compute_exhaustion_features(state=state, bars_5m=None)
    assert out["trend_age_ticks"] == 0.0


def test_flipping_back_into_trend_starts_fresh():
    state = ExhaustionState()
    for _ in range(7):
        state.update("trend")
    state.update("range")
    state.update("trend")   # fresh entry → 1, NOT 8
    out = compute_exhaustion_features(state=state, bars_5m=None)
    assert out["trend_age_ticks"] == 1.0


def test_reset_zeroes_counter_and_clears_prev_regime():
    state = ExhaustionState()
    for _ in range(4):
        state.update("trend")
    state.reset()
    # After reset, state is indistinguishable from a fresh one.
    assert state.trend_age_ticks == 0
    assert state.prev_regime_tag is None
    assert state.has_seen_tick is False
    out = compute_exhaustion_features(state=state, bars_5m=None)
    assert math.isnan(out["trend_age_ticks"])
    # And a subsequent trend update lands at 1 (fresh entry), not 5.
    state.update("trend")
    out = compute_exhaustion_features(state=state, bars_5m=None)
    assert out["trend_age_ticks"] == 1.0


# ── volume_no_move_score via bars ─────────────────────────────────────────


def test_volume_no_move_nan_when_fewer_than_11_bars():
    bars = [_bar() for _ in range(10)]
    out = compute_exhaustion_features(state=None, bars_5m=bars)
    assert math.isnan(out["volume_no_move_score"])


def test_volume_no_move_one_when_uniform_bars():
    # 11 bars: 10 baseline + 1 current, all identical → score ≈ 1.
    bars = [_bar(close=100.0, high=101.0, low=99.0, volume=1000.0)
            for _ in range(11)]
    out = compute_exhaustion_features(state=None, bars_5m=bars)
    assert out["volume_no_move_score"] == pytest.approx(1.0)


def test_volume_no_move_high_for_tight_range_high_volume_current_bar():
    # Baseline 10 bars: wide range (2), moderate volume (1000) → intensity 500.
    bars = [_bar(close=100.0, high=101.0, low=99.0, volume=1000.0)
            for _ in range(10)]
    # Current bar: TIGHT range (0.2) + HIGH volume (5000) → intensity 25000.
    # Expected score = 25000 / 500 = 50.
    bars.append(_bar(close=100.0, high=100.1, low=99.9, volume=5000.0))
    out = compute_exhaustion_features(state=None, bars_5m=bars)
    assert out["volume_no_move_score"] == pytest.approx(50.0)
    assert out["volume_no_move_score"] > 1.0  # the exhaustion signal


def test_volume_no_move_below_one_for_wide_range_average_volume_current_bar():
    # Baseline: tight range (0.2), moderate volume (1000) → intensity 5000.
    bars = [_bar(close=100.0, high=100.1, low=99.9, volume=1000.0)
            for _ in range(10)]
    # Current: WIDE range (4) + same volume → intensity 250. Score = 0.05.
    bars.append(_bar(close=100.0, high=102.0, low=98.0, volume=1000.0))
    out = compute_exhaustion_features(state=None, bars_5m=bars)
    assert out["volume_no_move_score"] < 1.0
    assert out["volume_no_move_score"] == pytest.approx(0.05)


def test_volume_no_move_handles_zero_range_baseline_bar():
    # One baseline bar with zero range — the 1e-9 floor must keep us
    # finite (without it, division by zero would crash or produce inf).
    bars = [_bar(close=100.0, high=101.0, low=99.0, volume=1000.0)
            for _ in range(9)]
    bars.append(_bar(close=100.0, high=100.0, low=100.0, volume=0.0))  # zero range, zero vol
    bars.append(_bar(close=100.0, high=101.0, low=99.0, volume=1000.0))  # current
    out = compute_exhaustion_features(state=None, bars_5m=bars)
    # Must be finite and positive — no crash from the zero-range bar.
    assert math.isfinite(out["volume_no_move_score"])
    assert out["volume_no_move_score"] > 0.0


def test_volume_no_move_handles_zero_range_current_bar():
    # 10 baseline bars normal; current bar pinned at one price with high volume.
    bars = [_bar(close=100.0, high=101.0, low=99.0, volume=1000.0)
            for _ in range(10)]
    bars.append(_bar(close=100.0, high=100.0, low=100.0, volume=2000.0))  # zero range
    out = compute_exhaustion_features(state=None, bars_5m=bars)
    # Zero-range current bar with positive volume → intensity floored to
    # vol / 1e-9 = a huge number → score is huge but finite.
    assert math.isfinite(out["volume_no_move_score"])
    assert out["volume_no_move_score"] > 1.0


# ── End-to-end sanity: keys present even on empty inputs ──────────────────


def test_all_keys_present_on_empty_inputs():
    out = compute_exhaustion_features(state=None, bars_5m=None)
    assert set(out.keys()) == {"trend_age_ticks", "volume_no_move_score"}
    for v in out.values():
        assert math.isnan(v)
