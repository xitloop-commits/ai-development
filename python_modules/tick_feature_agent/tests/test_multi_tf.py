"""Tests for features/multi_tf.py — B1/B2/B4 multi-timeframe features."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.bars import Bar
from tick_feature_agent.features.multi_tf import compute_multi_tf_features


def _bar(close: float, high: float | None = None, low: float | None = None) -> Bar:
    h = high if high is not None else close
    l = low if low is not None else close
    return Bar(start_ts=0.0, open=close, high=h, low=l, close=close, volume=1000.0, tick_count=1)


def _trend_bars(n: int, start: float = 100.0, step: float = 1.0) -> list[Bar]:
    """n bars climbing by `step` per bar — strong uptrend."""
    return [_bar(close=start + i * step, high=start + i * step + 0.5, low=start + i * step - 0.5)
            for i in range(n)]


# ── B1 MA ratios ──────────────────────────────────────────────────────────


def test_ma_ratio_zero_when_spot_equals_ma():
    bars = [_bar(100.0) for _ in range(20)]
    out = compute_multi_tf_features(spot=100.0, bars_1m=bars, bars_5m=bars, bars_15m=bars)
    for key in ("ma_5_1min", "ma_20_1min", "ma_5_5min", "ma_20_5min", "ma_5_15min"):
        assert out[key] == pytest.approx(0.0)


def test_ma_ratio_positive_when_spot_above_ma():
    bars = [_bar(100.0) for _ in range(20)]
    out = compute_multi_tf_features(spot=105.0, bars_1m=bars, bars_5m=bars, bars_15m=bars)
    assert out["ma_5_1min"] > 0
    assert out["ma_5_5min"] > 0


def test_ma_ratio_nan_when_insufficient_bars():
    bars = [_bar(100.0) for _ in range(4)]
    out = compute_multi_tf_features(spot=100.0, bars_1m=bars, bars_5m=bars, bars_15m=bars)
    assert math.isnan(out["ma_5_1min"])   # needs 5
    assert math.isnan(out["ma_20_1min"])  # needs 20


def test_ma_ratio_nan_when_no_spot():
    bars = [_bar(100.0) for _ in range(20)]
    out = compute_multi_tf_features(spot=None, bars_1m=bars, bars_5m=bars, bars_15m=bars)
    for key in ("ma_5_1min", "ma_20_1min", "ma_5_5min", "ma_20_5min", "ma_5_15min"):
        assert math.isnan(out[key])


def test_ma_5_uses_only_last_5_bars():
    # First 15 bars at 90, last 5 at 100 → ma_5 = 100.
    bars = [_bar(90.0) for _ in range(15)] + [_bar(100.0) for _ in range(5)]
    out = compute_multi_tf_features(spot=100.0, bars_1m=bars, bars_5m=bars, bars_15m=bars)
    assert out["ma_5_1min"] == pytest.approx(0.0)
    # ma_20 averages all 20 → (15*90 + 5*100)/20 = 92.5
    assert out["ma_20_1min"] == pytest.approx((100 - 92.5) / 100)


# ── B2 momentum ───────────────────────────────────────────────────────────


def test_momentum_5min_above_one_in_uptrend():
    bars = _trend_bars(10, start=100.0, step=2.0)
    out = compute_multi_tf_features(spot=120, bars_1m=[], bars_5m=bars, bars_15m=[])
    # latest close 118, prev 116 → 118/116 ≈ 1.017
    assert out["momentum_5min"] == pytest.approx(118.0 / 116.0)
    assert out["momentum_5min"] > 1.0


def test_momentum_5min_below_one_in_downtrend():
    bars = _trend_bars(10, start=100.0, step=-1.0)
    out = compute_multi_tf_features(spot=91.0, bars_1m=[], bars_5m=bars, bars_15m=[])
    assert out["momentum_5min"] < 1.0


def test_momentum_nan_with_too_few_bars():
    out = compute_multi_tf_features(spot=100, bars_1m=[], bars_5m=[_bar(100)], bars_15m=[])
    assert math.isnan(out["momentum_5min"])
    assert math.isnan(out["momentum_15min"])


# ── B2 ADX ────────────────────────────────────────────────────────────────


def test_adx_high_in_strong_trend():
    """30 bars of steady uptrend should produce ADX well above 25."""
    bars = _trend_bars(30, start=100.0, step=1.0)
    out = compute_multi_tf_features(spot=130, bars_1m=[], bars_5m=bars, bars_15m=[])
    assert math.isfinite(out["adx_5min"])
    assert out["adx_5min"] > 25.0


def test_adx_low_in_flat_market():
    """Identical-close bars (no movement) → ADX should be near 0."""
    bars = [_bar(close=100.0, high=100.5, low=99.5) for _ in range(40)]
    out = compute_multi_tf_features(spot=100, bars_1m=[], bars_5m=bars, bars_15m=[])
    assert math.isfinite(out["adx_5min"])
    # In a perfectly oscillating flat market both +DI and -DI are tiny,
    # so ADX collapses near 0 (or NaN if no DM ever fires).
    assert out["adx_5min"] < 20.0


def test_adx_nan_when_too_few_bars():
    bars = _trend_bars(10)
    out = compute_multi_tf_features(spot=110, bars_1m=[], bars_5m=bars, bars_15m=[])
    assert math.isnan(out["adx_5min"])


def test_adx_in_valid_range():
    bars = _trend_bars(50, start=100.0, step=0.5)
    out = compute_multi_tf_features(spot=125, bars_1m=[], bars_5m=bars, bars_15m=[])
    assert 0.0 <= out["adx_5min"] <= 100.0


# ── B4 Higher highs / higher lows ─────────────────────────────────────────


def test_consec_higher_highs_in_steady_uptrend():
    bars = _trend_bars(10, start=100.0, step=1.0)
    out = compute_multi_tf_features(spot=110, bars_1m=[], bars_5m=bars, bars_15m=[])
    # Each bar's high > prev bar's high → 9 consecutive
    assert out["consecutive_higher_highs_5min"] == 9.0
    assert out["consecutive_higher_lows_5min"] == 9.0


def test_consec_higher_highs_zero_when_last_bar_breaks_streak():
    bars = _trend_bars(5, start=100.0, step=1.0)
    # Append a lower-high bar
    bars.append(_bar(close=103.0, high=103.5, low=102.5))
    out = compute_multi_tf_features(spot=103, bars_1m=[], bars_5m=bars, bars_15m=[])
    assert out["consecutive_higher_highs_5min"] == 0.0


def test_consec_higher_highs_nan_with_one_bar():
    out = compute_multi_tf_features(spot=100, bars_1m=[], bars_5m=[_bar(100)], bars_15m=[])
    assert math.isnan(out["consecutive_higher_highs_5min"])
    assert math.isnan(out["consecutive_higher_lows_5min"])


# ── B4 range_compression_ratio ────────────────────────────────────────────


def test_range_compression_one_when_uniform():
    bars = [_bar(close=100.0, high=101.0, low=99.0) for _ in range(15)]
    out = compute_multi_tf_features(spot=100, bars_1m=[], bars_5m=bars, bars_15m=[])
    assert out["range_compression_ratio"] == pytest.approx(1.0)


def test_range_compression_below_one_for_tighter_recent_bar():
    bars = [_bar(close=100.0, high=102.0, low=98.0) for _ in range(10)]  # range 4
    bars.append(_bar(close=100.0, high=100.5, low=99.5))                  # range 1
    out = compute_multi_tf_features(spot=100, bars_1m=[], bars_5m=bars, bars_15m=[])
    assert out["range_compression_ratio"] == pytest.approx(0.25)


def test_range_compression_above_one_for_wider_recent_bar():
    bars = [_bar(close=100.0, high=101.0, low=99.0) for _ in range(10)]   # range 2
    bars.append(_bar(close=100.0, high=104.0, low=96.0))                   # range 8
    out = compute_multi_tf_features(spot=100, bars_1m=[], bars_5m=bars, bars_15m=[])
    assert out["range_compression_ratio"] == pytest.approx(4.0)


def test_range_compression_nan_with_too_few_bars():
    bars = _trend_bars(5)
    out = compute_multi_tf_features(spot=110, bars_1m=[], bars_5m=bars, bars_15m=[])
    assert math.isnan(out["range_compression_ratio"])


# ── End-to-end: every key present, no exceptions on empty inputs ──────────


def test_all_keys_present_on_empty_input():
    out = compute_multi_tf_features(spot=None, bars_1m=None, bars_5m=None, bars_15m=None)
    expected_keys = {
        "ma_5_1min", "ma_20_1min", "ma_5_5min", "ma_20_5min", "ma_5_15min",
        "adx_5min", "momentum_5min", "momentum_15min",
        "consecutive_higher_highs_5min", "consecutive_higher_lows_5min",
        "range_compression_ratio",
    }
    assert set(out.keys()) == expected_keys
    for v in out.values():
        assert math.isnan(v)
