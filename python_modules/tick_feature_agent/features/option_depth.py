"""
option_depth.py — T37 §X order-book depth features (levels 1-4).

Derives ~12 columns per active ATM strike from the 5-level depth array
that Dhan FULL packets carry. Level 0 (top-of-book) is already exposed
via existing ``opt_*_bid``, ``opt_*_ask``, ``opt_*_bid_size``,
``opt_*_ask_size`` columns; this module adds aggregates over levels 1-4
that the existing bid/ask columns can't capture.

Why levels 1-4 matter (predictively):
  * A "wall" of liquidity at one deeper level often acts as a
    short-term support/resistance — price tends to bounce off it
    before consuming it.
  * Depth imbalance across the book (more on bid side vs ask side)
    leads short-term direction by ~10-30 seconds typically.
  * Steep depth slope = thin book = volatile (price moves a lot per
    unit of size traded). Flat slope = thick book = stable.

Features (12 per CE or PE leg — wired per active strike by the
emitter):

    depth_bid_qty_sum_l1_4      Total bid quantity in levels 1-4
    depth_ask_qty_sum_l1_4      Total ask quantity in levels 1-4
    depth_imbalance_l1_4        (bid_sum - ask_sum) / (bid_sum + ask_sum)
                                ∈ [-1, 1]; positive = bid-heavy
    depth_total_qty_l1_4        bid_sum + ask_sum (raw liquidity)
    depth_weighted_bid          Σ(price × qty) / Σ qty across L1-4 bids
    depth_weighted_ask          Σ(price × qty) / Σ qty across L1-4 asks
    depth_weighted_spread       weighted_ask - weighted_bid
    depth_max_bid_qty_l1_4      max(L1-L4 bid_qty) — "wall" detector
    depth_max_ask_qty_l1_4      max(L1-L4 ask_qty)
    depth_max_qty_level_bid     which level holds the max (1-4); -1 if none
    depth_max_qty_level_ask     same for asks
    depth_slope_bid             (L1_bid_qty - L4_bid_qty) — positive =
                                liquidity drops off with depth
    depth_slope_ask             (L1_ask_qty - L4_ask_qty)

That's actually 13 columns; "depth_max_qty_level_*" are categorical-ish
integers (1-4 or -1) so they ride alongside the floats in the same
parquet row.

NaN handling: a level with zero qty is treated as "no liquidity at this
level" (NaN contribution to weighted price), not zero. If ALL of L1-L4
are empty (option is illiquid), the feature outputs NaN — the model
already handles NaN inputs gracefully.
"""

from __future__ import annotations

import math
from typing import Any

from tick_feature_agent.buffers.option_buffer import OptionTick

_NAN = float("nan")

# Number of feature columns this module emits per call. Kept as a
# constant so the emitter's schema check stays honest if columns are
# added/removed later.
N_DEPTH_FEATURES = 13


def _empty_feature_dict() -> dict[str, float]:
    """All-NaN row — used when the input tick lacks depth (legacy
    synthetic ticks, illiquid options, etc.)."""
    return {
        "depth_bid_qty_sum_l1_4":    _NAN,
        "depth_ask_qty_sum_l1_4":    _NAN,
        "depth_imbalance_l1_4":      _NAN,
        "depth_total_qty_l1_4":      _NAN,
        "depth_weighted_bid":        _NAN,
        "depth_weighted_ask":        _NAN,
        "depth_weighted_spread":     _NAN,
        "depth_max_bid_qty_l1_4":    _NAN,
        "depth_max_ask_qty_l1_4":    _NAN,
        "depth_max_qty_level_bid":   _NAN,
        "depth_max_qty_level_ask":   _NAN,
        "depth_slope_bid":           _NAN,
        "depth_slope_ask":           _NAN,
    }


