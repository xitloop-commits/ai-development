"""
decay.py — §8.9 Decay & Dead Market Detection.

Stateful class: tracks running median of momentum_decay_20ticks_atm over the
first 100 ticks (historical_median_momentum), and running mean of
volume_drought_atm over all snapshots after the first.

Features (5 outputs):
    total_premium_decay_atm      mean(ltp_prev - ltp_now) for ATM ±3 pairs
                                 with ≥2 ticks; NaN if no contributing pair
    momentum_decay_20ticks_atm   Σ(abs(premium_momentum) for 14 ATM ±3 pairs) / 7
                                 NaN pairs contribute 0.0; available once chain_available
    volume_drought_atm           (call_vol_diff_atm + put_vol_diff_atm) / 2
                                 NaN until second chain snapshot
    active_strike_count          len(chain_cache.active_strikes)  ∈ [0, 6]
    dead_market_score            three-term product ∈ [0, 1]; NaN until tick 100

Null rules:
    total_premium_decay_atm:   NaN if no ATM ±3 strike has ≥2 option ticks
    volume_drought_atm:        NaN if cache.vol_diff_available is False
    dead_market_score:         NaN until historical_median_momentum frozen (tick 100)
    dead_market_score:         NaN if volume_drought_atm is NaN (volume term needed)

historical_median_momentum:
    Running median of momentum_decay_20ticks_atm over ticks 1..100.
    Frozen at tick 100 for the rest of the session.
    Not persisted across sessions — reset() clears it.

Usage:
    decay = DecayState()
    out = decay.compute(option_store, opt_features, cache, atm_window)
    decay.reset()   # on session open / rollover
"""

from __future__ import annotations

import math
import statistics

from tick_feature_agent.buffers.option_buffer import OptionBufferStore
from tick_feature_agent.chain_cache import ChainCache

_NAN = float("nan")
_FREEZE_TICK = 100
_OPT_TYPES = ("CE", "PE")
# Denominator for momentum_decay mean — per spec: always 7 (not 14)
_ATM_STRIKE_COUNT = 7
# Volume threshold fraction for dead_market_score volume term
_VOL_DROUGHT_THRESH = 0.05


