"""
tests/test_ofi_vol.py — Unit tests for features/ofi.py (§8.18) and
                         features/realized_vol.py (§8.19).
"""

from __future__ import annotations

import math
import statistics
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.buffers.tick_buffer import CircularBuffer, UnderlyingTick
from tick_feature_agent.features.ofi import _trade_direction, compute_ofi_features
from tick_feature_agent.features.realized_vol import compute_realized_vol_features

# ── Helpers ───────────────────────────────────────────────────────────────────


def _tick(ltp: float, bid: float = 0.0, ask: float = 0.0, volume: int = 0) -> UnderlyingTick:
    return UnderlyingTick(timestamp=0.0, ltp=ltp, bid=bid, ask=ask, volume=volume)


def _buf(*ticks: UnderlyingTick) -> CircularBuffer:
    buf = CircularBuffer(maxlen=50)
    for t in ticks:
        buf.push(t)
    return buf


def _price_buf(*prices: float, bid: float = 0.0, ask: float = 0.0) -> CircularBuffer:
    """Convenience: build buffer with given LTPs, cumulative volumes 1000+i*10."""
    buf = CircularBuffer(maxlen=50)
    for i, p in enumerate(prices):
        buf.push(_tick(p, bid=bid, ask=ask, volume=1000 + i * 10))
    return buf


def _nan(v) -> bool:
    return isinstance(v, float) and math.isnan(v)


# ══════════════════════════════════════════════════════════════════════════════
# §8.18 OFI — Trade Direction
# ══════════════════════════════════════════════════════════════════════════════


class TestTradeDirection:
    """Unit tests for the _trade_direction() helper."""

    def test_ltp_above_ask_is_buy(self):
        assert _trade_direction(24200.0, 24100.0, 24150.0) == 1.0

    def test_ltp_equals_ask_is_buy(self):
        # spec: ltp >= ask → aggressive buy (includes equality)
        assert _trade_direction(24150.0, 24100.0, 24150.0) == 1.0

    def test_ltp_below_bid_is_sell(self):
        assert _trade_direction(24050.0, 24100.0, 24150.0) == -1.0

    def test_ltp_equals_bid_is_sell(self):
        # spec: ltp <= bid → aggressive sell (includes equality)
        assert _trade_direction(24100.0, 24100.0, 24150.0) == -1.0

    def test_ltp_inside_spread_is_passive(self):
        assert _trade_direction(24120.0, 24100.0, 24150.0) == 0.0

    def test_zero_bid_ask_is_passive(self):
        # pre-depth state — treat as missing
        assert _trade_direction(24150.0, 0.0, 0.0) == 0.0

    def test_zero_spread_nonzero_is_buy(self):
        # bid = ask = ltp = 24150 (non-zero) → first condition fires
        assert _trade_direction(24150.0, 24150.0, 24150.0) == 1.0

    def test_ltp_below_bid_below_ask(self):
        # inverted market (theoretical) — ltp=24000 < bid=24100 < ask=24150
        assert _trade_direction(24000.0, 24100.0, 24150.0) == -1.0


# ══════════════════════════════════════════════════════════════════════════════
# §8.18 OFI — compute_ofi_features
# ══════════════════════════════════════════════════════════════════════════════


class TestOfiFeatureKeys:
    def test_exactly_4_keys(self):
        result = compute_ofi_features(CircularBuffer(maxlen=50))
        assert set(result) == {
            "underlying_trade_direction",
            "underlying_ofi_5",
            "underlying_ofi_20",
            "underlying_ofi_50",
        }


class TestTradeDirectionInOutput:
    def test_empty_buffer_returns_0(self):
        result = compute_ofi_features(CircularBuffer(maxlen=50))
        assert result["underlying_trade_direction"] == 0.0

    def test_first_tick_classified(self):
        buf = _buf(_tick(24150.0, bid=24100.0, ask=24150.0))  # ltp = ask → +1
        result = compute_ofi_features(buf)
        assert result["underlying_trade_direction"] == 1.0

    def test_trade_direction_never_nan(self):
        for n in range(0, 6):
            ticks = [_tick(100.0 + i, bid=99.0, ask=101.0) for i in range(n)]
            result = compute_ofi_features(_buf(*ticks))
            assert not _nan(result["underlying_trade_direction"]), f"NaN at n={n}"

    def test_uses_current_tick_only(self):
        # All older ticks are sells, current is buy
        ticks = [_tick(100.0, bid=101.0, ask=105.0)] * 4  # sells
        ticks.append(_tick(106.0, bid=101.0, ask=105.0))  # buy (ltp > ask)
        result = compute_ofi_features(_buf(*ticks))
        assert result["underlying_trade_direction"] == 1.0