def compute_depth_features(tick: OptionTick | None) -> dict[str, float]:
    """Compute the 13 depth-derived features from one ``OptionTick``.

    Returns an all-NaN dict when:
      * ``tick`` is None (no tick has arrived for this strike yet);
      * the tick has zero liquidity in every L1-L4 level (likely a
        legacy synthetic tick or a quoteless option). Treating these
        as 0 rather than NaN would teach the model that "thin book =
        small numeric value", which is the wrong inductive bias.

    The returned dict's keys are stable — used by the emitter to lay
    out parquet columns with a fixed schema.
    """
    if tick is None:
        return _empty_feature_dict()

    # Bid/ask price × qty arrays for levels 1-4.
    bid_qtys = (
        tick.l1_bid_qty, tick.l2_bid_qty,
        tick.l3_bid_qty, tick.l4_bid_qty,
    )
    ask_qtys = (
        tick.l1_ask_qty, tick.l2_ask_qty,
        tick.l3_ask_qty, tick.l4_ask_qty,
    )
    bid_prices = (
        tick.l1_bid_price, tick.l2_bid_price,
        tick.l3_bid_price, tick.l4_bid_price,
    )
    ask_prices = (
        tick.l1_ask_price, tick.l2_ask_price,
        tick.l3_ask_price, tick.l4_ask_price,
    )

    bid_sum = sum(bid_qtys)
    ask_sum = sum(ask_qtys)

    # All-empty depth — synthetic tick or illiquid option.
    if bid_sum == 0 and ask_sum == 0:
        return _empty_feature_dict()

    total = bid_sum + ask_sum
    imbalance = (
        (bid_sum - ask_sum) / total if total > 0 else _NAN
    )

    # Quantity-weighted average price per side. Skip levels with
    # zero qty so they don't pull the weighted price toward 0.
    def _weighted_price(qtys: tuple, prices: tuple) -> float:
        num = 0.0
        den = 0
        for q, p in zip(qtys, prices, strict=True):
            if q > 0:
                num += float(p) * float(q)
                den += q
        return num / den if den > 0 else _NAN

    weighted_bid = _weighted_price(bid_qtys, bid_prices)
    weighted_ask = _weighted_price(ask_qtys, ask_prices)
    weighted_spread = (
        weighted_ask - weighted_bid
        if not (math.isnan(weighted_bid) or math.isnan(weighted_ask))
        else _NAN
    )

    # Wall detection: which deeper level holds the most liquidity,
    # and how much.
    def _argmax_level(qtys: tuple) -> tuple[float, float]:
        """Returns (max_qty_as_float, level_1_to_4_as_float). Both NaN
        if every level is empty."""
        best_q = -1
        best_i = -1
        for i, q in enumerate(qtys, start=1):
            if q > best_q:
                best_q = q
                best_i = i
        if best_q <= 0:
            return _NAN, _NAN
        return float(best_q), float(best_i)

    max_bid_qty, max_bid_level = _argmax_level(bid_qtys)
    max_ask_qty, max_ask_level = _argmax_level(ask_qtys)

    # Depth slope: positive when liquidity drops off with depth
    # (most common — top of book is thickest). Negative when it
    # GROWS with depth (rare, suggests hidden walls deeper).
    slope_bid = (
        float(bid_qtys[0] - bid_qtys[-1])
        if bid_qtys[0] > 0 or bid_qtys[-1] > 0 else _NAN
    )
    slope_ask = (
        float(ask_qtys[0] - ask_qtys[-1])
        if ask_qtys[0] > 0 or ask_qtys[-1] > 0 else _NAN
    )

    return {
        "depth_bid_qty_sum_l1_4":    float(bid_sum) if bid_sum > 0 else _NAN,
        "depth_ask_qty_sum_l1_4":    float(ask_sum) if ask_sum > 0 else _NAN,
        "depth_imbalance_l1_4":      imbalance,
        "depth_total_qty_l1_4":      float(total),
        "depth_weighted_bid":        weighted_bid,
        "depth_weighted_ask":        weighted_ask,
        "depth_weighted_spread":     weighted_spread,
        "depth_max_bid_qty_l1_4":    max_bid_qty,
        "depth_max_ask_qty_l1_4":    max_ask_qty,
        "depth_max_qty_level_bid":   max_bid_level,
        "depth_max_qty_level_ask":   max_ask_level,
        "depth_slope_bid":           slope_bid,
        "depth_slope_ask":           slope_ask,
    }


def feature_column_names(prefix: str) -> list[str]:
    """Return parquet column names for one CE/PE leg at one active
    strike, in stable order. ``prefix`` is the existing convention,
    e.g. ``"opt_0_ce"`` for the ATM CE leg → returns
    ``["opt_0_ce_depth_bid_qty_sum_l1_4", ...]``.
    """
    base = _empty_feature_dict()  # use the canonical key order
    return [f"{prefix}_{k}" for k in base.keys()]
