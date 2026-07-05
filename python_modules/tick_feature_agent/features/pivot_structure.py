"""
pivot_structure.py — Intraday market-structure pivots (swing + trend scales).

Detects confirmed swing highs/lows in the underlying SPOT series at two
tick-count scales and classifies the resulting structure as HH / HL / LH / LL,
from which an uptrend / downtrend / neutral state and a break-of-structure
event are derived. The nearest confirmed pivot on each side also gives a
signed % distance the model (and, later, a structure-based TP/SL rule) can use
as a support / resistance anchor.

Why a stateful tracker (not a pure function like realized_vol):
    Pivot detection needs more spot history than the shared 50-tick buffer
    holds (a trend pivot half-window alone is ~90 ticks), and it is naturally
    sequential. The tracker keeps its own bounded spot history and is fed one
    spot per underlying tick. Because BOTH the live path (tick_processor) and
    the replay path (replay_adapter) call `update()` once per underlying tick
    with the same spot, the two paths produce identical output by
    construction — no separate columnar port and no parity test are required
    (unlike the target/label builders, which ARE columnar-batched in replay).

No look-ahead:
    A pivot at tick t is only CONFIRMED once k further ticks have arrived, by
    checking whether the spot at t is the extreme of the window [t-k, t+k].
    At the moment of confirmation ("now" = t+k) every tick used is ≤ now, so
    nothing from the future leaks; the pivot is simply reported k ticks late.
    This is the standard fractal-pivot confirmation lag.

Scales (half-window k, in ticks; the model learns the scale):
    swing_k = 20   → a swing pivot needs 2*20+1 = 41 ticks to confirm
    trend_k = 90   → a trend pivot needs 2*90+1 = 181 ticks to confirm

Emitted features (12 = 6 per scale, prefix pivot_swing_* / pivot_trend_*):
    pivot_{s}_dist_high_pct   (spot - last_pivot_high) / spot * 100   (<0 → spot below the high)
    pivot_{s}_dist_low_pct    (spot - last_pivot_low)  / spot * 100   (>0 → spot above the low)
    pivot_{s}_structure       +1 uptrend (HH & HL) / -1 downtrend (LH & LL) / 0 neutral
    pivot_{s}_high_is_hh      1.0 last high > prior high / 0.0 lower high / NaN (<2 highs)
    pivot_{s}_low_is_hl       1.0 last low  > prior low  / 0.0 lower low  / NaN (<2 lows)
    pivot_{s}_bars_since      ticks since the most recent pivot of either side (NaN if none)

Null rules:
    Distances / is_hh / is_hl are NaN until the relevant pivot(s) exist.
    `structure` is never NaN — it is 0 (neutral) until both sides are classified.
    A non-finite or non-positive spot is ignored (state untouched, all-NaN row).
"""

from __future__ import annotations

import math
from collections import deque

_NAN = float("nan")

# Canonical ordered output columns. Referenced by the emitter schema and tests
# so the parquet column order is defined in exactly one place.
PIVOT_STRUCTURE_COLUMNS: tuple[str, ...] = (
    "pivot_swing_dist_high_pct",
    "pivot_swing_dist_low_pct",
    "pivot_swing_structure",
    "pivot_swing_high_is_hh",
    "pivot_swing_low_is_hl",
    "pivot_swing_bars_since",
    "pivot_trend_dist_high_pct",
    "pivot_trend_dist_low_pct",
    "pivot_trend_structure",
    "pivot_trend_high_is_hh",
    "pivot_trend_low_is_hl",
    "pivot_trend_bars_since",
)

_DEFAULT_SWING_K = 20
_DEFAULT_TREND_K = 90


