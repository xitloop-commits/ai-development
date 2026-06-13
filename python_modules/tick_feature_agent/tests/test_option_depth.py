"""
Tests for T37 order-book depth features (levels 1-4).

Covers:
  - OptionTick NamedTuple extension is backward-compatible (default
    zero values for legacy callers).
  - depth_levels_to_kwargs maps the recorded depth-array shape into
    OptionTick kwargs.
  - compute_depth_features:
    - Returns all-NaN dict on None / synthetic ticks / illiquid books.
    - Bid-heavy + ask-heavy imbalance signs.
    - Wall detection: max_qty + level identification.
    - Quantity-weighted price: skips empty levels.
    - Slope sign: positive when liquidity drops with depth.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_PY_MODULES = _HERE.parents[1]
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

from tick_feature_agent.buffers.option_buffer import (  # noqa: E402
    OptionTick,
    depth_levels_to_kwargs,
)
from tick_feature_agent.features.option_depth import (  # noqa: E402
    N_DEPTH_FEATURES,
    compute_depth_features,
    feature_column_names,
)


# ── OptionTick backward compatibility ────────────────────────────────────────


def test_option_tick_legacy_construction_still_works() -> None:
    """Pre-T37 callers passed only the original 7 fields. The extension
    must keep that working — depth fields default to zero."""
    t = OptionTick(
        timestamp=1700000000.0,
        ltp=100.0,
        bid=99.5,
        ask=100.5,
        bid_size=10,
        ask_size=15,
        volume=500,
    )
    assert t.bid == 99.5
    assert t.l1_bid_qty == 0
    assert t.l4_ask_price == 0.0


def test_option_tick_full_construction_holds_depth() -> None:
    t = OptionTick(
        timestamp=0.0, ltp=100.0,
        bid=99.5, ask=100.5,
        bid_size=10, ask_size=15, volume=0,
        l1_bid_price=99.4, l1_ask_price=100.6, l1_bid_qty=20, l1_ask_qty=25,
        l2_bid_price=99.3, l2_ask_price=100.7, l2_bid_qty=30, l2_ask_qty=35,
        l3_bid_price=99.2, l3_ask_price=100.8, l3_bid_qty=40, l3_ask_qty=45,
        l4_bid_price=99.1, l4_ask_price=100.9, l4_bid_qty=50, l4_ask_qty=55,
    )
    assert t.l1_bid_qty == 20
    assert t.l4_ask_price == 100.9


# ── depth_levels_to_kwargs ───────────────────────────────────────────────────


def test_depth_levels_to_kwargs_empty_returns_empty() -> None:
    assert depth_levels_to_kwargs(None) == {}
    assert depth_levels_to_kwargs([]) == {}


def test_depth_levels_to_kwargs_extracts_levels_1_through_4() -> None:
    depth = [
        # Level 0 — top of book, ignored by helper
        {"bid_qty": 10, "ask_qty": 15, "bid_price": 99.5, "ask_price": 100.5},
        {"bid_qty": 20, "ask_qty": 25, "bid_price": 99.4, "ask_price": 100.6},
        {"bid_qty": 30, "ask_qty": 35, "bid_price": 99.3, "ask_price": 100.7},
        {"bid_qty": 40, "ask_qty": 45, "bid_price": 99.2, "ask_price": 100.8},
        {"bid_qty": 50, "ask_qty": 55, "bid_price": 99.1, "ask_price": 100.9},
    ]
    out = depth_levels_to_kwargs(depth)
    # Level 0 is NOT in the output — already exposed via bid/ask.
    assert "l0_bid_price" not in out
    assert out["l1_bid_qty"] == 20
    assert out["l4_ask_price"] == 100.9


def test_depth_levels_to_kwargs_short_array_yields_partial_kwargs() -> None:
    """Recorded depth that's shorter than 5 levels (rare but possible
    on a malformed packet) must not crash; missing levels stay at
    OptionTick defaults."""
    depth = [
        {"bid_qty": 10, "ask_qty": 15, "bid_price": 99.5, "ask_price": 100.5},
        {"bid_qty": 20, "ask_qty": 25, "bid_price": 99.4, "ask_price": 100.6},
    ]  # only levels 0 and 1
    out = depth_levels_to_kwargs(depth)
    assert out["l1_bid_qty"] == 20
    assert "l2_bid_qty" not in out  # level 2 absent → no kwarg


# ── compute_depth_features ──────────────────────────────────────────────────


def _assert_all_nan(result: dict, expected_keys: int = N_DEPTH_FEATURES) -> None:
    assert len(result) == expected_keys
    for k, v in result.items():
        assert math.isnan(v), f"{k} = {v!r} (expected NaN)"


def test_compute_returns_all_nan_for_none_tick() -> None:
    _assert_all_nan(compute_depth_features(None))


def test_compute_returns_all_nan_for_empty_depth() -> None:
    """A legacy synthetic tick (no L1-L4) → all NaN.
    NOT zero — see module docstring."""
    t = OptionTick(
        timestamp=0.0, ltp=100.0,
        bid=99.5, ask=100.5,
        bid_size=10, ask_size=15, volume=0,
    )
    _assert_all_nan(compute_depth_features(t))


def test_compute_bid_heavy_imbalance_positive() -> None:
    """Bid sum 200, ask sum 50 → strong positive imbalance."""
    t = OptionTick(
        timestamp=0.0, ltp=100.0,
        bid=99.5, ask=100.5,
        bid_size=10, ask_size=15, volume=0,
        l1_bid_price=99.4, l1_ask_price=100.6, l1_bid_qty=50, l1_ask_qty=10,
        l2_bid_price=99.3, l2_ask_price=100.7, l2_bid_qty=50, l2_ask_qty=10,
        l3_bid_price=99.2, l3_ask_price=100.8, l3_bid_qty=50, l3_ask_qty=10,
        l4_bid_price=99.1, l4_ask_price=100.9, l4_bid_qty=50, l4_ask_qty=20,
    )
    out = compute_depth_features(t)
    assert out["depth_bid_qty_sum_l1_4"] == 200.0
    assert out["depth_ask_qty_sum_l1_4"] == 50.0
    assert out["depth_imbalance_l1_4"] == pytest.approx(150 / 250)
    assert out["depth_total_qty_l1_4"] == 250.0


def test_compute_ask_heavy_imbalance_negative() -> None:
    t = OptionTick(
        timestamp=0.0, ltp=100.0,
        bid=99.5, ask=100.5,
        bid_size=10, ask_size=15, volume=0,
        l1_bid_price=99.4, l1_ask_price=100.6, l1_bid_qty=5, l1_ask_qty=50,
        l2_bid_price=99.3, l2_ask_price=100.7, l2_bid_qty=5, l2_ask_qty=50,
        l3_bid_price=99.2, l3_ask_price=100.8, l3_bid_qty=5, l3_ask_qty=50,
        l4_bid_price=99.1, l4_ask_price=100.9, l4_bid_qty=5, l4_ask_qty=50,
    )
    out = compute_depth_features(t)
    assert out["depth_imbalance_l1_4"] < 0
    assert out["depth_imbalance_l1_4"] == pytest.approx(-180 / 220)


def test_compute_wall_detection_picks_max_level() -> None:
    """A 'wall' of 500 bids at level 3 should surface as max_bid_qty=500
    and max_qty_level_bid=3."""
    t = OptionTick(
        timestamp=0.0, ltp=100.0,
        bid=99.5, ask=100.5,
        bid_size=10, ask_size=15, volume=0,
        l1_bid_price=99.4, l1_ask_price=100.6, l1_bid_qty=10, l1_ask_qty=10,
        l2_bid_price=99.3, l2_ask_price=100.7, l2_bid_qty=10, l2_ask_qty=10,
        l3_bid_price=99.2, l3_ask_price=100.8, l3_bid_qty=500, l3_ask_qty=10,
        l4_bid_price=99.1, l4_ask_price=100.9, l4_bid_qty=10, l4_ask_qty=10,
    )
    out = compute_depth_features(t)
    assert out["depth_max_bid_qty_l1_4"] == 500.0
    assert out["depth_max_qty_level_bid"] == 3.0
    # No corresponding ask wall.
    assert out["depth_max_ask_qty_l1_4"] == 10.0


def test_compute_weighted_price_skips_empty_levels() -> None:
    """A level with qty=0 must NOT pull the weighted price toward 0.
    Only non-empty levels contribute."""
    t = OptionTick(
        timestamp=0.0, ltp=100.0,
        bid=99.5, ask=100.5,
        bid_size=10, ask_size=15, volume=0,
        # L1: 100 @ 99.5 → contributes
        l1_bid_price=99.5, l1_ask_price=100.5, l1_bid_qty=100, l1_ask_qty=0,
        # L2: empty bid (qty=0) → must NOT pull weighted toward 0.0
        l2_bid_price=99.4, l2_ask_price=100.6, l2_bid_qty=0, l2_ask_qty=0,
        # L3: 100 @ 99.3 → contributes
        l3_bid_price=99.3, l3_ask_price=100.7, l3_bid_qty=100, l3_ask_qty=0,
        l4_bid_price=0.0, l4_ask_price=0.0, l4_bid_qty=0, l4_ask_qty=0,
    )
    out = compute_depth_features(t)
    # Weighted bid = (99.5*100 + 99.3*100) / 200 = 99.4
    assert out["depth_weighted_bid"] == pytest.approx(99.4, abs=1e-6)
    # No ask qty anywhere — weighted ask NaN.
    assert math.isnan(out["depth_weighted_ask"])
    assert math.isnan(out["depth_weighted_spread"])


def test_compute_slope_positive_when_liquidity_drops_with_depth() -> None:
    """L1=100 → L4=20: positive slope (book thinner at deeper levels)."""
    t = OptionTick(
        timestamp=0.0, ltp=100.0,
        bid=99.5, ask=100.5,
        bid_size=10, ask_size=15, volume=0,
        l1_bid_price=99.4, l1_ask_price=100.6, l1_bid_qty=100, l1_ask_qty=80,
        l2_bid_price=99.3, l2_ask_price=100.7, l2_bid_qty=60, l2_ask_qty=50,
        l3_bid_price=99.2, l3_ask_price=100.8, l3_bid_qty=40, l3_ask_qty=30,
        l4_bid_price=99.1, l4_ask_price=100.9, l4_bid_qty=20, l4_ask_qty=10,
    )
    out = compute_depth_features(t)
    assert out["depth_slope_bid"] == 80.0  # 100 - 20
    assert out["depth_slope_ask"] == 70.0  # 80 - 10


# ── feature_column_names ────────────────────────────────────────────────────


def test_feature_column_names_uses_prefix_and_stable_order() -> None:
    cols = feature_column_names("opt_0_ce")
    assert len(cols) == N_DEPTH_FEATURES
    assert cols[0] == "opt_0_ce_depth_bid_qty_sum_l1_4"
    # Calling twice yields the same order — caller relies on this for
    # parquet schema stability.
    assert cols == feature_column_names("opt_0_ce")
