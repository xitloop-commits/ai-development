"""Tests for features/chain.py — C1 wall-strength + OI-delta features."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.chain import (
    compute_oi_change_deltas,
    compute_wall_strength,
)


def _row(strike: float, c_oi: float = 0, p_oi: float = 0) -> dict:
    return {"strike": strike, "callOI": c_oi, "putOI": p_oi}


# ── compute_wall_strength ─────────────────────────────────────────────────


def test_wall_strength_none_chain_yields_nan():
    out = compute_wall_strength(None)
    assert math.isnan(out["ce_wall_strength_rel"])
    assert math.isnan(out["pe_wall_strength_rel"])


def test_wall_strength_empty_chain_yields_nan():
    out = compute_wall_strength([])
    assert math.isnan(out["ce_wall_strength_rel"])
    assert math.isnan(out["pe_wall_strength_rel"])


def test_wall_strength_uniform_chain_equals_one():
    """All strikes equal OI on both sides → max == mean → ratio 1.0."""
    rows = [_row(k, c_oi=500, p_oi=500) for k in range(23000, 25001, 100)]
    out = compute_wall_strength(rows)
    assert out["ce_wall_strength_rel"] == pytest.approx(1.0)
    assert out["pe_wall_strength_rel"] == pytest.approx(1.0)


def test_wall_strength_concentrated_call_strike_gives_large_ratio():
    """One heavy CE strike, others tiny → ratio significantly > 1."""
    rows = [
        _row(23500, c_oi=100, p_oi=100),
        _row(24000, c_oi=100, p_oi=100),
        _row(24500, c_oi=5000, p_oi=100),  # heavy CE wall
        _row(25000, c_oi=100, p_oi=100),
    ]
    out = compute_wall_strength(rows)
    # max=5000, mean=(100+100+5000+100)/4 = 1325 → ratio ≈ 3.77
    assert out["ce_wall_strength_rel"] > 2.0
    assert out["ce_wall_strength_rel"] == pytest.approx(5000.0 / ((100 + 100 + 5000 + 100) / 4))
    # PE side is uniform → ~1.0
    assert out["pe_wall_strength_rel"] == pytest.approx(1.0)


def test_wall_strength_concentrated_put_strike_gives_large_ratio():
    rows = [
        _row(23500, c_oi=100, p_oi=4000),  # heavy PE
        _row(24000, c_oi=100, p_oi=200),
        _row(24500, c_oi=100, p_oi=200),
        _row(25000, c_oi=100, p_oi=200),
    ]
    out = compute_wall_strength(rows)
    assert out["pe_wall_strength_rel"] > 2.0
    assert out["ce_wall_strength_rel"] == pytest.approx(1.0)


def test_wall_strength_all_zero_call_side_yields_nan_for_calls():
    rows = [
        _row(23500, c_oi=0, p_oi=500),
        _row(24000, c_oi=0, p_oi=600),
        _row(24500, c_oi=0, p_oi=700),
    ]
    out = compute_wall_strength(rows)
    assert math.isnan(out["ce_wall_strength_rel"])
    assert math.isfinite(out["pe_wall_strength_rel"])


def test_wall_strength_all_zero_put_side_yields_nan_for_puts():
    rows = [
        _row(23500, c_oi=400, p_oi=0),
        _row(24000, c_oi=500, p_oi=0),
        _row(24500, c_oi=600, p_oi=0),
    ]
    out = compute_wall_strength(rows)
    assert math.isfinite(out["ce_wall_strength_rel"])
    assert math.isnan(out["pe_wall_strength_rel"])


def test_wall_strength_single_valid_strike_yields_nan():
    """< 2 contributing strikes → can't compare max vs mean meaningfully."""
    rows = [_row(24000, c_oi=1000, p_oi=1000)]
    out = compute_wall_strength(rows)
    assert math.isnan(out["ce_wall_strength_rel"])
    assert math.isnan(out["pe_wall_strength_rel"])


