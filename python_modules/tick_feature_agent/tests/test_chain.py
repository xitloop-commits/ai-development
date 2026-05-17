"""Tests for features/chain.py — C1 OI-weighted levels + PCR slope."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.chain import (
    compute_oi_weighted_levels,
    compute_pcr_slope,
)


def _row(strike: float, c_oi: float = 0, p_oi: float = 0) -> dict:
    return {"strike": strike, "callOI": c_oi, "putOI": p_oi}


# ── compute_oi_weighted_levels ────────────────────────────────────────────


def test_levels_none_chain_yields_nan():
    out = compute_oi_weighted_levels(None)
    assert math.isnan(out["oi_weighted_ce_resistance_strike"])
    assert math.isnan(out["oi_weighted_pe_support_strike"])


def test_levels_empty_chain_yields_nan():
    out = compute_oi_weighted_levels([])
    assert math.isnan(out["oi_weighted_ce_resistance_strike"])
    assert math.isnan(out["oi_weighted_pe_support_strike"])


def test_levels_uniform_oi_centers_at_midpoint():
    rows = [_row(k, c_oi=100, p_oi=100) for k in range(23000, 25001, 100)]
    out = compute_oi_weighted_levels(rows)
    # Uniform weighting → both averages equal the strike mean (24000).
    assert out["oi_weighted_ce_resistance_strike"] == pytest.approx(24000.0)
    assert out["oi_weighted_pe_support_strike"] == pytest.approx(24000.0)


def test_levels_call_oi_concentrated_pulls_resistance_up():
    rows = [
        _row(23500, c_oi=100, p_oi=0),
        _row(24000, c_oi=100, p_oi=0),
        _row(24500, c_oi=2000, p_oi=0),  # heavy CE here
    ]
    out = compute_oi_weighted_levels(rows)
    assert out["oi_weighted_ce_resistance_strike"] > 24300


def test_levels_put_oi_concentrated_pulls_support_down():
    rows = [
        _row(23500, c_oi=0, p_oi=2000),  # heavy PE here
        _row(24000, c_oi=0, p_oi=100),
        _row(24500, c_oi=0, p_oi=100),
    ]
    out = compute_oi_weighted_levels(rows)
    assert out["oi_weighted_pe_support_strike"] < 23700


def test_levels_nan_per_side_when_no_oi_on_that_side():
    rows = [_row(24000, c_oi=1000, p_oi=0)]
    out = compute_oi_weighted_levels(rows)
    assert math.isfinite(out["oi_weighted_ce_resistance_strike"])
    assert math.isnan(out["oi_weighted_pe_support_strike"])


def test_levels_skips_malformed_rows_without_crashing():
    rows = [
        _row(24000, c_oi=1000, p_oi=1000),
        {"strike": "junk", "callOI": 100, "putOI": 100},
        {"callOI": 100, "putOI": 100},                   # no strike
        {"strike": 24500, "callOI": "abc", "putOI": "x"},  # bad OI types
        "not-a-dict",
        _row(25000, c_oi=2000, p_oi=2000),
    ]
    out = compute_oi_weighted_levels(rows)
    # Should compute from the 2 valid rows only.
    expected = (24000 * 1000 + 25000 * 2000) / (1000 + 2000)
    assert out["oi_weighted_ce_resistance_strike"] == pytest.approx(expected)
    assert out["oi_weighted_pe_support_strike"] == pytest.approx(expected)


def test_levels_zero_strike_skipped():
    rows = [
        _row(0, c_oi=1000, p_oi=1000),     # invalid strike
        _row(24000, c_oi=500, p_oi=500),
    ]
    out = compute_oi_weighted_levels(rows)
    assert out["oi_weighted_ce_resistance_strike"] == pytest.approx(24000.0)


# ── compute_pcr_slope ─────────────────────────────────────────────────────


def test_slope_none_history_yields_nan():
    out = compute_pcr_slope(None, now_ts=1_000_000.0)
    assert math.isnan(out["pcr_intraday_slope_30min"])


def test_slope_none_now_ts_yields_nan():
    out = compute_pcr_slope([(1_000_000.0, 0.9)], now_ts=None)
    assert math.isnan(out["pcr_intraday_slope_30min"])


def test_slope_single_sample_yields_nan():
    out = compute_pcr_slope([(1_000_000.0, 0.9)], now_ts=1_000_000.0)
    assert math.isnan(out["pcr_intraday_slope_30min"])


def test_slope_steadily_rising_pcr_is_positive():
    """PCR rises 0.10 over 10 min → slope ≈ +0.01/min."""
    now = 1_000_000.0
    history = [(now - 600 + i * 60, 0.80 + i * 0.01) for i in range(11)]
    out = compute_pcr_slope(history, now_ts=now)
    assert out["pcr_intraday_slope_30min"] == pytest.approx(0.01, rel=1e-6)


def test_slope_steadily_falling_pcr_is_negative():
    now = 1_000_000.0
    history = [(now - 600 + i * 60, 1.20 - i * 0.02) for i in range(11)]
    out = compute_pcr_slope(history, now_ts=now)
    assert out["pcr_intraday_slope_30min"] == pytest.approx(-0.02, rel=1e-6)


def test_slope_flat_pcr_is_zero():
    now = 1_000_000.0
    history = [(now - 600 + i * 60, 0.95) for i in range(11)]
    out = compute_pcr_slope(history, now_ts=now)
    assert out["pcr_intraday_slope_30min"] == pytest.approx(0.0, abs=1e-12)


def test_slope_ignores_samples_older_than_30min():
    """Only samples within the last 30 min count."""
    now = 1_000_000.0
    history = [
        (now - 7200, 0.10),  # 2 hrs ago — must be ignored
        (now - 5400, 0.20),  # 90 min ago — ignored
        (now - 1500, 0.90),  # 25 min — counted
        (now - 600, 0.95),   # 10 min — counted
        (now - 1, 1.00),     # now — counted
    ]
    out = compute_pcr_slope(history, now_ts=now)
    # Slope from the 3 in-window samples should be small positive,
    # not the steep +1.0 PCR/hr the 4-yr stretch would give if uncut.
    assert math.isfinite(out["pcr_intraday_slope_30min"])
    assert 0.0 < out["pcr_intraday_slope_30min"] < 0.05


def test_slope_ignores_future_samples():
    now = 1_000_000.0
    history = [
        (now - 600, 0.80),
        (now - 1, 0.95),
        (now + 60, 99.0),  # future — ignored
    ]
    out = compute_pcr_slope(history, now_ts=now)
    # Slope should reflect (0.95-0.80)/599s * 60s ≈ +0.015/min, NOT
    # the absurd jump the future sample would produce.
    assert out["pcr_intraday_slope_30min"] == pytest.approx(0.15 / 599 * 60.0, rel=1e-6)


def test_slope_skips_nan_pcr_samples():
    now = 1_000_000.0
    history = [
        (now - 600, 0.80),
        (now - 300, float("nan")),  # corrupt — skipped
        (now - 1, 1.00),
    ]
    out = compute_pcr_slope(history, now_ts=now)
    assert math.isfinite(out["pcr_intraday_slope_30min"])
    # Two valid samples 599s apart, Δ=0.20 → 0.20/599*60 ≈ 0.02 /min
    assert out["pcr_intraday_slope_30min"] == pytest.approx(0.20 / 599 * 60.0, rel=1e-6)


def test_slope_all_same_timestamp_yields_nan():
    history = [(1_000_000.0, 0.9), (1_000_000.0, 1.0)]
    out = compute_pcr_slope(history, now_ts=1_000_000.0)
    assert math.isnan(out["pcr_intraday_slope_30min"])
