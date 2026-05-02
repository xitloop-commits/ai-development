"""
tests/test_option_tick_horizon.py — Unit tests for:
    features/option_tick.py  (§8.4 + §8.21 premium_momentum_10)
    features/horizon.py      (§8.20 multi-horizon ratios)
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

from tick_feature_agent.buffers.option_buffer import OptionBufferStore, OptionTick
from tick_feature_agent.features.horizon import compute_horizon_features
from tick_feature_agent.features.option_tick import (
    _bid_ask_imbalance,
    compute_option_tick_features,
)

# ── Helpers ───────────────────────────────────────────────────────────────────

_STRIKE_STEP = 50
_ATM = 24150
_ATM_WINDOW = [_ATM + i * _STRIKE_STEP for i in range(-3, 4)]  # 7 strikes


def _otick(
    ltp=100.0, bid=99.0, ask=101.0, bid_size=100, ask_size=80, volume=5000, ts=0.0
) -> OptionTick:
    return OptionTick(
        timestamp=ts, ltp=ltp, bid=bid, ask=ask, bid_size=bid_size, ask_size=ask_size, volume=volume
    )


def _store_with(*ticks_for_all: OptionTick, strikes=None, opt_type="CE") -> OptionBufferStore:
    """Push the same tick sequence into one (strike, opt_type) pair."""
    if strikes is None:
        strikes = [_ATM]
    store = OptionBufferStore(maxlen=10)
    store.register_strikes(strikes, opt_types=["CE", "PE"])
    for t in ticks_for_all:
        for s in strikes:
            store.push(s, opt_type, t)
    return store


def _nan(v) -> bool:
    return isinstance(v, float) and math.isnan(v)


# ══════════════════════════════════════════════════════════════════════════════
# option_tick.py — _bid_ask_imbalance helper
# ══════════════════════════════════════════════════════════════════════════════


class TestBidAskImbalance:
    def test_more_bids_is_positive(self):
        t = _otick(bid_size=200, ask_size=100)
        assert _bid_ask_imbalance(t) == pytest.approx((200 - 100) / 300)

    def test_more_asks_is_negative(self):
        t = _otick(bid_size=100, ask_size=200)
        assert _bid_ask_imbalance(t) == pytest.approx(-100 / 300)

    def test_equal_sizes_is_zero(self):
        t = _otick(bid_size=100, ask_size=100)
        assert _bid_ask_imbalance(t) == pytest.approx(0.0)

    def test_all_bids_is_plus_one(self):
        t = _otick(bid_size=500, ask_size=0)
        assert _bid_ask_imbalance(t) == pytest.approx(1.0)

    def test_all_asks_is_minus_one(self):
        t = _otick(bid_size=0, ask_size=500)
        assert _bid_ask_imbalance(t) == pytest.approx(-1.0)

    def test_both_zero_is_nan(self):
        t = _otick(bid_size=0, ask_size=0)
        assert _nan(_bid_ask_imbalance(t))


# ══════════════════════════════════════════════════════════════════════════════
# option_tick.py — compute_option_tick_features
# ══════════════════════════════════════════════════════════════════════════════


class TestOptionTickFeatureKeys:
    def test_returns_14_pairs_for_7_strikes(self):
        store = OptionBufferStore(maxlen=10)
        result = compute_option_tick_features(_ATM_WINDOW, store)
        assert len(result) == 14  # 7 strikes × 2 opt_types

    def test_all_strikes_in_window_present(self):
        store = OptionBufferStore(maxlen=10)
        result = compute_option_tick_features(_ATM_WINDOW, store)
        for strike in _ATM_WINDOW:
            for ot in ("CE", "PE"):
                assert (strike, ot) in result

    def test_each_entry_has_9_features(self):
        store = OptionBufferStore(maxlen=10)
        result = compute_option_tick_features(_ATM_WINDOW, store)
        expected_keys = {
            "tick_available",
            "ltp",
            "bid",
            "ask",
            "spread",
            "volume",
            "bid_ask_imbalance",
            "premium_momentum",
            "premium_momentum_10",
        }
        for key, feat in result.items():
            assert set(feat) == expected_keys, f"wrong keys for {key}"


class TestTickAvailability:
    def test_no_ticks_gives_tick_available_0(self):
        store = OptionBufferStore(maxlen=10)
        result = compute_option_tick_features([_ATM], store)
        assert result[(_ATM, "CE")]["tick_available"] == 0

    def test_tick_available_1_after_push(self):
        store = OptionBufferStore(maxlen=10)
        store.push(_ATM, "CE", _otick())
        result = compute_option_tick_features([_ATM], store)
        assert result[(_ATM, "CE")]["tick_available"] == 1

    def test_all_nan_when_no_ticks(self):
        store = OptionBufferStore(maxlen=10)
        result = compute_option_tick_features([_ATM], store)
        feat = result[(_ATM, "CE")]
        for k, v in feat.items():
            if k == "tick_available":
                continue
            assert _nan(v), f"{k} should be NaN when no ticks, got {v}"

    def test_ce_and_pe_tracked_independently(self):
        store = OptionBufferStore(maxlen=10)
        store.push(_ATM, "CE", _otick(ltp=150.0))
        result = compute_option_tick_features([_ATM], store)
        assert result[(_ATM, "CE")]["tick_available"] == 1
        assert result[(_ATM, "PE")]["tick_available"] == 0


class TestInstantFeatures:
    def test_ltp_bid_ask_spread_correct(self):
        store = OptionBufferStore(maxlen=10)
        store.push(_ATM, "CE", _otick(ltp=120.5, bid=119.0, ask=122.0))
        feat = compute_option_tick_features([_ATM], store)[(_ATM, "CE")]
        assert feat["ltp"] == pytest.approx(120.5)
        assert feat["bid"] == pytest.approx(119.0)
        assert feat["ask"] == pytest.approx(122.0)
        assert feat["spread"] == pytest.approx(3.0)

    def test_volume_from_tick(self):
        store = OptionBufferStore(maxlen=10)
        store.push(_ATM, "CE", _otick(volume=12345))
        feat = compute_option_tick_features([_ATM], store)[(_ATM, "CE")]
        assert feat["volume"] == pytest.approx(12345.0)

    def test_bid_ask_imbalance_computed(self):
        store = OptionBufferStore(maxlen=10)
        store.push(_ATM, "CE", _otick(bid_size=300, ask_size=100))
        feat = compute_option_tick_features([_ATM], store)[(_ATM, "CE")]
        assert feat["bid_ask_imbalance"] == pytest.approx((300 - 100) / 400)

    def test_bid_ask_imbalance_nan_when_sizes_zero(self):
        store = OptionBufferStore(maxlen=10)
        store.push(_ATM, "CE", _otick(bid_size=0, ask_size=0))
        feat = compute_option_tick_features([_ATM], store)[(_ATM, "CE")]
        assert _nan(feat["bid_ask_imbalance"])


class TestPremiumMomentum:
    def test_premium_momentum_nan_at_4_ticks(self):
        store = OptionBufferStore(maxlen=10)
        for i in range(4):
            store.push(_ATM, "CE", _otick(ltp=100.0 + i, ts=float(i)))
        feat = compute_option_tick_features([_ATM], store)[(_ATM, "CE")]
        assert _nan(feat["premium_momentum"])

    def test_premium_momentum_available_at_5_ticks(self):
        store = OptionBufferStore(maxlen=10)
        for i in range(5):
            store.push(_ATM, "CE", _otick(ltp=100.0 + i, ts=float(i)))
        feat = compute_option_tick_features([_ATM], store)[(_ATM, "CE")]
        assert not _nan(feat["premium_momentum"])
        assert feat["premium_momentum"] == pytest.approx(4.0)  # 104 - 100

    def test_premium_momentum_uses_last_5(self):
        store = OptionBufferStore(maxlen=10)
        for i in range(8):
            store.push(_ATM, "CE", _otick(ltp=100.0 + i, ts=float(i)))
        # last 5: ticks with ltp=103,104,105,106,107 → momentum = 107-103=4
        feat = compute_option_tick_features([_ATM], store)[(_ATM, "CE")]
        assert feat["premium_momentum"] == pytest.approx(4.0)

    def test_premium_momentum_nan_when_time_span_exceeds_threshold(self):
        store = OptionBufferStore(maxlen=10)
        # 5 ticks but spread over 100s (> default 60s threshold)
        store.push(_ATM, "CE", _otick(ltp=100.0, ts=0.0))
        for i in range(4):
            store.push(_ATM, "CE", _otick(ltp=105.0, ts=90.0 + i))
        feat = compute_option_tick_features([_ATM], store, staleness_threshold_sec=60.0)[
            (_ATM, "CE")
        ]
        assert _nan(feat["premium_momentum"])

    def test_premium_momentum_valid_within_threshold(self):
        store = OptionBufferStore(maxlen=10)
        # 5 ticks spread over 30s (< default 60s threshold)
        for i in range(5):
            store.push(_ATM, "CE", _otick(ltp=100.0 + i * 2.0, ts=float(i * 7)))
        feat = compute_option_tick_features([_ATM], store, staleness_threshold_sec=60.0)[
            (_ATM, "CE")
        ]
        assert not _nan(feat["premium_momentum"])
        assert feat["premium_momentum"] == pytest.approx(8.0)  # 108 - 100

    def test_premium_momentum_10_nan_at_9_ticks(self):
        store = OptionBufferStore(maxlen=10)
        for i in range(9):
            store.push(_ATM, "CE", _otick(ltp=100.0 + i, ts=float(i)))
        feat = compute_option_tick_features([_ATM], store)[(_ATM, "CE")]
        assert _nan(feat["premium_momentum_10"])

    def test_premium_momentum_10_available_at_10_ticks(self):
        store = OptionBufferStore(maxlen=10)
        for i in range(10):
            store.push(_ATM, "CE", _otick(ltp=100.0 + i, ts=float(i)))
        feat = compute_option_tick_features([_ATM], store)[(_ATM, "CE")]
        assert not _nan(feat["premium_momentum_10"])
        # ltp_now=109, ltp_10_ago=100 → 9.0
        assert feat["premium_momentum_10"] == pytest.approx(9.0)

    def test_premium_momentum_10_nan_when_stale(self):
        store = OptionBufferStore(maxlen=10)
        # First tick at t=0, rest at t=200 (span=200 > 60 threshold)
        store.push(_ATM, "CE", _otick(ltp=100.0, ts=0.0))
        for i in range(9):
            store.push(_ATM, "CE", _otick(ltp=105.0, ts=200.0 + i))
        feat = compute_option_tick_features([_ATM], store, staleness_threshold_sec=60.0)[
            (_ATM, "CE")
        ]
        assert _nan(feat["premium_momentum_10"])


class TestMultipleStrikes:
    def test_different_strikes_independent(self):
        strikes = [24100, 24150, 24200]
        store = OptionBufferStore(maxlen=10)
        store.push(24100, "CE", _otick(ltp=50.0))
        store.push(24200, "CE", _otick(ltp=150.0))
        result = compute_option_tick_features(strikes, store)
        assert result[(24100, "CE")]["ltp"] == pytest.approx(50.0)
        assert result[(24150, "CE")]["tick_available"] == 0
        assert result[(24200, "CE")]["ltp"] == pytest.approx(150.0)

    def test_all_14_pairs_for_atm_window(self):
        store = OptionBufferStore(maxlen=10)
        result = compute_option_tick_features(_ATM_WINDOW, store)
        assert len(result) == 14


# ══════════════════════════════════════════════════════════════════════════════
# horizon.py — compute_horizon_features
# ══════════════════════════════════════════════════════════════════════════════

_NAN_DICT = {
    "return_5ticks": math.nan,
    "return_50ticks": math.nan,
    "underlying_realized_vol_5": math.nan,
    "underlying_realized_vol_20": math.nan,
    "underlying_ofi_5": math.nan,
    "underlying_ofi_50": math.nan,
}


class TestHorizonFeatureKeys:
    def test_exactly_3_keys(self):
        result = compute_horizon_features({}, {}, {})
        assert set(result) == {
            "underlying_horizon_momentum_ratio",
            "underlying_horizon_vol_ratio",
            "underlying_horizon_ofi_ratio",
        }


class TestHorizonNullBehavior:
    def test_all_nan_when_all_inputs_nan(self):
        result = compute_horizon_features(
            {"return_5ticks": math.nan, "return_50ticks": math.nan},
            {"underlying_ofi_5": math.nan, "underlying_ofi_50": math.nan},
            {"underlying_realized_vol_5": math.nan, "underlying_realized_vol_20": math.nan},
        )
        for k, v in result.items():
            assert _nan(v), f"{k} should be NaN"

    def test_nan_when_denominator_is_zero(self):
        result = compute_horizon_features(
            {"return_5ticks": 0.02, "return_50ticks": 0.0},  # denominator = 0
            {"underlying_ofi_5": 100.0, "underlying_ofi_50": 0.0},  # denominator = 0
            {"underlying_realized_vol_5": 0.005, "underlying_realized_vol_20": 0.0},  # denom = 0
        )
        assert _nan(result["underlying_horizon_momentum_ratio"])
        assert _nan(result["underlying_horizon_vol_ratio"])
        assert _nan(result["underlying_horizon_ofi_ratio"])

    def test_nan_when_numerator_is_nan(self):
        result = compute_horizon_features(
            {"return_5ticks": math.nan, "return_50ticks": 0.01},
            {"underlying_ofi_5": math.nan, "underlying_ofi_50": 50.0},
            {"underlying_realized_vol_5": math.nan, "underlying_realized_vol_20": 0.01},
        )
        assert _nan(result["underlying_horizon_momentum_ratio"])
        assert _nan(result["underlying_horizon_ofi_ratio"])
        assert _nan(result["underlying_horizon_vol_ratio"])

    def test_nan_when_denominator_is_nan(self):
        result = compute_horizon_features(
            {"return_5ticks": 0.02, "return_50ticks": math.nan},
            {"underlying_ofi_5": 100.0, "underlying_ofi_50": math.nan},
            {"underlying_realized_vol_5": 0.005, "underlying_realized_vol_20": math.nan},
        )
        assert _nan(result["underlying_horizon_momentum_ratio"])
        assert _nan(result["underlying_horizon_ofi_ratio"])
        assert _nan(result["underlying_horizon_vol_ratio"])


class TestHorizonFormula:
    def test_momentum_ratio_formula(self):
        result = compute_horizon_features(
            {"return_5ticks": 0.02, "return_50ticks": 0.01},
            {"underlying_ofi_5": 0.0, "underlying_ofi_50": 1.0},
            {"underlying_realized_vol_5": 0.0, "underlying_realized_vol_20": 1.0},
        )
        assert result["underlying_horizon_momentum_ratio"] == pytest.approx(2.0)

    def test_vol_ratio_formula(self):
        result = compute_horizon_features(
            {"return_5ticks": 0.0, "return_50ticks": 1.0},
            {"underlying_ofi_5": 0.0, "underlying_ofi_50": 1.0},
            {"underlying_realized_vol_5": 0.006, "underlying_realized_vol_20": 0.003},
        )
        assert result["underlying_horizon_vol_ratio"] == pytest.approx(2.0)

    def test_ofi_ratio_formula(self):
        result = compute_horizon_features(
            {"return_5ticks": 0.0, "return_50ticks": 1.0},
            {"underlying_ofi_5": 300.0, "underlying_ofi_50": 150.0},
            {"underlying_realized_vol_5": 0.0, "underlying_realized_vol_20": 1.0},
        )
        assert result["underlying_horizon_ofi_ratio"] == pytest.approx(2.0)

    def test_negative_ratio_allowed(self):
        # return_5 and return_50 have opposite signs
        result = compute_horizon_features(
            {"return_5ticks": -0.02, "return_50ticks": 0.01},
            {"underlying_ofi_5": 0.0, "underlying_ofi_50": 1.0},
            {"underlying_realized_vol_5": 0.0, "underlying_realized_vol_20": 1.0},
        )
        assert result["underlying_horizon_momentum_ratio"] == pytest.approx(-2.0)

    def test_ratio_can_exceed_one(self):
        result = compute_horizon_features(
            {"return_5ticks": 0.1, "return_50ticks": 0.01},
            {"underlying_ofi_5": 0.0, "underlying_ofi_50": 1.0},
            {"underlying_realized_vol_5": 0.0, "underlying_realized_vol_20": 1.0},
        )
        assert result["underlying_horizon_momentum_ratio"] == pytest.approx(10.0)

    def test_missing_keys_treated_as_nan(self):
        # Passing empty dicts should yield all NaN
        result = compute_horizon_features({}, {}, {})
        for k, v in result.items():
            assert _nan(v), k