def test_wall_strength_skips_malformed_rows():
    """Junk rows are skipped; the two valid strikes drive the ratio."""
    rows = [
        _row(24000, c_oi=1000, p_oi=1000),
        {"strike": 24500, "callOI": "abc", "putOI": "x"},  # bad OI types
        "not-a-dict",
        {"callOI": 100, "putOI": 100},                     # no strike (still has OI)
        _row(25000, c_oi=3000, p_oi=3000),
    ]
    out = compute_wall_strength(rows)
    # The 'no-strike' row still has valid OI numbers → it contributes
    # to ce_oi/pe_oi lists. Three valid call-OI samples: 1000,100,3000.
    # max=3000, mean=(1000+100+3000)/3 = 1366.67 → ratio ≈ 2.195
    expected = 3000.0 / ((1000 + 100 + 3000) / 3.0)
    assert out["ce_wall_strength_rel"] == pytest.approx(expected)
    assert out["pe_wall_strength_rel"] == pytest.approx(expected)


def test_wall_strength_negative_oi_skipped():
    """Negative OI values (corrupt data) are excluded from both sides."""
    rows = [
        _row(23500, c_oi=-100, p_oi=500),  # negative CE rejected
        _row(24000, c_oi=500, p_oi=500),
        _row(24500, c_oi=2000, p_oi=500),
    ]
    out = compute_wall_strength(rows)
    # Only 500 and 2000 contribute on CE → max=2000, mean=1250 → 1.6
    assert out["ce_wall_strength_rel"] == pytest.approx(2000.0 / 1250.0)
    assert out["pe_wall_strength_rel"] == pytest.approx(1.0)


def test_wall_strength_nan_oi_skipped():
    """NaN OI values are excluded."""
    rows = [
        _row(23500, c_oi=float("nan"), p_oi=500),
        _row(24000, c_oi=400, p_oi=500),
        _row(24500, c_oi=600, p_oi=500),
    ]
    out = compute_wall_strength(rows)
    # CE list = [400, 600] → max=600, mean=500 → 1.2
    assert out["ce_wall_strength_rel"] == pytest.approx(600.0 / 500.0)


# ── compute_oi_change_deltas ──────────────────────────────────────────────


def test_deltas_none_history_yields_all_nan():
    out = compute_oi_change_deltas(None, now_ts=1_000_000.0)
    for key in (
        "ce_oi_change_5min_pct", "pe_oi_change_5min_pct",
        "ce_oi_change_15min_pct", "pe_oi_change_15min_pct",
        "ce_oi_change_60min_pct", "pe_oi_change_60min_pct",
    ):
        assert math.isnan(out[key]), f"{key} should be NaN"


def test_deltas_empty_history_yields_all_nan():
    out = compute_oi_change_deltas([], now_ts=1_000_000.0)
    for key in out:
        assert math.isnan(out[key])


def test_deltas_single_sample_yields_all_nan():
    """No baseline for any window → all 6 NaN."""
    now = 1_000_000.0
    history = [(now, 100_000.0, 80_000.0)]
    out = compute_oi_change_deltas(history, now_ts=now)
    for key in out:
        assert math.isnan(out[key])


def test_deltas_none_now_ts_yields_all_nan():
    history = [(1_000_000.0, 100_000.0, 80_000.0)]
    out = compute_oi_change_deltas(history, now_ts=None)
    for key in out:
        assert math.isnan(out[key])


def test_deltas_invalid_now_ts_yields_all_nan():
    history = [(1_000_000.0, 100_000.0, 80_000.0)]
    out = compute_oi_change_deltas(history, now_ts="not-a-number")  # type: ignore[arg-type]
    for key in out:
        assert math.isnan(out[key])

    out2 = compute_oi_change_deltas(history, now_ts=float("nan"))
    for key in out2:
        assert math.isnan(out2[key])


def test_deltas_rising_call_oi_5min_positive():
    """+10% call OI over 5 min → ce_oi_change_5min_pct == 10.0."""
    now = 1_000_000.0
    history = [
        (now - 300, 100_000.0, 80_000.0),  # baseline 5 min ago
        (now - 1, 110_000.0, 80_000.0),    # now: +10% call
    ]
    out = compute_oi_change_deltas(history, now_ts=now)
    assert out["ce_oi_change_5min_pct"] == pytest.approx(10.0)
    assert out["pe_oi_change_5min_pct"] == pytest.approx(0.0, abs=1e-9)


