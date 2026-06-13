"""
exhaustion.py — C5 trend-exhaustion features (V2_MASTER_SPEC §2.1.4 C5, D74 W5).

Two features that help the trend gate distinguish a *fresh* trend (still
has fuel) from a *stale* trend that has run for an hour with no new high
and is about to roll over. Hand-tagged scalp logs flagged the "volume
coming in, price refusing to follow through" pattern as a reliable
stale-trend signal — that's the second feature here.

Features (2 outputs):

    trend_age_ticks
        Tick counter incremented on every tick whose regime tag is
        "trend" or "trend_strong". Resets to 0 on the first tick that
        transitions INTO trend from a non-trend regime, so the freshly
        counted tick lands at age = 1 (we increment AFTER the
        transition reset on the same call). Stays at 0 while regime is
        "range" or "chop". Per-session reset via `ExhaustionState.reset()`.

        Convention (locked here, see W5):
            * `update("trend")` first time           → age becomes 1
            * subsequent `update("trend")` calls     → 2, 3, 4, ...
            * `update("range")` or `update("chop")`  → 0, no carry
            * `update("trend_strong")` after "trend" → keeps counting
              (same family)
            * Re-entering trend after a non-trend regime resets the
              counter, so the first new-trend tick is again age = 1.

    volume_no_move_score
        Heuristic flagging "volume coming in but price refusing to follow
        through" on the latest 5-min bar.

            cur_intensity = cur_bar.volume / max(cur_bar.high − cur_bar.low, ε)
            baseline      = mean over the 10 PRIOR bars of
                            bar.volume / max(bar.high − bar.low, ε)
            score         = cur_intensity / baseline

        with ε = 1e-9 to keep zero-range bars finite.

        Interpretation:
            >> 1   tight range yet unusually high volume → exhaustion candidate
             ≈ 1   normal pace
            <  1   range wide for the volume on offer → healthy trending move

        NaN when fewer than 11 bars are available (need 10 prior + 1
        current) or when the baseline is non-positive.

Null rules:
    * `state is None` or never updated → trend_age_ticks NaN
      (we can't distinguish "0 because regime is range" from
      "0 because we haven't seen a tick"; emit NaN until a regime is
      observed).
    * Once `update(...)` has been called at least once with any tag,
      trend_age_ticks reports the integer count (0.0 if currently
      non-trend).
    * volume_no_move_score is NaN when bars are insufficient or baseline
      collapses to zero.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from tick_feature_agent.features.bars import Bar

_NAN = float("nan")

_TREND_TAGS: frozenset[str] = frozenset({"TREND", "TREND_STRONG"})
# T32-FU3 (2026-06-13): regime classifier emits UPPERCASE labels
# ("TREND" / "TREND_STRONG" / "RANGE" / "DEAD" / "NEUTRAL") — see
# ``features/regime.py``. Pre-2026-06-13 this set held lowercase
# strings, so the ``regime_tag in _TREND_TAGS`` membership test below
# never matched and ``trend_age_ticks`` was a dead feature (always
# NaN / 0) across every replay parquet.
_BASELINE_BARS = 10
_RANGE_FLOOR = 1e-9


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
class ExhaustionState:
    """Per-session trend-age tracker driven by regime-tag transitions."""

    trend_age_ticks: int = 0
    prev_regime_tag: str | None = None
    # Distinguish "never seen a tick" from "current regime is non-trend".
    has_seen_tick: bool = False

    def reset(self) -> None:
        """Zero the counter and clear regime history for the next session."""
        self.trend_age_ticks = 0
        self.prev_regime_tag = None
        self.has_seen_tick = False

    def update(self, regime_tag: str | None) -> None:
        """Fold one tick's regime tag into the trend-age counter.

        Behaviour:
            * regime in {"trend", "trend_strong"}:
                - if the previous tag was NOT a trend tag (or was None),
                  reset to 0 first, then increment → age becomes 1 on
                  the first trend tick of a fresh run.
                - if the previous tag was also a trend tag, simply
                  increment.
            * any other regime ("range", "chop", or None): age stays at
              0 with no carry-over (we're not in a trend, so no fuel to
              track).
        """
        self.has_seen_tick = True
        is_trend = regime_tag in _TREND_TAGS
        prev_was_trend = self.prev_regime_tag in _TREND_TAGS

        if is_trend:
            if not prev_was_trend:
                # Fresh entry into a trend regime — restart from zero
                # then count this tick.
                self.trend_age_ticks = 0
            self.trend_age_ticks += 1
        else:
            # Range / chop / unknown: counter held at 0, no carry-over.
            self.trend_age_ticks = 0

        self.prev_regime_tag = regime_tag


def _volume_no_move_score(bars: list[Bar]) -> float:
    """Current bar's volume-per-range vs the mean of the last 10 prior bars."""
    if len(bars) < _BASELINE_BARS + 1:
        return _NAN

    cur = bars[-1]
    cur_high = _safe_float(cur.high)
    cur_low = _safe_float(cur.low)
    cur_vol = _safe_float(cur.volume)
    if cur_high is None or cur_low is None or cur_vol is None or cur_vol < 0:
        return _NAN

    cur_range = max(cur_high - cur_low, _RANGE_FLOOR)
    cur_intensity = cur_vol / cur_range

    baseline_bars = bars[-(_BASELINE_BARS + 1):-1]
    intensities: list[float] = []
    for b in baseline_bars:
        h = _safe_float(b.high)
        l = _safe_float(b.low)
        v = _safe_float(b.volume)
        if h is None or l is None or v is None or v < 0:
            continue
        rng = max(h - l, _RANGE_FLOOR)
        intensities.append(v / rng)

    if len(intensities) < _BASELINE_BARS:
        return _NAN

    baseline = sum(intensities) / len(intensities)
    if baseline <= 0:
        return _NAN

    return cur_intensity / baseline


def compute_exhaustion_features(
    state: ExhaustionState | None,
    bars_5m: list[Bar] | None,
) -> dict[str, float]:
    """
    Compute the 2 C5 trend-exhaustion features.

    Args:
        state:    Live ExhaustionState fed via `.update(regime_tag)`
                  once per emitter tick. None or never-updated state
                  yields NaN for `trend_age_ticks` (we can't tell "no
                  trend" from "no data" without at least one update).
        bars_5m:  Finalised 5-min bars from `BarAggregator.get_recent_bars(300)`.

    Returns:
        Dict of 2 float features. NaN where state / bars are missing.
    """
    out: dict[str, float] = {
        "trend_age_ticks": _NAN,
        "volume_no_move_score": _NAN,
    }

    if state is not None and state.has_seen_tick:
        out["trend_age_ticks"] = float(state.trend_age_ticks)

    bars = bars_5m or []
    out["volume_no_move_score"] = _volume_no_move_score(bars)

    return out
