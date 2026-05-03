"""
tests/test_features_underlying.py — Unit tests for features/underlying.py (§8.2).

Coverage strategy:
  - Boundary ticks: 1, 2, 3, 4, 5, 9, 10, 19, 20, 49, 50
  - Correctness of every feature formula
  - NaN propagation rules
  - Edge cases: zero reference price, flat/monotone sequences
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
from tick_feature_agent.features.underlying import compute_underlying_features

# ── Helpers ───────────────────────────────────────────────────────────────────

_EXPECTED_KEYS = {
    "ltp",
    "bid",
    "ask",
    "spread",
    "return_5ticks",
    "return_10ticks",
    "return_20ticks",
    "return_50ticks",
    "momentum",
    "velocity",
    "tick_up_count_10",
    "tick_down_count_10",
    "tick_flat_count_10",
    "tick_imbalance_10",
    "tick_up_count_20",
    "tick_down_count_20",
    "tick_flat_count_20",
    "tick_imbalance_20",
    "tick_up_count_50",
    "tick_down_count_50",
    "tick_flat_count_50",
    "tick_imbalance_50",
}


def _tick(ltp: float, bid: float = 0.0, ask: float = 0.0) -> UnderlyingTick:
    return UnderlyingTick(timestamp=0.0, ltp=ltp, bid=bid, ask=ask, volume=0)


def _buf(*prices: float, bid: float = 0.0, ask: float = 0.0) -> CircularBuffer:
    """Build a CircularBuffer(maxlen=50) from the given LTP sequence."""
    buf = CircularBuffer(maxlen=50)
    for p in prices:
        buf.push(_tick(p, bid=bid, ask=ask))
    return buf


def _nan(v) -> bool:
    return isinstance(v, float) and math.isnan(v)


# ── TestFeatureKeys ───────────────────────────────────────────────────────────


class TestFeatureKeys:
    def test_exactly_22_keys_on_empty_buffer(self):
        result = compute_underlying_features(CircularBuffer(maxlen=50))
        assert set(result) == _EXPECTED_KEYS
        assert len(result) == 22

    def test_exactly_22_keys_on_full_buffer(self):
        prices = [100.0 + i for i in range(50)]
        result = compute_underlying_features(_buf(*prices))
        assert set(result) == _EXPECTED_KEYS
        assert len(result) == 22


# ── TestEmptyBuffer ───────────────────────────────────────────────────────────


class TestEmptyBuffer:
    def test_all_nan_on_empty(self):
        result = compute_underlying_features(CircularBuffer(maxlen=50))
        for k, v in result.items():
            assert _nan(v), f"expected NaN for {k!r}, got {v!r}"


# ── TestInstantFeatures ───────────────────────────────────────────────────────


class TestInstantFeatures:
    """ltp, bid, ask, spread are always available from the first tick."""

    def test_ltp_from_first_tick(self):
        result = compute_underlying_features(_buf(24150.0))
        assert result["ltp"] == pytest.approx(24150.0)

    def test_bid_ask_spread_from_first_tick(self):
        result = compute_underlying_features(_buf(24150.0, bid=24140.0, ask=24160.0))
        assert result["bid"] == pytest.approx(24140.0)
        assert result["ask"] == pytest.approx(24160.0)
        assert result["spread"] == pytest.approx(20.0)

    def test_spread_zero_when_bid_ask_zero(self):
        # Pre-depth-packet state — bid=ask=0 → spread=0 (not NaN per spec)
        result = compute_underlying_features(_buf(24150.0, bid=0.0, ask=0.0))
        assert result["spread"] == pytest.approx(0.0)
        assert not _nan(result["spread"])

    def test_ltp_updates_on_each_tick(self):
        result = compute_underlying_features(_buf(100.0, 101.0, 102.0))
        assert result["ltp"] == pytest.approx(102.0)


# ── TestReturnNticks ──────────────────────────────────────────────────────────


class TestReturnNticks:
    """return_Nticks = (ltp - ltp[-N]) / ltp[-N], NaN if buffer has < N ticks."""

    def test_return_5ticks_nan_at_4_ticks(self):
        result = compute_underlying_features(_buf(*range(1, 5)))  # 4 ticks
        assert _nan(result["return_5ticks"])

    def test_return_5ticks_available_at_5_ticks(self):
        # ltp=105, ref=ltp[-5]=101 → (105-101)/101
        result = compute_underlying_features(_buf(101.0, 102.0, 103.0, 104.0, 105.0))
        assert not _nan(result["return_5ticks"])
        assert result["return_5ticks"] == pytest.approx((105.0 - 101.0) / 101.0)

    def test_return_10ticks_nan_at_9_ticks(self):
        result = compute_underlying_features(_buf(*[100.0 + i for i in range(9)]))
        assert _nan(result["return_10ticks"])

    def test_return_10ticks_available_at_10_ticks(self):
        prices = [100.0 + i for i in range(10)]  # 100..109
        result = compute_underlying_features(_buf(*prices))
        assert not _nan(result["return_10ticks"])
        assert result["return_10ticks"] == pytest.approx((109.0 - 100.0) / 100.0)

    def test_return_20ticks_nan_at_19_ticks(self):
        result = compute_underlying_features(_buf(*[100.0 + i for i in range(19)]))
        assert _nan(result["return_20ticks"])

    def test_return_20ticks_available_at_20_ticks(self):
        prices = [100.0 + i for i in range(20)]  # 100..119
        result = compute_underlying_features(_buf(*prices))
        assert not _nan(result["return_20ticks"])
        assert result["return_20ticks"] == pytest.approx((119.0 - 100.0) / 100.0)

    def test_return_50ticks_nan_at_49_ticks(self):
        result = compute_underlying_features(_buf(*[100.0 + i for i in range(49)]))
        assert _nan(result["return_50ticks"])

    def test_return_50ticks_available_at_50_ticks(self):
        prices = [100.0 + i for i in range(50)]  # 100..149
        result = compute_underlying_features(_buf(*prices))
        assert not _nan(result["return_50ticks"])
        assert result["return_50ticks"] == pytest.approx((149.0 - 100.0) / 100.0)

    def test_return_5ticks_still_present_beyond_5(self):
        # Confirm it uses the correct window anchor beyond 5 ticks
        prices = [100.0 + i for i in range(10)]  # 100..109; ltp=109, ref_5=105
        result = compute_underlying_features(_buf(*prices))
        assert result["return_5ticks"] == pytest.approx((109.0 - 105.0) / 105.0)

    def test_return_nan_when_reference_is_zero(self):
        # Edge: reference price is 0.0 → NaN
        result = compute_underlying_features(_buf(0.0, 1.0, 2.0, 3.0, 4.0))
        assert _nan(result["return_5ticks"])

    def test_smaller_windows_nan_when_larger_available(self):
        # With exactly 10 ticks: return_5/10 OK, return_20/50 NaN
        prices = [100.0 + i for i in range(10)]
        result = compute_underlying_features(_buf(*prices))
        assert not _nan(result["return_5ticks"])
        assert not _nan(result["return_10ticks"])
        assert _nan(result["return_20ticks"])
        assert _nan(result["return_50ticks"])


# ── TestMomentum ──────────────────────────────────────────────────────────────


class TestMomentum:
    """momentum = (ltp - ltp[-2]) / ltp[-2], NaN if < 2 ticks."""

    def test_momentum_nan_at_1_tick(self):
        result = compute_underlying_features(_buf(100.0))
        assert _nan(result["momentum"])

    def test_momentum_available_at_2_ticks(self):
        result = compute_underlying_features(_buf(100.0, 102.0))
        assert result["momentum"] == pytest.approx((102.0 - 100.0) / 100.0)

    def test_momentum_positive_on_uptick(self):
        result = compute_underlying_features(_buf(200.0, 210.0))
        assert result["momentum"] > 0

    def test_momentum_negative_on_downtick(self):
        result = compute_underlying_features(_buf(200.0, 190.0))
        assert result["momentum"] < 0

    def test_momentum_zero_on_flat(self):
        result = compute_underlying_features(_buf(200.0, 200.0))
        assert result["momentum"] == pytest.approx(0.0)

    def test_momentum_nan_when_prev_ltp_is_zero(self):
        result = compute_underlying_features(_buf(0.0, 100.0))
        assert _nan(result["momentum"])

    def test_momentum_uses_most_recent_two_ticks(self):
        # 3 ticks: 100 → 110 → 105; momentum = (105-110)/110
        result = compute_underlying_features(_buf(100.0, 110.0, 105.0))
        assert result["momentum"] == pytest.approx((105.0 - 110.0) / 110.0)


# ── TestVelocity ──────────────────────────────────────────────────────────────


class TestVelocity:
    """velocity = curr_momentum - prev_momentum, NaN if < 3 ticks."""

    def test_velocity_nan_at_2_ticks(self):
        result = compute_underlying_features(_buf(100.0, 102.0))
        assert _nan(result["velocity"])

    def test_velocity_available_at_3_ticks(self):
        result = compute_underlying_features(_buf(100.0, 102.0, 104.0))
        assert not _nan(result["velocity"])

    def test_velocity_zero_on_constant_momentum(self):
        # 100 → 110 → 121: each tick is +10% → velocity = 0
        result = compute_underlying_features(_buf(100.0, 110.0, 121.0))
        curr_mom = (121.0 - 110.0) / 110.0
        prev_mom = (110.0 - 100.0) / 100.0
        assert result["velocity"] == pytest.approx(curr_mom - prev_mom)

    def test_velocity_positive_when_accelerating(self):
        # 100 → 101 → 103: big jump at end
        result = compute_underlying_features(_buf(100.0, 101.0, 103.0))
        assert result["velocity"] > 0

    def test_velocity_negative_when_decelerating(self):
        # 100 → 103 → 104: slowing down
        result = compute_underlying_features(_buf(100.0, 103.0, 104.0))
        assert result["velocity"] < 0

    def test_velocity_nan_propagates_from_zero_prev_prev(self):
        # p2=0.0 → prev_mom=NaN → velocity=NaN
        result = compute_underlying_features(_buf(0.0, 100.0, 110.0))
        assert _nan(result["velocity"])

    def test_velocity_formula(self):
        # explicit formula check
        prices = [100.0, 105.0, 108.0]
        result = compute_underlying_features(_buf(*prices))
        curr_mom = (108.0 - 105.0) / 105.0
        prev_mom = (105.0 - 100.0) / 100.0
        assert result["velocity"] == pytest.approx(curr_mom - prev_mom)


# ── TestTickCounts ────────────────────────────────────────────────────────────


class TestTickCounts:
    """tick counts and tick_imbalance for windows 10/20/50."""

    def test_counts_nan_at_9_ticks(self):
        result = compute_underlying_features(_buf(*[100.0] * 9))
        for sfx in ("up", "down", "flat"):
            assert _nan(result[f"tick_{sfx}_count_10"]), sfx
        assert _nan(result["tick_imbalance_10"])

    def test_counts_available_at_10_ticks(self):
        # Use ascending prices so up+down > 0 and tick_imbalance is non-NaN
        prices = [100.0 + i for i in range(10)]
        result = compute_underlying_features(_buf(*prices))
        for sfx in ("up", "down", "flat"):
            assert not _nan(result[f"tick_{sfx}_count_10"]), sfx
        assert not _nan(result["tick_imbalance_10"])

    def test_counts_nan_20_at_19_ticks(self):
        result = compute_underlying_features(_buf(*[100.0] * 19))
        assert _nan(result["tick_up_count_20"])

    def test_counts_nan_50_at_49_ticks(self):
        result = compute_underlying_features(_buf(*[100.0] * 49))
        assert _nan(result["tick_up_count_50"])

    def test_all_up_counts(self):
        # 10 strictly increasing prices → 9 upticks
        prices = [100.0 + i for i in range(10)]
        result = compute_underlying_features(_buf(*prices))
        assert result["tick_up_count_10"] == pytest.approx(9.0)
        assert result["tick_down_count_10"] == pytest.approx(0.0)
        assert result["tick_flat_count_10"] == pytest.approx(0.0)

    def test_all_down_counts(self):
        # 10 strictly decreasing prices → 9 downticks
        prices = [110.0 - i for i in range(10)]
        result = compute_underlying_features(_buf(*prices))
        assert result["tick_down_count_10"] == pytest.approx(9.0)
        assert result["tick_up_count_10"] == pytest.approx(0.0)
        assert result["tick_flat_count_10"] == pytest.approx(0.0)

    def test_all_flat_counts(self):
        # 10 identical prices → 9 flat ticks
        result = compute_underlying_features(_buf(*[100.0] * 10))
        assert result["tick_flat_count_10"] == pytest.approx(9.0)
        assert result["tick_up_count_10"] == pytest.approx(0.0)
        assert result["tick_down_count_10"] == pytest.approx(0.0)

    def test_mixed_counts(self):
        # Prices: 100, 101, 100, 100, 102, 101, 102, 103, 103, 102
        # Diffs:       +1,  -1,   0,  +2,  -1,  +1,  +1,   0,  -1
        # up=4, down=3, flat=2  (9 comparisons total)
        prices = [100, 101, 100, 100, 102, 101, 102, 103, 103, 102]
        result = compute_underlying_features(_buf(*prices))
        assert result["tick_up_count_10"] == pytest.approx(4.0)
        assert result["tick_down_count_10"] == pytest.approx(3.0)
        assert result["tick_flat_count_10"] == pytest.approx(2.0)

    def test_sum_of_counts_equals_n_minus_1(self):
        prices = [100.0 + (i % 3) for i in range(10)]
        result = compute_underlying_features(_buf(*prices))
        total = (
            result["tick_up_count_10"] + result["tick_down_count_10"] + result["tick_flat_count_10"]
        )
        assert total == pytest.approx(9.0)  # 10 ticks → 9 comparisons

    def test_window_uses_last_n_ticks(self):
        # 15 ticks total; window-10 should only look at last 10
        # First 5: all flat at 100.0; last 10: all increasing
        prices = [100.0] * 5 + [200.0 + i for i in range(10)]
        result = compute_underlying_features(_buf(*prices))
        # Last 10 ticks: 200,201,...,209 → 9 upticks
        assert result["tick_up_count_10"] == pytest.approx(9.0)

    def test_20_window_independent_of_10_window(self):
        prices = [100.0 + i for i in range(20)]
        result = compute_underlying_features(_buf(*prices))
        assert result["tick_up_count_20"] == pytest.approx(19.0)
        assert result["tick_up_count_10"] == pytest.approx(9.0)

    def test_50_window_available_exactly_at_50_ticks(self):
        prices = [100.0 + i for i in range(50)]
        result = compute_underlying_features(_buf(*prices))
        assert result["tick_up_count_50"] == pytest.approx(49.0)
        assert result["tick_down_count_50"] == pytest.approx(0.0)
        assert result["tick_flat_count_50"] == pytest.approx(0.0)


# ── TestTickImbalance ─────────────────────────────────────────────────────────


class TestTickImbalance:
    """tick_imbalance_N = (up - down) / (N - 1), range [-1, +1]."""

    def test_imbalance_plus1_all_up(self):
        prices = [100.0 + i for i in range(10)]
        result = compute_underlying_features(_buf(*prices))
        assert result["tick_imbalance_10"] == pytest.approx(1.0)

    def test_imbalance_minus1_all_down(self):
        prices = [200.0 - i for i in range(10)]
        result = compute_underlying_features(_buf(*prices))
        assert result["tick_imbalance_10"] == pytest.approx(-1.0)

    def test_imbalance_zero_balanced(self):
        # 5 up + 4 down = 9 comparisons, (5-4)/9 ≈ 0.111
        # Or: alternating up/down → equal counts
        # 10 ticks alternating: 100,101,100,101,100,101,100,101,100,101
        # Diffs: +1,-1,+1,-1,+1,-1,+1,-1,+1 → 5 up, 4 down
        prices = [100.0 + (i % 2) for i in range(10)]
        result = compute_underlying_features(_buf(*prices))
        # 5 up, 4 down, 0 flat; imbalance = (5-4)/9
        assert result["tick_imbalance_10"] == pytest.approx(1 / 9)

    def test_imbalance_nan_all_flat(self):
        # up=0, down=0 → denominator (up+down)=0 → NaN per spec §8.2
        result = compute_underlying_features(_buf(*[100.0] * 10))
        assert _nan(result["tick_imbalance_10"])

    def test_imbalance_nan_at_9_ticks(self):
        result = compute_underlying_features(_buf(*[100.0] * 9))
        assert _nan(result["tick_imbalance_10"])

    def test_imbalance_formula_explicit(self):
        # mixed: 100, 101, 100, 100, 102, 101, 102, 103, 103, 102
        # up=4, down=3, flat=2; imbalance = (4-3)/(4+3) per spec §8.2
        prices = [100, 101, 100, 100, 102, 101, 102, 103, 103, 102]
        result = compute_underlying_features(_buf(*prices))
        assert result["tick_imbalance_10"] == pytest.approx((4 - 3) / (4 + 3))

    def test_imbalance_20_formula(self):
        prices = [100.0 + i for i in range(20)]  # 19 up, 0 down
        result = compute_underlying_features(_buf(*prices))
        assert result["tick_imbalance_20"] == pytest.approx(19.0 / 19.0)

    def test_imbalance_50_formula(self):
        prices = [100.0 - i for i in range(50)]  # 49 down, 0 up
        result = compute_underlying_features(_buf(*prices))
        assert result["tick_imbalance_50"] == pytest.approx(-49.0 / 49.0)


# ── TestNaNPropagation ────────────────────────────────────────────────────────


class TestNaNPropagation:
    """Confirm NaN is exactly float('nan') (not None, not 0)."""

    def test_nan_type_is_float(self):
        result = compute_underlying_features(_buf(100.0))
        nan_val = result["return_5ticks"]
        assert isinstance(nan_val, float)
        assert math.isnan(nan_val)

    def test_non_nan_values_are_not_nan(self):
        result = compute_underlying_features(_buf(100.0))
        for k in ("ltp", "bid", "ask", "spread"):
            assert not math.isnan(result[k]), f"{k!r} should not be NaN"

    def test_boundary_5tick_no_contamination(self):
        # At exactly 5 ticks, only return_5ticks is non-NaN among returns
        prices = [100.0 + i for i in range(5)]
        result = compute_underlying_features(_buf(*prices))
        assert not _nan(result["return_5ticks"])
        assert _nan(result["return_10ticks"])
        assert _nan(result["return_20ticks"])
        assert _nan(result["return_50ticks"])