def test_deltas_falling_put_oi_5min_negative():
    now = 1_000_000.0
    history = [
        (now - 300, 100_000.0, 80_000.0),
        (now - 1, 100_000.0, 60_000.0),  # -25% put
    ]
    out = compute_oi_change_deltas(history, now_ts=now)
    assert out["pe_oi_change_5min_pct"] == pytest.approx(-25.0)
    assert out["ce_oi_change_5min_pct"] == pytest.approx(0.0, abs=1e-9)


def test_deltas_baseline_within_tolerance_picked():
    """5-min target = now-300s; sample 30s before target is within 60s tol."""
    now = 1_000_000.0
    history = [
        (now - 330, 100_000.0, 80_000.0),  # 30s past target, within 60s tol
        (now - 1, 105_000.0, 84_000.0),
    ]
    out = compute_oi_change_deltas(history, now_ts=now)
    assert out["ce_oi_change_5min_pct"] == pytest.approx(5.0)
    assert out["pe_oi_change_5min_pct"] == pytest.approx(5.0)


def test_deltas_baseline_staler_than_tolerance_yields_nan():
    """5-min baseline 70s past target → exceeds 60s tolerance → NaN."""
    now = 1_000_000.0
    history = [
        (now - 370, 100_000.0, 80_000.0),  # 70s past target — too stale
        (now - 1, 105_000.0, 84_000.0),
    ]
    out = compute_oi_change_deltas(history, now_ts=now)
    assert math.isnan(out["ce_oi_change_5min_pct"])
    assert math.isnan(out["pe_oi_change_5min_pct"])


def test_deltas_15min_baseline_missing_only_that_window_nan():
    """Have 5-min and 60-min baselines but no 15-min sample within tolerance."""
    now = 1_000_000.0
    history = [
        (now - 3600, 90_000.0, 70_000.0),   # 60-min baseline
        (now - 300, 100_000.0, 80_000.0),   # 5-min baseline
        (now - 1, 110_000.0, 88_000.0),
    ]
    out = compute_oi_change_deltas(history, now_ts=now)
    # 5-min: +10% / +10%
    assert out["ce_oi_change_5min_pct"] == pytest.approx(10.0)
    assert out["pe_oi_change_5min_pct"] == pytest.approx(10.0)
    # 15-min: no sample at-or-before (now-900) within 90s tolerance → NaN.
    # The (now-300) sample is NEWER than target, the (now-3600) sample is
    # too far in the past. Both should be rejected.
    assert math.isnan(out["ce_oi_change_15min_pct"])
    assert math.isnan(out["pe_oi_change_15min_pct"])
    # 60-min: (110000-90000)/90000*100 ≈ 22.22%
    assert out["ce_oi_change_60min_pct"] == pytest.approx(20_000.0 / 90_000.0 * 100.0)
    assert out["pe_oi_change_60min_pct"] == pytest.approx(18_000.0 / 70_000.0 * 100.0)


def test_deltas_zero_baseline_oi_yields_nan_on_that_side():
    """Baseline call_oi = 0 → ce_5min_pct NaN, pe_5min_pct still computes."""
    now = 1_000_000.0
    history = [
        (now - 300, 0.0, 80_000.0),
        (now - 1, 50_000.0, 88_000.0),
    ]
    out = compute_oi_change_deltas(history, now_ts=now)
    assert math.isnan(out["ce_oi_change_5min_pct"])
    assert out["pe_oi_change_5min_pct"] == pytest.approx(10.0)


