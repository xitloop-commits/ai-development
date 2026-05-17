"""
premium_vwap.py — C8 ATM premium-VWAP features (spec §2.1.4 C8).

Stateful tracker that maintains a session VWAP for the ATM CE and PE
option premiums independently and exposes the scalp gate's view of
whether the current premium has reclaimed its session VWAP.

Features (3 outputs):
    atm_ce_premium_vwap_dist     (current_ce_premium − ce_vwap) / ce_vwap × 100
    atm_pe_premium_vwap_dist     (current_pe_premium − pe_vwap) / pe_vwap × 100
    premium_vwap_reclaim_count   Combined CE+PE below→above reclaim count
                                 since session start (or last reset).

Why these:
    The scalp gate currently cannot see whether ATM CE/PE premium has
    reclaimed its session VWAP. A premium punching through its session
    VWAP from below is one of the cleanest momentum tells in options
    scalping; today it is invisible to the model. These features let
    the gate condition entries on the reclaim pattern.

Reclaim logic:
    For each side (CE / PE) we track last_above_vwap ∈ {None, False, True}:
      - None    → no valid VWAP sample yet (initial / post-reset state).
      - False   → most recent sample was below VWAP.
      - True    → most recent sample was at-or-above VWAP.
    A reclaim fires only on a False → True transition. The first
    None → True transition does NOT count (initial state is "unknown",
    not "below"). The single `reclaim_count` counter is incremented by
    EITHER side's reclaim — it is a combined event count.

State lifecycle:
    1. Construct `PremiumVwapState()` at session start.
    2. Call `state.update(ce_premium, pe_premium, tick_volume)` on each tick.
    3. Call `compute_premium_vwap_features(state, current_ce, current_pe)`
       per emitter tick.
    4. Call `state.reset()` at session close / rollover.

Null rules:
    - state None → all 3 features NaN.
    - current_*_premium missing/invalid → that side's dist NaN.
    - vwap not yet established for a side → that side's dist NaN.
    - reclaim_count is NaN only when state is None; otherwise it is
      always defined (0.0 on a fresh state).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

_NAN = float("nan")


def _safe_pos(v: float | None) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f <= 0:
        return None
    return f


def _safe_float(v) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return f


@dataclass
class PremiumVwapState:
    """Parallel CE/PE premium-VWAP accumulator + reclaim event counter."""

    ce_cum_value: float = 0.0   # Σ ce_premium · tick_volume
    ce_cum_volume: float = 0.0
    pe_cum_value: float = 0.0
    pe_cum_volume: float = 0.0
    ce_last_above_vwap: bool | None = None
    pe_last_above_vwap: bool | None = None
    reclaim_count: int = 0

    def reset(self) -> None:
        self.ce_cum_value = 0.0
        self.ce_cum_volume = 0.0
        self.pe_cum_value = 0.0
        self.pe_cum_volume = 0.0
        self.ce_last_above_vwap = None
        self.pe_last_above_vwap = None
        self.reclaim_count = 0

    @property
    def ce_vwap(self) -> float | None:
        if self.ce_cum_volume <= 0:
            return None
        return self.ce_cum_value / self.ce_cum_volume

    @property
    def pe_vwap(self) -> float | None:
        if self.pe_cum_volume <= 0:
            return None
        return self.pe_cum_value / self.pe_cum_volume

    def update(
        self,
        ce_premium: float | None,
        pe_premium: float | None,
        tick_volume: float | None,
    ) -> None:
        """Fold one tick. Each side updates independently; missing inputs
        on a side simply skip that side's accumulation this tick."""
        vol_v = _safe_pos(tick_volume)
        # Without positive finite volume nothing can be accumulated on
        # either side this tick — early-out keeps both sides untouched.
        if vol_v is None:
            return

        ce_v = _safe_pos(ce_premium)
        if ce_v is not None:
            self.ce_cum_value += ce_v * vol_v
            self.ce_cum_volume += vol_v
            vwap = self.ce_vwap
            if vwap is not None and vwap > 0:
                now_above = ce_v > vwap
                if self.ce_last_above_vwap is False and now_above:
                    self.reclaim_count += 1
                self.ce_last_above_vwap = now_above

        pe_v = _safe_pos(pe_premium)
        if pe_v is not None:
            self.pe_cum_value += pe_v * vol_v
            self.pe_cum_volume += vol_v
            vwap = self.pe_vwap
            if vwap is not None and vwap > 0:
                now_above = pe_v > vwap
                if self.pe_last_above_vwap is False and now_above:
                    self.reclaim_count += 1
                self.pe_last_above_vwap = now_above


def compute_premium_vwap_features(
    state: PremiumVwapState | None,
    current_ce_premium: float | None,
    current_pe_premium: float | None,
) -> dict[str, float]:
    """
    Compute the 3 C8 premium-VWAP features.

    Args:
        state:                Live PremiumVwapState fed via .update() on
                              each option tick.
        current_ce_premium:   Current ATM CE premium (typically the
                              latest LTP for the CE leg).
        current_pe_premium:   Current ATM PE premium.

    Returns:
        Dict of 3 float features. NaN where the state has not yet
        established a VWAP for the side, or where inputs are invalid.
    """
    out: dict[str, float] = {
        "atm_ce_premium_vwap_dist": _NAN,
        "atm_pe_premium_vwap_dist": _NAN,
        "premium_vwap_reclaim_count": _NAN,
    }

    if state is None:
        return out

    # Reclaim count is always defined once state exists (0 on a fresh
    # state — caller can read that as "no reclaims yet").
    out["premium_vwap_reclaim_count"] = float(state.reclaim_count)

    ce_v = _safe_pos(current_ce_premium)
    ce_vwap = state.ce_vwap
    if ce_v is not None and ce_vwap is not None and ce_vwap > 0:
        out["atm_ce_premium_vwap_dist"] = (ce_v - ce_vwap) / ce_vwap * 100.0

    pe_v = _safe_pos(current_pe_premium)
    pe_vwap = state.pe_vwap
    if pe_v is not None and pe_vwap is not None and pe_vwap > 0:
        out["atm_pe_premium_vwap_dist"] = (pe_v - pe_vwap) / pe_vwap * 100.0

    return out