class _ScalePivots:
    """Confirmed swing highs/lows for one scale (half-window `k`).

    Shares a spot-history snapshot supplied by the owning tracker each tick and
    maintains the last two confirmed pivot highs and lows so HH/HL/LH/LL can be
    classified. Prices are compared for equality directly against the stored
    spot values (no arithmetic transform), so the max/min "== center" test is
    exact and deterministic.
    """

    __slots__ = (
        "_k",
        "_prefix",
        "last_high",
        "prev_high",
        "last_low",
        "prev_low",
        "last_high_tick",
        "last_low_tick",
        "high_is_hh",
        "low_is_hl",
    )

    def __init__(self, k: int, prefix: str) -> None:
        if k < 1:
            raise ValueError(f"pivot half-window k must be >= 1, got {k}")
        self._k = k
        self._prefix = prefix
        self.last_high: float | None = None
        self.prev_high: float | None = None
        self.last_low: float | None = None
        self.prev_low: float | None = None
        self.last_high_tick: int | None = None
        self.last_low_tick: int | None = None
        # NaN = not yet classifiable (fewer than two pivots of that side)
        self.high_is_hh: float = _NAN
        self.low_is_hl: float = _NAN

    def on_tick(self, hist: list[float], tick_idx: int) -> None:
        """Confirm any new pivot centred k ticks back, given the current
        history snapshot (oldest → newest) and the current tick index."""
        k = self._k
        need = 2 * k + 1
        if len(hist) < need:
            return

        window = hist[-need:]  # length == need; window[k] is the centre
        centre = window[k]
        w_max = max(window)
        w_min = min(window)
        if w_max == w_min:
            return  # flat window → no pivot

        centre_tick = tick_idx - k

        if centre == w_max:
            # New confirmed swing HIGH at centre_tick.
            self.prev_high = self.last_high
            self.last_high = centre
            self.last_high_tick = centre_tick
            if self.prev_high is not None:
                self.high_is_hh = 1.0 if self.last_high > self.prev_high else 0.0
        elif centre == w_min:
            # New confirmed swing LOW at centre_tick.
            self.prev_low = self.last_low
            self.last_low = centre
            self.last_low_tick = centre_tick
            if self.prev_low is not None:
                self.low_is_hl = 1.0 if self.last_low > self.prev_low else 0.0

    def emit(self, spot: float, tick_idx: int) -> dict[str, float]:
        p = self._prefix
        out = {
            f"pivot_{p}_dist_high_pct": _NAN,
            f"pivot_{p}_dist_low_pct": _NAN,
            f"pivot_{p}_structure": 0.0,
            f"pivot_{p}_high_is_hh": self.high_is_hh,
            f"pivot_{p}_low_is_hl": self.low_is_hl,
            f"pivot_{p}_bars_since": _NAN,
        }

        if self.last_high is not None:
            out[f"pivot_{p}_dist_high_pct"] = (spot - self.last_high) / spot * 100.0
        if self.last_low is not None:
            out[f"pivot_{p}_dist_low_pct"] = (spot - self.last_low) / spot * 100.0

        # Structure: uptrend needs a higher high AND a higher low; downtrend a
        # lower high AND a lower low. Anything else (incl. unclassified) = 0.
        hh = self.high_is_hh
        hl = self.low_is_hl
        if hh == 1.0 and hl == 1.0:
            out[f"pivot_{p}_structure"] = 1.0
        elif hh == 0.0 and hl == 0.0:
            out[f"pivot_{p}_structure"] = -1.0

        ticks = [t for t in (self.last_high_tick, self.last_low_tick) if t is not None]
        if ticks:
            out[f"pivot_{p}_bars_since"] = float(tick_idx - max(ticks))

        return out


class PivotStructureTracker:
    """Owns the shared spot history and both scale trackers.

    One instance per session (live) or per replay date; both paths feed it one
    spot per underlying tick via `update()`, which returns the 12-key feature
    dict for that tick.
    """

    def __init__(
        self,
        *,
        swing_k: int = _DEFAULT_SWING_K,
        trend_k: int = _DEFAULT_TREND_K,
    ) -> None:
        self._swing = _ScalePivots(swing_k, "swing")
        self._trend = _ScalePivots(trend_k, "trend")
        # History sized to the largest scale; the swing scale reads a shorter
        # tail from the same snapshot.
        maxlen = 2 * max(swing_k, trend_k) + 1
        self._hist: deque[float] = deque(maxlen=maxlen)
        self._tick_idx = -1  # incremented to 0 on the first valid spot

    def update(self, spot: float | None) -> dict[str, float]:
        """Feed one underlying spot; return this tick's 12 pivot features.

        A non-finite or non-positive spot leaves all state untouched and
        returns an all-NaN / neutral row (mirrors the level-feature NaN rule).
        """
        if spot is None or not math.isfinite(spot) or spot <= 0.0:
            return self._empty_row()

        self._tick_idx += 1
        self._hist.append(float(spot))
        hist = list(self._hist)

        self._swing.on_tick(hist, self._tick_idx)
        self._trend.on_tick(hist, self._tick_idx)

        row = self._swing.emit(spot, self._tick_idx)
        row.update(self._trend.emit(spot, self._tick_idx))
        return row

    @staticmethod
    def _empty_row() -> dict[str, float]:
        out: dict[str, float] = {}
        for col in PIVOT_STRUCTURE_COLUMNS:
            out[col] = 0.0 if col.endswith("_structure") else _NAN
        return out


def pivot_structure_column_names() -> tuple[str, ...]:
    """Canonical ordered column names (for the emitter schema / tests)."""
    return PIVOT_STRUCTURE_COLUMNS
