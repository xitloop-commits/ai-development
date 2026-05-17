"""Tests for features/greeks.py — C9 IV velocity features."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.greeks import compute_iv_velocity_features


# ── Empty / None / invalid inputs ─────────────────────────────────────────


def test_empty_history_yields_all_nan():
    out = compute_iv_velocity_features(iv_history=[], now_ts=1_000_000.0)
    assert math.isnan(out["iv_change_1min"])
    assert math.isnan(out["iv_change_5min"])
    assert math.isnan(out["iv_skew_velocity"])
    assert math.isnan(out["iv_expansion_without_spot"])


def test_none_history_yields_all_nan():
    out = compute_iv_velocity_features(iv_history=None, now_ts=1_000_000.0)
    assert math.isnan(out["iv_change_1min"])
    assert math.isnan(out["iv_change_5min"])
    assert math.isnan(out["iv_skew_velocity"])
    assert math.isnan(out["iv_expansion_without_spot"])


def test_none_now_ts_yields_all_nan():
    history = [(1_000_000.0, 0.18, 0.18, 24000.0)]
    out = compute_iv_velocity_features(iv_history=history, now_ts=None)
    assert math.isnan(out["iv_change_1min"])
    assert math.isnan(out["iv_change_5min"])
    assert math.isnan(out["iv_skew_velocity"])
    assert math.isnan(out["iv_expansion_without_spot"])


def test_nan_now_ts_yields_all_nan():
    history = [(1_000_000.0, 0.18, 0.18, 24000.0)]
    out = compute_iv_velocity_features(iv_history=history, now_ts=float("nan"))
    assert math.isnan(out["iv_change_1min"])
    assert math.isnan(out["iv_change_5min"])
    assert math.isnan(out["iv_skew_velocity"])
    assert math.isnan(out["iv_expansion_without_spot"])


def test_string_now_ts_yields_all_nan():
    history = [(1_000_000.0, 0.18, 0.18, 24000.0)]
    out = compute_iv_velocity_features(iv_history=history, now_ts="not-a-number")  # type: ignore[arg-type]
    assert math.isnan(out["iv_change_1min"])
    assert math.isnan(out["iv_change_5min"])
    assert math.isnan(out["iv_skew_velocity"])
    assert math.isnan(out["iv_expansion_without_spot"])


def test_single_sample_no_baseline_all_nan():
    """With only a current sample, no 1- or 5-min baseline exists."""
    now = 1_000_000.0
    history = [(now - 1, 0.18, 0.17, 24000.0)]
    out = compute_iv_velocity_features(iv_history=history, now_ts=now)
    assert math.isnan(out["iv_change_1min"])
    assert math.isnan(out["iv_change_5min"])
    assert math.isnan(out["iv_skew_velocity"])
    assert math.isnan(out["iv_expansion_without_spot"])


def test_future_only_samples_yield_all_nan():
    """Samples after now_ts give no current → all NaN."""
    now = 1_000_000.0
    history = [
        (now + 10, 0.18, 0.17, 24000.0),
        (now + 20, 0.19, 0.18, 24010.0),
    ]
    out = compute_iv_velocity_features(iv_history=history, now_ts=now)
    assert math.isnan(out["iv_change_1min"])
    assert math.isnan(out["iv_change_5min"])
    assert math.isnan(out["iv_skew_velocity"])
    assert math.isnan(out["iv_expansion_without_spot"])


# ── 1-min lookback ────────────────────────────────────────────────────────


def test_iv_change_1min_with_baseline_30s_past_target():
    """Baseline 30s past the 1-min target (i.e. 90s ago) → within 60s tolerance."""
    now = 1_000_000.0
    history = [
        (now - 90, 0.18, 0.17, 24000.0),  # 30s past (now-60) target — OK
        (now - 1, 0.20, 0.17, 24000.0),
    ]
    out = compute_iv_velocity_features(iv_history=history, now_ts=now)
    # 0.20 - 0.18 = 0.02
    assert out["iv_change_1min"] == pytest.approx(0.02)


def test_iv_change_1min_baseline_beyond_tolerance_yields_nan():
    """Baseline 90s past the 1-min target → outside 60s tolerance → NaN."""
    now = 1_000_000.0
    history = [
        (now - 150, 0.18, 0.17, 24000.0),  # 90s past (now-60) target — too stale
        (now - 1, 0.20, 0.17, 24000.0),
    ]
    out = compute_iv_velocity_features(iv_history=history, now_ts=now)
    assert math.isnan(out["iv_change_1min"])


# ── 5-min lookback ────────────────────────────────────────────────────────


def test_iv_change_5min_with_baseline_30s_past_target():
    """Baseline 30s past the 5-min target (i.e. 330s ago) → within tolerance."""
    now = 1_000_000.0
    history = [
        (now - 330, 0.16, 0.17, 24000.0),  # 30s past (now-300) target — OK
        (now - 1, 0.20, 0.17, 24000.0),
    ]
    out = compute_iv_velocity_features(iv_history=history, now_ts=now)
    # 0.20 - 0.16 = 0.04
    assert out["iv_change_5min"] == pytest.approx(0.04)


def test_iv_change_5min_baseline_beyond_tolerance_yields_nan():
    """Baseline 90s past the 5-min target → outside 60s tolerance → NaN.

    With the 5-min baseline stale, iv_skew_velocity and
    iv_expansion_without_spot are also NaN.
    """
    now = 1_000_000.0
    history = [
        (now - 400, 0.16, 0.17, 24000.0),  # 100s past (now-300) target — too stale
        (now - 1, 0.20, 0.18, 24500.0),
    ]
    out = compute_iv_velocity_features(iv_history=history, now_ts=now)
    assert math.isnan(out["iv_change_5min"])
    assert math.isnan(out["iv_skew_velocity"])
    assert math.isnan(out["iv_expansion_without_spot"])


def test_rising_ce_iv_gives_positive_iv_change_5min():
    now = 1_000_000.0
    history = [
        (now - 300, 0.15, 0.16, 24000.0),
        (now - 1, 0.22, 0.16, 24000.0),
    ]
    out = compute_iv_velocity_features(iv_history=history, now_ts=now)
    assert out["iv_change_5min"] > 0
    assert out["iv_change_5min"] == pytest.approx(0.07)


# ── Skew velocity ─────────────────────────────────────────────────────────


def test_iv_skew_velocity_negative_when_pe_falls_with_ce_flat():
    """PE IV down with CE flat → put-skew compression → skew velocity < 0."""
    now = 1_000_000.0
    history = [
        (now - 300, 0.18, 0.22, 24000.0),  # baseline skew = +0.04
        (now - 1, 0.18, 0.19, 24000.0),    # current skew = +0.01
    ]
    out = compute_iv_velocity_features(iv_history=history, now_ts=now)
    # Δ skew = (0.19 - 0.18) - (0.22 - 0.18) = 0.01 - 0.04 = -0.03
    assert out["iv_skew_velocity"] == pytest.approx(-0.03)
    assert out["iv_skew_velocity"] < 0


# ── iv_expansion_without_spot ─────────────────────────────────────────────


def test_iv_expansion_without_spot_two_pct_spot_two_pct_iv():
    """Spot +2% with IV +0.02 → expansion = 0.02 / 2.0 = 0.01."""
    now = 1_000_000.0
    history = [
        (now - 300, 0.18, 0.18, 24000.0),
        (now - 1, 0.20, 0.20, 24480.0),  # spot +2.0%, CE & PE +0.02
    ]
    out = compute_iv_velocity_features(iv_history=history, now_ts=now)
    assert out["iv_expansion_without_spot"] == pytest.approx(0.01)


def test_iv_expansion_without_spot_tiny_spot_move_yields_nan():
    """|Δspot %| < 0.05% → ratio undefined regardless of IV move."""
    now = 1_000_000.0
    history = [
        (now - 300, 0.18, 0.18, 24000.0),
        # spot +0.01% = 2.4 ticks — well below the 0.05% threshold
        (now - 1, 0.25, 0.25, 24000.0 * (1 + 0.0001)),
    ]
    out = compute_iv_velocity_features(iv_history=history, now_ts=now)
    assert math.isnan(out["iv_expansion_without_spot"])
    # Other 5-min features should still compute fine.
    assert out["iv_change_5min"] == pytest.approx(0.07)


def test_iv_expansion_uses_max_of_ce_and_pe_magnitudes():
    """Big PE expansion + tiny CE expansion → MAX dominates the ratio."""
    now = 1_000_000.0
    history = [
        (now - 300, 0.18, 0.18, 24000.0),
        # spot +1.0% (240 → 24240), CE +0.001 (tiny), PE +0.05 (big)
        (now - 1, 0.181, 0.23, 24240.0),
    ]
    out = compute_iv_velocity_features(iv_history=history, now_ts=now)
    # Expansion uses max(|0.001|, |0.05|) = 0.05; |Δspot %| = 1.0
    # → 0.05 / 1.0 = 0.05
    assert out["iv_expansion_without_spot"] == pytest.approx(0.05)


# ── History hygiene ───────────────────────────────────────────────────────


def test_nan_iv_rows_in_history_are_skipped():
    """A row with NaN CE IV is skipped; older valid rows still considered."""
    now = 1_000_000.0
    history = [
        (now - 305, 0.16, 0.17, 24000.0),               # valid 5-min baseline
        (now - 65, 0.17, 0.17, 24000.0),                # valid 1-min baseline
        (now - 30, float("nan"), 0.19, 24100.0),        # corrupt → skipped
        (now - 1, 0.20, 0.18, 24200.0),                 # current
    ]
    out = compute_iv_velocity_features(iv_history=history, now_ts=now)
    # current.ce = 0.20, base_1m.ce = 0.17 → 0.03
    assert out["iv_change_1min"] == pytest.approx(0.03)
    # current.ce - base_5m.ce = 0.20 - 0.16 = 0.04
    assert out["iv_change_5min"] == pytest.approx(0.04)


def test_out_of_order_rows_behavior_is_list_order_dependent():
    """Documents the at-or-before scan's list-order dependence.

    The function walks `reversed(iv_history)` — i.e. last-appended first,
    NOT newest-by-ts first. That matches india_vix.py / dealer_hedging.py.
    Callers (tick_processor) are expected to append in time order; this
    test pins the behavior when the contract is violated.

    Concretely: with the (now-305) row appended LAST, the reverse scan
    visits it first. Since (now-305) ≤ now it becomes "current"; the
    SAME row also satisfies the 5-min target (now-305 ≤ now-300, within
    tolerance) and becomes the baseline. current and baseline collapse
    to the same row → delta = 0.0 (NOT NaN, and not the "true" 0.04).

    This documents the contract: oldest-→-newest ordering is REQUIRED
    for correctness. The function is robust against missing / corrupt
    rows but NOT against arbitrary reordering.
    """
    now = 1_000_000.0
    history = [
        # Misordered: the older-by-ts sample is appended LAST.
        (now - 1, 0.20, 0.18, 24200.0),
        (now - 305, 0.16, 0.17, 24000.0),
    ]
    out = compute_iv_velocity_features(iv_history=history, now_ts=now)
    # Reverse-scan collapses both current and baseline onto the
    # last-appended row → spurious zero delta.
    assert out["iv_change_5min"] == pytest.approx(0.0)

    # Sanity: when properly ordered (oldest → newest), the same data
    # yields the expected 5-min delta.
    ordered_history = list(reversed(history))
    out_ok = compute_iv_velocity_features(iv_history=ordered_history, now_ts=now)
    assert out_ok["iv_change_5min"] == pytest.approx(0.04)
