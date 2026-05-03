"""
tests/test_regime.py — Unit tests for features/regime.py (§8.10 Regime Classification).

Run: python -m pytest python_modules/tick_feature_agent/tests/test_regime.py -v
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.buffers.tick_buffer import CircularBuffer, UnderlyingTick
from tick_feature_agent.features.regime import compute_regime_features

# ── Helpers ───────────────────────────────────────────────────────────────────

_NAN = float("nan")


def _nan(v) -> bool:
    return isinstance(v, float) and math.isnan(v)


def _tick(ltp: float, ts: float = 1000.0) -> UnderlyingTick:
    return UnderlyingTick(timestamp=ts, ltp=ltp, bid=ltp - 1, ask=ltp + 1, volume=1000)


def _buf_with_prices(prices: list[float]) -> CircularBuffer:
    buf = CircularBuffer(maxlen=50)
    for i, p in enumerate(prices):
        buf.push(_tick(p, ts=float(i)))
    return buf


def _full_buf(base: float = 24100.0, n: int = 20, drift: float = 0.0) -> CircularBuffer:
    """Fill a buffer with n ticks; optionally add a linear drift."""
    prices = [base + drift * i for i in range(n)]
    return _buf_with_prices(prices)


# ── Default inputs that produce each regime ───────────────────────────────────


def _call(
    buf,
    vol_comp=0.1,
    imb=0.1,
    active=4,
    vol_diff_avail=True,
    state="TRADING",
    drought=_NAN,
    thresholds=None,
):
    return compute_regime_features(
        buffer=buf,
        volatility_compression=vol_comp,
        tick_imbalance_20=imb,
        active_strike_count=active,
        vol_diff_available=vol_diff_avail,
        trading_state=state,
        volume_drought_atm=drought,
        thresholds=thresholds,
    )


# ══════════════════════════════════════════════════════════════════════════════


class TestRegimeFeatureKeys:

    def test_keys_present(self):
        buf = _full_buf()
        out = _call(buf)
        assert set(out.keys()) == {"regime", "regime_confidence"}

    def test_exactly_2_keys(self):
        buf = _full_buf()
        out = _call(buf)
        assert len(out) == 2


class TestWarmUpGuard:

    def test_none_nan_when_buffer_under_20(self):
        buf = _buf_with_prices([24100.0] * 19)
        out = _call(buf)
        assert out["regime"] is None
        assert _nan(out["regime_confidence"])

    def test_none_nan_when_vol_diff_not_available(self):
        buf = _full_buf()
        out = _call(buf, vol_diff_avail=False)
        assert out["regime"] is None
        assert _nan(out["regime_confidence"])

    def test_none_nan_when_warming_up_state(self):
        buf = _full_buf()
        out = _call(buf, state="WARMING_UP")
        assert out["regime"] is None
        assert _nan(out["regime_confidence"])

    def test_none_nan_when_vol_compression_nan(self):
        buf = _full_buf()
        out = _call(buf, vol_comp=_NAN)
        assert out["regime"] is None
        assert _nan(out["regime_confidence"])

    def test_none_nan_when_tick_imbalance_nan(self):
        buf = _full_buf()
        out = _call(buf, imb=_NAN)
        assert out["regime"] is None
        assert _nan(out["regime_confidence"])

    def test_valid_exactly_at_20_ticks(self):
        """At exactly 20 ticks, warm-up guard is passed."""
        buf = _full_buf(n=20)
        out = _call(buf)
        assert out["regime"] is not None


class TestDeadRegime:

    def test_dead_when_low_activity(self):
        """s_activity < 0.25 → DEAD (using default regime_dead_activity_max=0.25)."""
        buf = _full_buf()
        # active_strike_count=0 → s_activity=0 < 0.25
        out = _call(buf, active=0)
        assert out["regime"] == "DEAD"

    def test_dead_confidence_is_1_minus_activity(self):
        buf = _full_buf()
        out = _call(buf, active=0)
        # s_activity = min(0/4, 1) = 0.0; confidence = 1.0 - 0.0 = 1.0
        assert out["regime_confidence"] == pytest.approx(1.0)

    def test_dead_with_partial_activity(self):
        buf = _full_buf()
        # active=1 → s_activity = 0.25; exactly at threshold
        # is_dead: s_activity < dead_activity_max (0.25) → False (not <, but ==)
        out = _call(buf, active=1)
        # Not dead (threshold is strict <)
        assert out["regime"] != "DEAD"

    def test_dead_priority_over_trend(self):
        """DEAD has highest priority — fires even when trend signals are high."""
        buf = _full_buf(drift=50.0)  # large price drift → high s_momentum
        out = _call(buf, vol_comp=0.9, imb=0.5, active=0)
        assert out["regime"] == "DEAD"


class TestTrendRegime:

    def test_trend_when_all_signals_high(self):
        """All signals above trend thresholds → TREND."""
        # Default thresholds: vol_min=0.8, imb_min=0.3, mom_min=0.5, act_min=0.5
        buf = _full_buf(drift=100.0, n=20)  # large drift → high s_momentum
        out = _call(buf, vol_comp=0.85, imb=0.4, active=4)
        assert out["regime"] == "TREND"

    def test_trend_confidence_clamped_to_1(self):
        """vol_compression > 1 can make raw avg > 1; clamp to 1."""
        buf = _full_buf(drift=200.0, n=20)
        out = _call(buf, vol_comp=2.0, imb=0.6, active=4)
        if out["regime"] == "TREND":
            assert out["regime_confidence"] <= 1.0

    def test_not_trend_when_low_volatility(self):
        buf = _full_buf(n=20)  # flat prices
        out = _call(buf, vol_comp=0.3, imb=0.5, active=4)
        assert out["regime"] != "TREND"


class TestRangeRegime:

    def test_range_when_low_vol_low_imbalance_sufficient_activity(self):
        """Low vol + low imbalance + adequate activity → RANGE."""
        # vol < 0.5, imb < 0.3, activity > 0.25
        buf = _full_buf(n=20)  # flat → s_momentum ≈ 0
        out = _call(buf, vol_comp=0.2, imb=0.1, active=4)
        assert out["regime"] == "RANGE"

    def test_range_confidence_clamped_0_1(self):
        buf = _full_buf(n=20)
        out = _call(buf, vol_comp=0.2, imb=0.1, active=4)
        if out["regime"] == "RANGE":
            c = out["regime_confidence"]
            assert 0.0 <= c <= 1.0

    def test_not_range_when_low_activity(self):
        """Low activity → DEAD (takes priority over RANGE)."""
        buf = _full_buf(n=20)
        out = _call(buf, vol_comp=0.2, imb=0.1, active=0)
        assert out["regime"] == "DEAD"


class TestNeutralRegime:

    def test_neutral_when_no_other_regime_matches(self):
        """Mid-range signals that don't meet TREND or RANGE criteria → NEUTRAL."""
        buf = _full_buf(n=20)
        out = _call(buf, vol_comp=0.6, imb=0.4, active=4)
        # vol=0.6 >= range_max(0.5) → not RANGE; vol=0.6 < trend_min(0.8) → not TREND
        assert out["regime"] == "NEUTRAL"

    def test_neutral_confidence_is_0_5(self):
        buf = _full_buf(n=20)
        out = _call(buf, vol_comp=0.6, imb=0.4, active=4)
        if out["regime"] == "NEUTRAL":
            assert out["regime_confidence"] == pytest.approx(0.5)


