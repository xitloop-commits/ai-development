"""
regime.py — §8.10 Regime Classification.

Pure function: computes TREND_STRONG / TREND / RANGE / DEAD / NEUTRAL from
five normalized input signals and configurable thresholds from the
Instrument Profile.

T32 (2026-05-28): added ``TREND_STRONG`` tier (ADX(14) ≥ 30 + TREND
conditions) per V2_MASTER_SPEC §2.8 D4, plus a stateful
``RegimeClassifier`` wrapper that applies a 5-minute sustain to
transitions and benign-degradation handling (None instant readings
don't flip the confirmed regime).

Features (2 outputs):
    regime             "TREND_STRONG" | "TREND" | "RANGE" | "DEAD" | "NEUTRAL" | None
    regime_confidence  float [0, 1] | NaN

Input signals (all normalized 0–1 except adx_5min ∈ [0, 100]):
    S_volatility  = volatility_compression       (high = expansion)
    S_imbalance   = abs(tick_imbalance_20)        (high = directional)
    S_momentum    = abs(Δprice_20) / rolling_std  (high = directional)
    S_activity    = min(active_strike_count/4, 1) (high = live)
    adx_5min      = Wilder ADX(14) on 5-min bars   (high = trend conviction)

Warm-up:  both outputs are None/NaN when:
    - underlying 20-tick buffer not yet full (n < 20)
    - vol_diff_available is False (before 2nd chain snapshot)
    - trading_state == "WARMING_UP"
    - Any required signal (volatility_compression, tick_imbalance_20) is NaN

Default thresholds (see instrument profile for per-instrument values):
    regime_trend_volatility_min  = 0.8
    regime_trend_imbalance_min   = 0.3
    regime_trend_momentum_min    = 0.5
    regime_trend_activity_min    = 0.5
    regime_trend_strong_adx_min  = 30.0   # T32 D4
    regime_range_volatility_max  = 0.5
    regime_range_imbalance_max   = 0.3
    regime_range_activity_min    = 0.25
    regime_dead_activity_max     = 0.25
    regime_dead_vol_drought_max  = 0.05  (fraction of session_avg)
    regime_sustain_sec           = 300.0  # T32 — 5-min sustain before transitions confirm
"""

from __future__ import annotations

import collections
import math
import statistics

from tick_feature_agent.buffers.tick_buffer import CircularBuffer

_NAN = float("nan")

# Default thresholds — override per instrument via compute() `thresholds` param
_DEFAULTS: dict = {
    "regime_trend_volatility_min": 0.8,
    "regime_trend_imbalance_min": 0.3,
    "regime_trend_momentum_min": 0.5,
    "regime_trend_activity_min": 0.5,
    "regime_trend_strong_adx_min": 30.0,  # T32 D4
    "regime_range_volatility_max": 0.5,
    "regime_range_imbalance_max": 0.3,
    "regime_range_activity_min": 0.25,
    "regime_dead_activity_max": 0.25,
    "regime_dead_vol_drought_max": 0.05,
    "regime_sustain_sec": 300.0,  # T32 — 5-min sustain
}