class TestOfiNullBoundaries:
    def test_ofi_5_nan_at_4_ticks(self):
        ticks = [_tick(100.0 + i, bid=99.0, ask=101.0, volume=1000 + i * 10) for i in range(4)]
        result = compute_ofi_features(_buf(*ticks))
        assert _nan(result["underlying_ofi_5"])

    def test_ofi_5_available_at_5_ticks(self):
        ticks = [_tick(100.0 + i, bid=99.0, ask=101.0, volume=1000 + i * 10) for i in range(5)]
        result = compute_ofi_features(_buf(*ticks))
        assert not _nan(result["underlying_ofi_5"])

    def test_ofi_20_nan_at_19_ticks(self):
        ticks = [_tick(100.0 + i, bid=99.0, ask=101.0, volume=1000 + i * 10) for i in range(19)]
        result = compute_ofi_features(_buf(*ticks))
        assert _nan(result["underlying_ofi_20"])

    def test_ofi_20_available_at_20_ticks(self):
        ticks = [_tick(100.0 + i, bid=99.0, ask=101.0, volume=1000 + i * 10) for i in range(20)]
        result = compute_ofi_features(_buf(*ticks))
        assert not _nan(result["underlying_ofi_20"])

    def test_ofi_50_nan_at_49_ticks(self):
        ticks = [_tick(100.0 + i, bid=99.0, ask=101.0, volume=1000 + i * 10) for i in range(49)]
        result = compute_ofi_features(_buf(*ticks))
        assert _nan(result["underlying_ofi_50"])

    def test_ofi_50_available_at_50_ticks(self):
        ticks = [_tick(100.0 + i, bid=99.0, ask=101.0, volume=1000 + i * 10) for i in range(50)]
        result = compute_ofi_features(_buf(*ticks))
        assert not _nan(result["underlying_ofi_50"])


