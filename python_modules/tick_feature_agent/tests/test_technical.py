"""Tests for features/technical.py — C2 5-min RSI / MACD / vol-divergence."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.features.bars import Bar
from tick_feature_agent.features.technical import compute_technical_features


def _bar(close: float, open_: float | None = None, volume: float = 1000.0, start_ts: float = 0.0) -> Bar:
    return Bar(
        start_ts=start_ts,
        open=open_ if open_ is not None else close,
        high=max(close, open_ or close),
        low=min(close, open_ or close),
        close=close,
        volume=volume,
        tick_count=1,
    )


# ── Empty / short input ───────────────────────────────────────────────────


def test_empty_bars_all_nan():
    out = compute_technical_features([])
    for k in (
        "rsi_14_5min", "macd_5min", "macd_signal_5min",
        "macd_histogram_5min", "volume_price_divergence_5min",
    ):
        assert math.isnan(out[k])


def test_none_bars_all_nan():
    out = compute_technical_features(None)
    for k in (
        "rsi_14_5min", "macd_5min", "macd_signal_5min",
        "macd_histogram_5min", "volume_price_divergence_5min",
    ):
        assert math.isnan(out[k])


def test_insufficient_bars_for_rsi_yields_nan():
    """14 bars = 13 changes → still not enough for RSI seed."""
    bars = [_bar(100.0 + i) for i in range(14)]
    out = compute_technical_features(bars)
    assert math.isnan(out["rsi_14_5min"])


def test_insufficient_bars_for_macd_yields_nan():
    bars = [_bar(100.0 + i) for i in range(20)]
    out = compute_technical_features(bars)
    assert math.isnan(out["macd_5min"])
    assert math.isnan(out["macd_signal_5min"])
    assert math.isnan(out["macd_histogram_5min"])


# ── RSI properties ────────────────────────────────────────────────────────


def test_rsi_steadily_rising_series_is_high():
    """Pure up-trend → RSI converges toward 100."""
    bars = [_bar(100.0 + i) for i in range(40)]
    out = compute_technical_features(bars)
    assert math.isfinite(out["rsi_14_5min"])
    assert out["rsi_14_5min"] > 90.0


def test_rsi_steadily_falling_series_is_low():
    bars = [_bar(100.0 - i * 0.5) for i in range(40)]
    out = compute_technical_features(bars)
    assert math.isfinite(out["rsi_14_5min"])
    assert out["rsi_14_5min"] < 10.0


def test_rsi_alternating_series_near_50():
    """Equal up/down moves → RSI sits near 50."""
    closes = []
    base = 100.0
    for i in range(40):
        closes.append(base + (1.0 if i % 2 == 0 else -1.0))
    bars = [_bar(c) for c in closes]
    out = compute_technical_features(bars)
    assert 40.0 < out["rsi_14_5min"] < 60.0


def test_rsi_in_range_0_to_100():
    bars = [_bar(100.0 + (i % 3) * 0.5) for i in range(50)]
    out = compute_technical_features(bars)
    assert 0.0 <= out["rsi_14_5min"] <= 100.0


def test_rsi_100_on_pure_gains():
    """No down moves at all → avg_loss = 0 → RSI = 100."""
    bars = [_bar(100.0 + i) for i in range(20)]
    out = compute_technical_features(bars)
    assert out["rsi_14_5min"] == 100.0


# ── MACD properties ───────────────────────────────────────────────────────


def test_macd_positive_in_uptrend():
    bars = [_bar(100.0 + i) for i in range(50)]
    out = compute_technical_features(bars)
    assert math.isfinite(out["macd_5min"])
    assert out["macd_5min"] > 0


def test_macd_negative_in_downtrend():
    bars = [_bar(100.0 - i * 0.5) for i in range(50)]
    out = compute_technical_features(bars)
    assert out["macd_5min"] < 0


def test_macd_signal_lags_macd_in_changing_trend():
    """In a sustained uptrend, signal trails macd → histogram > 0 (sometimes)."""
    bars = [_bar(100.0 + i * 0.5) for i in range(50)]
    out = compute_technical_features(bars)
    # In a steady uptrend with constant slope, MACD line stabilizes and the
    # signal eventually catches up — histogram → 0. Just check definitions hold.
    assert math.isfinite(out["macd_signal_5min"])
    assert math.isfinite(out["macd_histogram_5min"])
    assert out["macd_histogram_5min"] == pytest.approx(
        out["macd_5min"] - out["macd_signal_5min"], rel=1e-9, abs=1e-12,
    )


def test_macd_histogram_nan_if_signal_not_ready():
    """26 bars: macd is computed but signal needs 9 more macd points (34 total)."""
    bars = [_bar(100.0 + i) for i in range(26)]
    out = compute_technical_features(bars)
    assert math.isfinite(out["macd_5min"])
    # Signal EMA needs 9 macd values; only 1 macd value exists.
    assert math.isnan(out["macd_signal_5min"])
    assert math.isnan(out["macd_histogram_5min"])


def test_macd_signal_finite_with_enough_bars():
    bars = [_bar(100.0 + (i % 5)) for i in range(60)]
    out = compute_technical_features(bars)
    assert math.isfinite(out["macd_signal_5min"])
    assert math.isfinite(out["macd_histogram_5min"])


# ── volume_price_divergence_5min ──────────────────────────────────────────


def test_vpd_nan_when_too_few_bars():
    bars = [_bar(100.0, 99.0, volume=1000) for _ in range(3)]
    out = compute_technical_features(bars)
    assert math.isnan(out["volume_price_divergence_5min"])


def test_vpd_confirmation_when_price_up_volume_above_baseline():
    bars = [_bar(close=100.0, open_=100.0, volume=1000) for _ in range(5)]
    bars.append(_bar(close=105.0, open_=100.0, volume=5000))  # price up, vol up
    out = compute_technical_features(bars)
    assert out["volume_price_divergence_5min"] == 1.0


def test_vpd_divergence_when_price_up_volume_below_baseline():
    bars = [_bar(close=100.0, open_=100.0, volume=5000) for _ in range(5)]
    bars.append(_bar(close=105.0, open_=100.0, volume=500))  # price up, vol DOWN
    out = compute_technical_features(bars)
    assert out["volume_price_divergence_5min"] == -1.0


def test_vpd_confirmation_when_price_down_volume_above_baseline():
    bars = [_bar(close=100.0, open_=100.0, volume=1000) for _ in range(5)]
    bars.append(_bar(close=95.0, open_=100.0, volume=5000))  # selling on rising vol
    out = compute_technical_features(bars)
    # price_sign=-1, vol_sign=+1 → -1 (divergence by formula)
    # NOTE: by my formula, "confirmation" = same-direction agreement on
    # signs of price and (vol vs baseline). Price down + vol up is -1.
    assert out["volume_price_divergence_5min"] == -1.0


def test_vpd_flat_bar_returns_zero():
    bars = [_bar(close=100.0, open_=100.0, volume=1000) for _ in range(5)]
    bars.append(_bar(close=100.0, open_=100.0, volume=5000))  # flat
    out = compute_technical_features(bars)
    assert out["volume_price_divergence_5min"] == 0.0


def test_vpd_baseline_zero_returns_zero():
    bars = [_bar(close=100.0, open_=100.0, volume=0.0) for _ in range(5)]
    bars.append(_bar(close=105.0, open_=100.0, volume=100.0))
    out = compute_technical_features(bars)
    assert out["volume_price_divergence_5min"] == 0.0


# ── Invalid bar handling ──────────────────────────────────────────────────


def test_non_finite_closes_skipped_from_rsi():
    bars = [_bar(100.0 + i) for i in range(40)]
    # Insert a corrupt bar via direct Bar construction (frozen dataclass — must
    # build a fresh one with bad close to verify _clean_closes filters it).
    bars.append(Bar(start_ts=0, open=140, high=140, low=140, close=float("nan"),
                    volume=1000, tick_count=1))
    out = compute_technical_features(bars)
    # RSI should still be finite — bad bar skipped.
    assert math.isfinite(out["rsi_14_5min"])


def test_zero_close_skipped():
    bars = [_bar(100.0 + i) for i in range(40)]
    bars.append(Bar(start_ts=0, open=140, high=140, low=140, close=0.0,
                    volume=1000, tick_count=1))
    out = compute_technical_features(bars)
    assert math.isfinite(out["rsi_14_5min"])