def test_deltas_60min_window_picks_correct_hourly_baseline():
    """Hour-spaced snapshots: 60-min lookback should hit the 1-hr-ago sample."""
    now = 1_000_000.0
    history = [
        (now - 7200, 50_000.0, 40_000.0),   # 2 hrs ago
        (now - 3600, 80_000.0, 60_000.0),   # exactly 1 hr ago — picked
        (now - 300, 95_000.0, 75_000.0),    # 5 min ago
        (now - 1, 100_000.0, 80_000.0),     # current
    ]
    out = compute_oi_change_deltas(history, now_ts=now)
    # 60-min: (100k-80k)/80k*100 = 25%, (80k-60k)/60k*100 ≈ 33.33%
    assert out["ce_oi_change_60min_pct"] == pytest.approx(25.0)
    assert out["pe_oi_change_60min_pct"] == pytest.approx(20_000.0 / 60_000.0 * 100.0)
    # 5-min: (100k-95k)/95k*100 ≈ 5.26%, (80k-75k)/75k*100 ≈ 6.67%
    assert out["ce_oi_change_5min_pct"] == pytest.approx(5_000.0 / 95_000.0 * 100.0)
    assert out["pe_oi_change_5min_pct"] == pytest.approx(5_000.0 / 75_000.0 * 100.0)


def test_deltas_ignores_future_samples():
    """Samples newer than now_ts must not influence current or baseline."""
    now = 1_000_000.0
    history = [
        (now - 300, 100_000.0, 80_000.0),
        (now - 1, 110_000.0, 88_000.0),
        (now + 60, 9_999_999.0, 9_999_999.0),  # future — ignored
    ]
    out = compute_oi_change_deltas(history, now_ts=now)
    # Should reflect the (now-1) numerator, not the future spike.
    assert out["ce_oi_change_5min_pct"] == pytest.approx(10.0)


def test_deltas_skips_non_finite_oi_values():
    """NaN/inf OI snapshots are skipped; valid neighbours still used."""
    now = 1_000_000.0
    history = [
        (now - 300, 100_000.0, 80_000.0),
        (now - 150, float("nan"), float("nan")),  # corrupt — skipped
        (now - 1, 110_000.0, 88_000.0),
    ]
    out = compute_oi_change_deltas(history, now_ts=now)
    assert out["ce_oi_change_5min_pct"] == pytest.approx(10.0)
    assert out["pe_oi_change_5min_pct"] == pytest.approx(10.0)


def test_deltas_skips_malformed_tuples():
    """Non-tuple / wrong-arity entries are skipped."""
    now = 1_000_000.0
    history = [
        (now - 300, 100_000.0, 80_000.0),
        "not-a-tuple",                            # junk
        (now - 200, 105_000.0),                   # arity 2 — junk
        (now - 1, 110_000.0, 88_000.0),
    ]
    out = compute_oi_change_deltas(history, now_ts=now)  # type: ignore[arg-type]
    assert out["ce_oi_change_5min_pct"] == pytest.approx(10.0)
    assert out["pe_oi_change_5min_pct"] == pytest.approx(10.0)


def test_deltas_skips_non_finite_timestamps():
    """ts=NaN/inf in a sample is skipped, not propagated."""
    now = 1_000_000.0
    history = [
        (now - 300, 100_000.0, 80_000.0),
        (float("nan"), 999_000.0, 999_000.0),  # bad ts — skipped
        (float("inf"), 999_000.0, 999_000.0),  # bad ts — skipped
        (now - 1, 110_000.0, 88_000.0),
    ]
    out = compute_oi_change_deltas(history, now_ts=now)
    assert out["ce_oi_change_5min_pct"] == pytest.approx(10.0)
    assert out["pe_oi_change_5min_pct"] == pytest.approx(10.0)


def test_deltas_history_only_in_future_yields_all_nan():
    """All snapshots newer than now_ts → no current sample → all 6 NaN."""
    now = 1_000_000.0
    history = [
        (now + 10, 100_000.0, 80_000.0),
        (now + 20, 110_000.0, 88_000.0),
    ]
    out = compute_oi_change_deltas(history, now_ts=now)
    for key in out:
        assert math.isnan(out[key])


def test_deltas_returns_all_six_keys():
    """Output dict always has the 6 expected keys regardless of input."""
    out = compute_oi_change_deltas(None, now_ts=None)
    expected = {
        "ce_oi_change_5min_pct", "pe_oi_change_5min_pct",
        "ce_oi_change_15min_pct", "pe_oi_change_15min_pct",
        "ce_oi_change_60min_pct", "pe_oi_change_60min_pct",
    }
    assert set(out.keys()) == expected