class TestOfiFormula:
    def test_all_buys_positive_ofi(self):
        # 5 ticks, all ltp >= ask → all +1; volumes 1000,1010,1020,1030,1040
        ticks = [_tick(105.0, bid=100.0, ask=105.0, volume=1000 + i * 10) for i in range(5)]
        result = compute_ofi_features(_buf(*ticks))
        # No predecessor; tick[0] delta = 0. Ticks 1..4 have deltas 10 each.
        # ofi_5 = 0 + 10 + 10 + 10 + 10 = 40
        assert result["underlying_ofi_5"] == pytest.approx(40.0)

    def test_all_sells_negative_ofi(self):
        # 5 ticks, all ltp <= bid → all -1; equal volumes
        ticks = [_tick(95.0, bid=100.0, ask=105.0, volume=1000 + i * 10) for i in range(5)]
        result = compute_ofi_features(_buf(*ticks))
        # ticks 1..4: delta=10 each, direction=-1 → ofi = -40
        assert result["underlying_ofi_5"] == pytest.approx(-40.0)

    def test_balanced_is_zero(self):
        # Alternating buys and sells with equal volume deltas
        ticks = []
        vol = 1000
        for i in range(5):
            ltp = 105.0 if i % 2 == 0 else 95.0  # buy / sell
            vol += 10
            ticks.append(_tick(ltp, bid=100.0, ask=105.0, volume=vol))
        result = compute_ofi_features(_buf(*ticks))
        # tick[0] (buy): delta=0, ticks 1..4 alternate sell/buy/sell/buy: delta=10 each
        # directions: 1,-1,1,-1,1 → contributions: 0, -10, +10, -10, +10 = 0
        assert result["underlying_ofi_5"] == pytest.approx(0.0)

    def test_explicit_formula(self):
        # 5 ticks, precise computation
        # vols: 1000, 1020, 1035, 1050, 1070
        # ltps: 105, 95, 105, 95, 105 (buy, sell, buy, sell, buy)
        # bid=100, ask=105
        ticks = [
            _tick(105.0, bid=100.0, ask=105.0, volume=1000),  # buy, no predecessor
            _tick(95.0, bid=100.0, ask=105.0, volume=1020),  # sell, Δ=20
            _tick(105.0, bid=100.0, ask=105.0, volume=1035),  # buy,  Δ=15
            _tick(95.0, bid=100.0, ask=105.0, volume=1050),  # sell, Δ=15
            _tick(105.0, bid=100.0, ask=105.0, volume=1070),  # buy,  Δ=20
        ]
        result = compute_ofi_features(_buf(*ticks))
        # contributions: 0, -20, +15, -15, +20 = 0
        assert result["underlying_ofi_5"] == pytest.approx(0.0)

    def test_predecessor_used_when_available(self):
        # 6 ticks: first is predecessor for window
        # tick[0]: vol=1000, tick[1..5] in window
        ticks = [
            _tick(100.0, bid=99.0, ask=101.0, volume=1000),  # predecessor
            _tick(102.0, bid=99.0, ask=101.0, volume=1010),  # buy, Δ=10
            _tick(102.0, bid=99.0, ask=101.0, volume=1020),  # buy, Δ=10
            _tick(102.0, bid=99.0, ask=101.0, volume=1035),  # buy, Δ=15
            _tick(102.0, bid=99.0, ask=101.0, volume=1045),  # buy, Δ=10
            _tick(102.0, bid=99.0, ask=101.0, volume=1060),  # buy, Δ=15
        ]
        result = compute_ofi_features(_buf(*ticks))
        # window = ticks[1..5], pred = ticks[0].vol=1000
        # Δvols: 10, 10, 15, 10, 15; all buy (+1)
        # ofi_5 = 10 + 10 + 15 + 10 + 15 = 60
        assert result["underlying_ofi_5"] == pytest.approx(60.0)

    def test_volume_decrease_clipped_to_zero(self):
        # Volume goes down (e.g. session reset or rollover): delta clamped to 0
        ticks = [
            _tick(105.0, bid=100.0, ask=105.0, volume=2000),
            _tick(105.0, bid=100.0, ask=105.0, volume=1000),  # drop! delta=max(0,-1000)=0
            _tick(105.0, bid=100.0, ask=105.0, volume=1010),
            _tick(105.0, bid=100.0, ask=105.0, volume=1020),
            _tick(105.0, bid=100.0, ask=105.0, volume=1030),
        ]
        result = compute_ofi_features(_buf(*ticks))
        # tick[0]: no pred → Δ=0. tick[1]: Δ=max(0,-1000)=0. tick[2..4]: Δ=10 each.
        # ofi_5 = 0 + 0 + 10 + 10 + 10 = 30
        assert result["underlying_ofi_5"] == pytest.approx(30.0)

    def test_pre_depth_ticks_contribute_zero_direction(self):
        # bid=ask=0 → direction=0 → no contribution regardless of volume
        ticks = [_tick(100.0, bid=0.0, ask=0.0, volume=1000 + i * 10) for i in range(5)]
        result = compute_ofi_features(_buf(*ticks))
        assert result["underlying_ofi_5"] == pytest.approx(0.0)

    def test_zero_volume_ticks_contribute_nothing(self):
        # All volume deltas are 0 → ofi = 0 regardless of direction
        ticks = [_tick(105.0, bid=100.0, ask=105.0, volume=0) for _ in range(5)]
        result = compute_ofi_features(_buf(*ticks))
        assert result["underlying_ofi_5"] == pytest.approx(0.0)


# ══════════════════════════════════════════════════════════════════════════════
# §8.19 Realized Volatility — compute_realized_vol_features
# ══════════════════════════════════════════════════════════════════════════════


class TestRealizedVolFeatureKeys:
    def test_exactly_3_keys(self):
        result = compute_realized_vol_features(CircularBuffer(maxlen=50))
        assert set(result) == {
            "underlying_realized_vol_5",
            "underlying_realized_vol_20",
            "underlying_realized_vol_50",
        }


class TestRealizedVolNullBoundaries:
    def test_nan_at_4_ticks(self):
        result = compute_realized_vol_features(_price_buf(*[100.0] * 4))
        assert _nan(result["underlying_realized_vol_5"])

    def test_available_at_5_ticks(self):
        result = compute_realized_vol_features(_price_buf(*[100.0] * 5))
        assert not _nan(result["underlying_realized_vol_5"])

    def test_nan_20_at_19_ticks(self):
        result = compute_realized_vol_features(_price_buf(*[100.0] * 19))
        assert _nan(result["underlying_realized_vol_20"])

    def test_available_20_at_20_ticks(self):
        result = compute_realized_vol_features(_price_buf(*[100.0] * 20))
        assert not _nan(result["underlying_realized_vol_20"])

    def test_nan_50_at_49_ticks(self):
        result = compute_realized_vol_features(_price_buf(*[100.0] * 49))
        assert _nan(result["underlying_realized_vol_50"])

    def test_available_50_at_50_ticks(self):
        result = compute_realized_vol_features(_price_buf(*[100.0] * 50))
        assert not _nan(result["underlying_realized_vol_50"])

    def test_smaller_windows_available_earlier(self):
        result = compute_realized_vol_features(_price_buf(*[100.0] * 5))
        assert not _nan(result["underlying_realized_vol_5"])
        assert _nan(result["underlying_realized_vol_20"])
        assert _nan(result["underlying_realized_vol_50"])