class TestCustomThresholds:

    def test_custom_thresholds_override_defaults(self):
        """Tighten TREND threshold so it no longer fires."""
        buf = _full_buf(drift=100.0, n=20)
        custom = {"regime_trend_volatility_min": 0.99}  # near-impossible to reach
        out = _call(buf, vol_comp=0.85, imb=0.4, active=4, thresholds=custom)
        assert out["regime"] != "TREND"

    def test_partial_threshold_override(self):
        """Partial dict merges with defaults — unspecified keys keep defaults."""
        buf = _full_buf(n=20)
        # Set dead_activity_max very high so activity=2 still qualifies as DEAD
        custom = {"regime_dead_activity_max": 0.99}
        out = _call(buf, vol_comp=0.2, imb=0.1, active=2, thresholds=custom)
        # active=2, s_activity=0.5; 0.5 < 0.99 → DEAD
        assert out["regime"] == "DEAD"


class TestPriorityOrder:

    def test_dead_before_trend(self):
        """Even if TREND conditions met, DEAD takes priority."""
        buf = _full_buf(drift=100.0, n=20)
        out = _call(buf, vol_comp=0.9, imb=0.5, active=0)
        assert out["regime"] == "DEAD"

    def test_trend_before_range(self):
        """Custom thresholds: same inputs satisfy both TREND and RANGE criteria.
        In that edge case, TREND wins (checked first)."""
        buf = _full_buf(drift=200.0, n=20)
        custom = {
            "regime_trend_volatility_min": 0.1,
            "regime_trend_imbalance_min": 0.0,
            "regime_trend_momentum_min": 0.0,
            "regime_trend_activity_min": 0.0,
            "regime_range_volatility_max": 0.99,
            "regime_range_imbalance_max": 0.99,
            "regime_range_activity_min": 0.0,
        }
        out = _call(buf, vol_comp=0.5, imb=0.2, active=4, thresholds=custom)
        assert out["regime"] == "TREND"