def compute_regime_features(
    buffer: CircularBuffer,
    volatility_compression: float,
    tick_imbalance_20: float,
    active_strike_count: int,
    vol_diff_available: bool,
    trading_state: str = "TRADING",
    volume_drought_atm: float = _NAN,
    thresholds: dict | None = None,
    adx_5min: float = _NAN,
) -> dict:
    """
    Compute §8.10 regime classification.

    Args:
        buffer:                 Underlying 50-tick buffer (current tick pushed).
        volatility_compression: From compression.py; NaN during warm-up.
        tick_imbalance_20:      From underlying.py; NaN if < 20 ticks.
        active_strike_count:    From decay.py or ChainCache.
        vol_diff_available:     True after second chain snapshot.
        trading_state:          State machine state ("TRADING", "WARMING_UP", etc.)
        volume_drought_atm:     From decay.py; NaN until 2nd snapshot.
        thresholds:             Dict of regime_* keys (merged with defaults).
        adx_5min:               Wilder ADX(14) on 5-min bars from multi_tf.
                                NaN until enough 5-min bars accumulate; in that
                                case the function degrades gracefully to the
                                pre-T32 four-tier output (no TREND_STRONG).

    Returns:
        Dict with keys "regime" (str | None) and "regime_confidence" (float).
        regime = None and regime_confidence = NaN during warm-up.
    """
    t = dict(_DEFAULTS)
    if thresholds:
        t.update(thresholds)

    n = len(buffer)

    # ── Warm-up guard ─────────────────────────────────────────────────────────
    warm_up = (
        n < 20
        or not vol_diff_available
        or trading_state == "WARMING_UP"
        or math.isnan(volatility_compression)
        or math.isnan(tick_imbalance_20)
    )
    if warm_up:
        return {"regime": None, "regime_confidence": _NAN}

    # ── Compute rolling_std_20 and price delta ────────────────────────────────
    ticks = buffer.get_last(20)
    prices = [float(tk.ltp) for tk in ticks]
    rolling_std_20 = statistics.stdev(prices)
    price_now = prices[-1]
    price_20ago = prices[0]

    # ── Signals ───────────────────────────────────────────────────────────────
    s_volatility = volatility_compression  # already [0,∞]; can exceed 1
    s_imbalance = abs(tick_imbalance_20)  # [0, 1]
    if rolling_std_20 == 0.0:
        s_momentum = 0.0
    else:
        s_momentum = abs(price_now - price_20ago) / rolling_std_20
    s_activity = min(active_strike_count / 4.0, 1.0)  # [0, 1]

    # ── Threshold evaluation ──────────────────────────────────────────────────
    is_dead = s_activity < t["regime_dead_activity_max"] or (
        not math.isnan(volume_drought_atm)
        and volume_drought_atm < t["regime_dead_vol_drought_max"]
        and active_strike_count == 0
    )
    is_trend = (
        s_volatility > t["regime_trend_volatility_min"]
        and s_imbalance > t["regime_trend_imbalance_min"]
        and s_momentum > t["regime_trend_momentum_min"]
        and s_activity > t["regime_trend_activity_min"]
    )
    is_range = (
        s_volatility < t["regime_range_volatility_max"]
        and s_imbalance < t["regime_range_imbalance_max"]
        and s_activity > t["regime_range_activity_min"]
    )

    # T32 D4: TREND_STRONG = TREND signals PLUS Wilder ADX(14) ≥ 30 on 5-min
    # bars. ADX is the trend-conviction confirmation that distinguishes a
    # noisy directional move from a confirmed trending regime. NaN ADX
    # degrades gracefully — function returns TREND/RANGE/etc. as before.
    adx_valid = isinstance(adx_5min, (int, float)) and not math.isnan(adx_5min)
    is_trend_strong = (
        is_trend and adx_valid and adx_5min >= t["regime_trend_strong_adx_min"]
    )

    # ── Priority assignment ───────────────────────────────────────────────────
    if is_dead:
        regime = "DEAD"
        confidence = 1.0 - s_activity
    elif is_trend_strong:
        regime = "TREND_STRONG"
        # Boost confidence by the ADX excess over the threshold — capped at 1.
        adx_excess = (adx_5min - t["regime_trend_strong_adx_min"]) / 100.0
        base = (s_volatility + s_imbalance + s_momentum + s_activity) / 4.0
        confidence = min(1.0, base + adx_excess)
    elif is_trend:
        regime = "TREND"
        confidence = (s_volatility + s_imbalance + s_momentum + s_activity) / 4.0
        confidence = min(1.0, confidence)  # clamp: s_volatility can exceed 1
    elif is_range:
        regime = "RANGE"
        confidence = ((1.0 - s_volatility) + (1.0 - s_imbalance) + s_activity) / 3.0
        confidence = max(0.0, min(1.0, confidence))
    else:
        regime = "NEUTRAL"
        confidence = 0.5

    return {"regime": regime, "regime_confidence": confidence}


# ── T32 D4: stateful sustain wrapper ────────────────────────────────────────