class TestRealizedVolFormula:
    def test_zero_vol_when_all_prices_identical(self):
        # spec: realized_vol_5 = 0.0 if all 5 prices identical
        result = compute_realized_vol_features(_price_buf(*[24150.0] * 5))
        assert result["underlying_realized_vol_5"] == pytest.approx(0.0)
        assert not _nan(result["underlying_realized_vol_5"])

    def test_nan_when_any_price_is_zero(self):
        # log(x/0) is undefined
        prices = [0.0, 100.0, 101.0, 102.0, 103.0]
        result = compute_realized_vol_features(_price_buf(*prices))
        assert _nan(result["underlying_realized_vol_5"])

    def test_nan_when_price_is_negative(self):
        prices = [100.0, 101.0, -1.0, 102.0, 103.0]
        result = compute_realized_vol_features(_price_buf(*prices))
        assert _nan(result["underlying_realized_vol_5"])

    def test_vol_is_nonnegative(self):
        prices = [100.0, 101.0, 99.5, 102.0, 98.0]
        result = compute_realized_vol_features(_price_buf(*prices))
        assert result["underlying_realized_vol_5"] >= 0.0

    def test_explicit_formula(self):
        # 5 prices: 100, 102, 101, 103, 104
        prices = [100.0, 102.0, 101.0, 103.0, 104.0]
        result = compute_realized_vol_features(_price_buf(*prices))
        log_returns = [
            math.log(102 / 100),
            math.log(101 / 102),
            math.log(103 / 101),
            math.log(104 / 103),
        ]
        expected = statistics.stdev(log_returns)
        assert result["underlying_realized_vol_5"] == pytest.approx(expected)

    def test_higher_vol_for_more_volatile_prices(self):
        # Low vol: small moves
        low_vol = _price_buf(100.0, 100.1, 100.0, 100.1, 100.0)
        # High vol: large moves
        high_vol = _price_buf(100.0, 105.0, 95.0, 108.0, 92.0)
        r_low = compute_realized_vol_features(low_vol)
        r_high = compute_realized_vol_features(high_vol)
        assert r_high["underlying_realized_vol_5"] > r_low["underlying_realized_vol_5"]

    def test_uses_last_n_ticks_not_all(self):
        # Push 10 ticks; first 5 are very volatile, last 5 are flat
        volatile = [100.0, 110.0, 90.0, 115.0, 85.0]
        flat = [100.0, 100.0, 100.0, 100.0, 100.0]
        result_mixed = compute_realized_vol_features(_price_buf(*volatile, *flat))
        result_flat = compute_realized_vol_features(_price_buf(*flat))
        # vol_5 should use the flat window → near zero
        assert result_mixed["underlying_realized_vol_5"] == pytest.approx(
            result_flat["underlying_realized_vol_5"]
        )

    def test_vol_20_uses_last_20_of_50_ticks(self):
        # 50 ticks: 30 volatile + 20 flat; realized_vol_20 should reflect flat window
        volatile = [100.0 + (i % 2) * 10 for i in range(30)]  # 100/110 alternating
        flat = [100.0] * 20
        buf = _price_buf(*volatile, *flat)
        result = compute_realized_vol_features(buf)
        flat_result = compute_realized_vol_features(_price_buf(*flat))
        assert result["underlying_realized_vol_20"] == pytest.approx(
            flat_result["underlying_realized_vol_20"]
        )

    def test_sample_std_not_population_std(self):
        # With 4 log returns, sample std (ddof=1) != population std (ddof=0)
        prices = [100.0, 102.0, 98.0, 104.0, 96.0]
        result = compute_realized_vol_features(_price_buf(*prices))
        log_returns = [
            math.log(102 / 100),
            math.log(98 / 102),
            math.log(104 / 98),
            math.log(96 / 104),
        ]
        sample_std = statistics.stdev(log_returns)  # ddof=1
        pop_std = statistics.pstdev(log_returns)  # ddof=0
        assert sample_std != pop_std  # they differ
        assert result["underlying_realized_vol_5"] == pytest.approx(sample_std)
        assert result["underlying_realized_vol_5"] != pytest.approx(pop_std, rel=1e-6)