class DecayState:
    """
    Per-session decay signal state.

    Accumulates momentum_decay values for the first 100 ticks to freeze
    historical_median_momentum.  Tracks running mean of volume_drought_atm.
    """

    __slots__ = (
        "_tick_count",
        "_momentum_history",
        "_historical_median_momentum",
        "_median_frozen",
        "_vol_sum",
        "_vol_count",
        "_session_volume_avg_atm",
    )

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        """Reset to session-start state."""
        self._tick_count: int = 0
        self._momentum_history: list = []
        self._historical_median_momentum: float = _NAN
        self._median_frozen: bool = False
        self._vol_sum: float = 0.0
        self._vol_count: int = 0
        self._session_volume_avg_atm: float = _NAN

    # ── Public API ────────────────────────────────────────────────────────────

    def compute(
        self,
        option_store: OptionBufferStore,
        opt_features: dict[tuple[int, str], dict],
        cache: ChainCache,
        atm_window: list[int],
    ) -> dict:
        """
        Compute all §8.9 decay features for the current tick.

        Args:
            option_store: Per-strike option buffers (for ltp_prev access).
            opt_features: Per-strike tick features from option_tick.py.
            cache:        Live ChainCache (updated before this call).
            atm_window:   7-element ATM ±3 strike list.

        Returns:
            Dict of 5 features.
        """
        self._tick_count += 1

        active_count = len(cache.active_strikes)
        out: dict = {
            "total_premium_decay_atm": _NAN,
            "momentum_decay_20ticks_atm": _NAN,
            "volume_drought_atm": _NAN,
            "active_strike_count": float(active_count),
            "dead_market_score": _NAN,
        }

        # ── total_premium_decay_atm ────────────────────────────────────────────
        # ltp_prev = second-to-last tick in option buffer; ltp_now = latest
        # Only pairs with ≥2 ticks contribute; others excluded from denominator
        decay_sum = 0.0
        contributing = 0
        for strike in atm_window:
            for opt_type in _OPT_TYPES:
                ticks = option_store.get_last(strike, opt_type, n=2)
                if len(ticks) >= 2:
                    decay_sum += float(ticks[-2].ltp) - float(ticks[-1].ltp)
                    contributing += 1
        if contributing > 0:
            out["total_premium_decay_atm"] = decay_sum / contributing

        # ── momentum_decay_20ticks_atm ─────────────────────────────────────────
        if cache.chain_available:
            mom_sum = 0.0
            for strike in atm_window:
                for opt_type in _OPT_TYPES:
                    pm = opt_features.get((strike, opt_type), {}).get("premium_momentum", _NAN)
                    mom_sum += 0.0 if math.isnan(pm) else abs(pm)
            # Denominator is always 7 (strikes), not 14 (pairs) per spec
            out["momentum_decay_20ticks_atm"] = mom_sum / _ATM_STRIKE_COUNT

        # ── volume_drought_atm ─────────────────────────────────────────────────
        if cache.vol_diff_available:
            cdv = cache.call_vol_diff_atm
            pdv = cache.put_vol_diff_atm
            if cdv is not None and pdv is not None:
                vda = (cdv + pdv) / 2.0
                out["volume_drought_atm"] = vda
                # Running mean: snapshot_count counts only post-first-snapshot entries
                self._vol_sum += vda
                self._vol_count += 1
                self._session_volume_avg_atm = self._vol_sum / self._vol_count

        # ── Update historical_median_momentum accumulator ──────────────────────
        mom_decay = out["momentum_decay_20ticks_atm"]
        if not self._median_frozen and not math.isnan(mom_decay):
            self._momentum_history.append(mom_decay)

        if not self._median_frozen and self._tick_count >= _FREEZE_TICK:
            self._historical_median_momentum = (
                statistics.median(self._momentum_history) if self._momentum_history else 0.0
            )
            self._median_frozen = True

        # ── dead_market_score ─────────────────────────────────────────────────
        vda = out["volume_drought_atm"]
        if self._median_frozen and not math.isnan(vda):
            out["dead_market_score"] = self._dead_score(active_count, mom_decay, vda)

        return out

    # ── Internal ─────────────────────────────────────────────────────────────

    def _dead_score(
        self,
        active_strike_count: int,
        momentum_decay: float,
        volume_drought: float,
    ) -> float:
        """Compute dead_market_score ∈ [0, 1] from three independent terms."""
        # Term 1: low active_strike_count → dead
        activity_term = 1.0 - min(active_strike_count / 6.0, 1.0)

        # Term 2: low current momentum vs historical baseline → dead
        hmm = self._historical_median_momentum
        if hmm > 0.0 and not math.isnan(momentum_decay):
            momentum_term = 1.0 - min(momentum_decay / hmm, 1.0)
        else:
            momentum_term = 0.0  # zero/NaN baseline → no signal from this term

        # Term 3: low volume vs session average → dead
        sva = self._session_volume_avg_atm
        if not math.isnan(sva) and sva > 0.0:
            v_ratio = volume_drought / sva
            volume_term = max(0.0, 1.0 - v_ratio / _VOL_DROUGHT_THRESH)
        elif volume_drought <= 0.0:
            volume_term = 1.0  # zero volume = maximum dead signal
        else:
            volume_term = 0.0  # no session baseline yet → no signal

        return max(0.0, min(1.0, activity_term * momentum_term * volume_term))

    # ── Properties ───────────────────────────────────────────────────────────

    @property
    def historical_median_momentum(self) -> float:
        return self._historical_median_momentum

    @property
    def median_frozen(self) -> bool:
        return self._median_frozen

    @property
    def session_volume_avg_atm(self) -> float:
        return self._session_volume_avg_atm

    @property
    def tick_count(self) -> int:
        return self._tick_count