class RegimeClassifier:
    """Rolling-window-majority sustain wrapper around ``compute_regime_features``.

    Per V2_MASTER_SPEC §2.8 D4, regime transitions must be sustained for
    ~5 minutes before they're 'confirmed' downstream. This prevents the
    gate from flickering between TREND_STRONG and TREND on minor ADX
    moves around the 30 threshold and avoids treating a one-tick NEUTRAL
    blip as a regime change.

    Algorithm (T32-FU1, 2026-06-13):

      * Maintain a rolling window of the last ``sustain_sec`` seconds of
        instantaneous regime readings.
      * Promote a non-confirmed regime to confirmed only when it accounts
        for at least ``majority_threshold`` (default 70%) of the window
        AND the window holds at least ``min_window_ticks`` entries.
      * First valid reading is accepted immediately (no warmup penalty
        beyond the underlying compute_regime_features warmup).
      * Benign degradation: ``instant_regime is None`` (warmup, missing
        inputs) does NOT change confirmed state and is NOT added to the
        window. The confirmed value carries through.
      * Confidence: tracks the latest instant's confidence so the
        downstream gate sees current conviction.

    Why majority not consecutive-hold (the original T32 design):
      Real intraday data flaps between TREND/RANGE every few ticks. A
      strict "5 minutes uninterrupted" rule means the candidate timer
      keeps resetting and no non-initial regime ever promotes. Whole-day
      single-regime parquets were the symptom (2026-05-22 banknifty:
      100% TREND; 2026-05-20 banknifty: 100% NEUTRAL). Majority within
      the window absorbs the flap and still smooths transitions.

    Threading: not thread-safe — intended for single-threaded tick
    dispatch (same as the rest of the TFA feature pipeline).
    """

    DEFAULT_MAJORITY_THRESHOLD = 0.70
    DEFAULT_MIN_WINDOW_TICKS = 10

    def __init__(
        self,
        *,
        sustain_sec: float = 300.0,
        majority_threshold: float = DEFAULT_MAJORITY_THRESHOLD,
        min_window_ticks: int = DEFAULT_MIN_WINDOW_TICKS,
    ) -> None:
        self._sustain_sec = float(sustain_sec)
        self._majority_threshold = float(majority_threshold)
        self._min_window_ticks = int(min_window_ticks)
        self._confirmed_regime: str | None = None
        self._confirmed_confidence: float = _NAN
        # Rolling window of (ts, regime). Pruned by age on every update.
        self._window: collections.deque[tuple[float, str]] = collections.deque()

    @property
    def confirmed_regime(self) -> str | None:
        return self._confirmed_regime

    @property
    def confirmed_confidence(self) -> float:
        return self._confirmed_confidence

    @property
    def candidate_regime(self) -> str | None:
        """Inspection-only: the most-counted non-confirmed regime
        currently in the rolling window, or None if no non-confirmed
        readings are present. This is the value that would be promoted
        next if it crosses the majority threshold.
        """
        if not self._window:
            return None
        counts: dict[str, int] = {}
        for _ts, r in self._window:
            if r == self._confirmed_regime:
                continue
            counts[r] = counts.get(r, 0) + 1
        if not counts:
            return None
        return max(counts.items(), key=lambda kv: kv[1])[0]

    def reset(self) -> None:
        """Clear all state — called at session_start or expiry rollover."""
        self._confirmed_regime = None
        self._confirmed_confidence = _NAN
        self._window.clear()

    def update(
        self,
        *,
        now_ts: float,
        buffer: CircularBuffer,
        volatility_compression: float,
        tick_imbalance_20: float,
        active_strike_count: int,
        vol_diff_available: bool,
        trading_state: str = "TRADING",
        volume_drought_atm: float = _NAN,
        thresholds: dict | None = None,
        adx_5min: float = _NAN,
    ) -> dict:
        """Classify the current tick and return the CONFIRMED regime
        (after rolling-majority sustain), not the instantaneous
        classification.

        Args mirror ``compute_regime_features`` plus ``now_ts`` for the
        rolling window's age bookkeeping.
        """
        instant = compute_regime_features(
            buffer=buffer,
            volatility_compression=volatility_compression,
            tick_imbalance_20=tick_imbalance_20,
            active_strike_count=active_strike_count,
            vol_diff_available=vol_diff_available,
            trading_state=trading_state,
            volume_drought_atm=volume_drought_atm,
            thresholds=thresholds,
            adx_5min=adx_5min,
        )
        instant_regime = instant["regime"]
        instant_conf = instant["regime_confidence"]

        # Benign degradation: a None instantaneous reading (warmup or
        # missing inputs) does NOT change the confirmed state and does
        # NOT enter the rolling window. The confirmed value carries
        # through until a valid reading lands.
        if instant_regime is None:
            return {
                "regime": self._confirmed_regime,
                "regime_confidence": self._confirmed_confidence,
            }

        # Append + prune the rolling window by age.
        now_v = float(now_ts)
        self._window.append((now_v, instant_regime))
        cutoff = now_v - self._sustain_sec
        while self._window and self._window[0][0] < cutoff:
            self._window.popleft()

        # First valid reading — accept immediately, no sustain delay.
        if self._confirmed_regime is None:
            self._confirmed_regime = instant_regime
            self._confirmed_confidence = instant_conf
            return {
                "regime": self._confirmed_regime,
                "regime_confidence": self._confirmed_confidence,
            }

        # Same as confirmed — refresh confidence in place; majority
        # check is unnecessary (any same-regime instant trivially
        # supports the existing confirmed value).
        if instant_regime == self._confirmed_regime:
            self._confirmed_confidence = instant_conf
            return {
                "regime": self._confirmed_regime,
                "regime_confidence": self._confirmed_confidence,
            }

        # Different from confirmed — count the rolling window. Promote
        # the most-counted non-confirmed regime iff it crosses both
        # gates (min window size + majority share).
        window_n = len(self._window)
        if window_n >= self._min_window_ticks:
            counts: dict[str, int] = {}
            for _ts, r in self._window:
                counts[r] = counts.get(r, 0) + 1
            # Find the leading non-confirmed regime.
            leader, leader_count = None, 0
            for r, c in counts.items():
                if r == self._confirmed_regime:
                    continue
                if c > leader_count:
                    leader, leader_count = r, c
            if leader is not None and (leader_count / window_n) >= self._majority_threshold:
                self._confirmed_regime = leader
                self._confirmed_confidence = instant_conf

        return {
            "regime": self._confirmed_regime,
            "regime_confidence": self._confirmed_confidence,
        }
