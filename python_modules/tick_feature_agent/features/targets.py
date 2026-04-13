"""
features/targets.py — Phase 10: Target Variable Generation (§8.13).

Two-pass zero-leakage design
─────────────────────────────
Pass 1 (real-time):  emit row with all target columns = NaN via
                     ``null_target_features()``.
Pass 2 (delayed):    at T+X, call ``TargetBuffer.compute_targets()``
                     to obtain finalized values for that original tick.

TargetBuffer keeps a rolling deque of (_TickEntry) observations for the
last max(target_windows_sec) seconds.  Entries older than that window are
evicted automatically on each push() call.

Typical usage in the main tick dispatcher:

    buf = TargetBuffer(target_windows_sec=(30, 60))
    pct = UpsidePercentileTracker()

    # On each tick (Pass 1):
    buf.push(ts, spot, {strike: (ce_ltp, pe_ltp) for …})
    row["target_feats"] = null_target_features()          # placeholders

    # In a delayed callback at T+30 / T+60 (Pass 2):
    target_vals = buf.compute_targets(
        t0=original_ts,
        spot_at_t0=original_spot,
        active_strike_ltps_at_t0=original_active_ltps,
        session_end_sec=session_end,
    )
    target_vals["upside_percentile_30s"] = pct.add_and_query(
        target_vals.get("max_upside_30s")
    )
    row["target_feats"].update(target_vals)

Null rules (§8.13)
──────────────────
* t0 + X > session_end_sec                 → NaN for that window
* no active strikes                        → NaN for upside/drawdown/decay
                                             (direction still uses spot)
* max_upside or max_drawdown is NaN        → risk_reward_ratio = NaN
* active_strike_count = 0                  → avg_decay = NaN
* UpsidePercentileTracker < 10 values      → upside_percentile = NaN
"""

from __future__ import annotations

import bisect
import math
from collections import deque
from dataclasses import dataclass, field

_NAN = float("nan")


# ── Internal tick snapshot ─────────────────────────────────────────────────────

@dataclass
class _TickEntry:
    """One observation stored in TargetBuffer."""
    timestamp_sec: float
    spot: float
    # {strike: (ce_ltp, pe_ltp)} — NaN for any unavailable price
    strike_ltps: dict[int, tuple[float, float]] = field(default_factory=dict)


# ── TargetBuffer ───────────────────────────────────────────────────────────────

class TargetBuffer:
    """
    Rolling buffer of recent price observations used to compute lookahead
    target variables.

    Thread-safety: not thread-safe — intended for single-threaded tick dispatch.
    """

    def __init__(self, target_windows_sec: tuple[int, ...] = (30, 60)) -> None:
        if not target_windows_sec:
            raise ValueError("target_windows_sec must not be empty")
        self._windows: tuple[int, ...] = tuple(sorted(target_windows_sec))
        self._max_window: int = max(self._windows)
        self._min_window: int = min(self._windows)
        self._entries: deque[_TickEntry] = deque()

    # ── Buffer management ──────────────────────────────────────────────────────

    def push(
        self,
        timestamp_sec: float,
        spot: float,
        strike_ltps: dict[int, tuple[float, float]] | None = None,
    ) -> None:
        """
        Add a new observation to the buffer.

        Evicts entries with timestamp < (timestamp_sec - max_window - 1) to
        keep memory bounded.  The extra 1-second margin ensures entries at
        exactly (now - max_window) are never prematurely discarded.
        """
        self._entries.append(_TickEntry(timestamp_sec, spot, strike_ltps or {}))
        cutoff = timestamp_sec - self._max_window - 1.0
        while self._entries and self._entries[0].timestamp_sec < cutoff:
            self._entries.popleft()

    def reset(self) -> None:
        """Clear all buffered data.  Call at session_start."""
        self._entries.clear()

    # ── Target computation ─────────────────────────────────────────────────────

    def compute_targets(
        self,
        t0: float,
        spot_at_t0: float,
        active_strike_ltps_at_t0: dict[int, tuple[float, float]],
        session_end_sec: float,
    ) -> dict[str, float | int]:
        """
        Compute all per-tick target variables for the tick at t0.

        Does NOT include ``upside_percentile_{min_window}s`` — that column
        is managed by UpsidePercentileTracker and should be merged by the
        caller after invoking add_and_query().

        Args:
            t0:                        Original tick timestamp (epoch seconds).
            spot_at_t0:                Underlying spot price at T.
            active_strike_ltps_at_t0:  {strike: (ce_ltp, pe_ltp)} at T.
            session_end_sec:           Session end (epoch seconds) for null-guard.

        Returns:
            Dict of all target columns except upside_percentile.
            Unavailable / uncomputable values = NaN.
        """
        out: dict[str, float | int] = {}
        active_count = len(active_strike_ltps_at_t0)

        for x in self._windows:
            past_boundary = (t0 + x) > session_end_sec
            has_active = active_count > 0

            # Lookahead entries in (t0, t0+x]
            lookahead = [
                e for e in self._entries
                if t0 < e.timestamp_sec <= t0 + x
            ]

            # ── Upside ────────────────────────────────────────────────────────
            if past_boundary or not has_active:
                out[f"max_upside_{x}s"] = _NAN
            else:
                upsides: list[float] = []
                for strike, (ce_now, _) in active_strike_ltps_at_t0.items():
                    fut_ces = [
                        e.strike_ltps[strike][0]
                        for e in lookahead
                        if strike in e.strike_ltps
                        and not math.isnan(e.strike_ltps[strike][0])
                    ]
                    if fut_ces:
                        upsides.append(max(fut_ces) - ce_now)
                out[f"max_upside_{x}s"] = max(upsides) if upsides else _NAN

            # ── Drawdown ──────────────────────────────────────────────────────
            if past_boundary or not has_active:
                out[f"max_drawdown_{x}s"] = _NAN
            else:
                drawdowns: list[float] = []
                for strike, (ce_now, _) in active_strike_ltps_at_t0.items():
                    fut_ces = [
                        e.strike_ltps[strike][0]
                        for e in lookahead
                        if strike in e.strike_ltps
                        and not math.isnan(e.strike_ltps[strike][0])
                    ]
                    if fut_ces:
                        drawdowns.append(ce_now - min(fut_ces))
                out[f"max_drawdown_{x}s"] = max(drawdowns) if drawdowns else _NAN

            # ── Risk-reward ratio ─────────────────────────────────────────────
            upside_x   = out[f"max_upside_{x}s"]
            drawdown_x = out[f"max_drawdown_{x}s"]
            if math.isnan(upside_x) or math.isnan(drawdown_x):
                out[f"risk_reward_ratio_{x}s"] = _NAN
            else:
                out[f"risk_reward_ratio_{x}s"] = upside_x / max(drawdown_x, 0.01)

            # ── Premium decay ─────────────────────────────────────────────────
            if past_boundary or not has_active or not lookahead:
                out[f"total_premium_decay_{x}s"] = _NAN
                out[f"avg_decay_per_strike_{x}s"] = _NAN
            else:
                # Spec: decay_per_strike = (ce_now + pe_now) - (ce_T+X + pe_T+X)
                # Use the last entry in the lookahead window as the T+X snapshot.
                last = lookahead[-1]
                total = 0.0
                for strike, (ce_now, pe_now) in active_strike_ltps_at_t0.items():
                    if strike in last.strike_ltps:
                        ce_fut, pe_fut = last.strike_ltps[strike]
                        if not (math.isnan(ce_fut) or math.isnan(pe_fut)):
                            total += (ce_now + pe_now) - (ce_fut + pe_fut)
                out[f"total_premium_decay_{x}s"] = total
                out[f"avg_decay_per_strike_{x}s"] = (
                    total / active_count if active_count > 0 else _NAN
                )

            # ── Direction target ──────────────────────────────────────────────
            if past_boundary or not lookahead:
                out[f"direction_{x}s"]           = _NAN
                out[f"direction_{x}s_magnitude"] = _NAN
            else:
                future_spot = lookahead[-1].spot
                out[f"direction_{x}s"] = 1 if future_spot > spot_at_t0 else 0
                if spot_at_t0 > 0:
                    out[f"direction_{x}s_magnitude"] = (
                        abs(future_spot - spot_at_t0) / spot_at_t0
                    )
                else:
                    out[f"direction_{x}s_magnitude"] = _NAN

        return out


# ── UpsidePercentileTracker ────────────────────────────────────────────────────

class UpsidePercentileTracker:
    """
    Maintains the session distribution of finalized max_upside_{min_window}s
    values and computes rank-based percentile for each new value.

    Warm-up: returns NaN until 10 non-null values have been added.

    Percentile method (§8.13.1):
        percentile = count_of_values_le_current / total_count × 100
    Ties: all tied values share the same count-of-≤.
    Example: history = [1, 5, 5, 10], current = 5  → rank = 3 → 75.0.
    """

    _WARMUP = 10

    def __init__(self) -> None:
        self._sorted: list[float] = []

    def add_and_query(self, value: float | None) -> float:
        """
        Add a finalized upside value to the session distribution, then
        return its percentile.  Returns NaN if warming up or value is NaN/None.
        """
        if value is None or (isinstance(value, float) and math.isnan(value)):
            return _NAN

        bisect.insort(self._sorted, value)
        n = len(self._sorted)
        if n < self._WARMUP:
            return _NAN

        # rank = count of values <= current
        rank = bisect.bisect_right(self._sorted, value)
        return rank / n * 100.0

    def reset(self) -> None:
        """Clear session distribution at session_start."""
        self._sorted = []


# ── Public helpers ─────────────────────────────────────────────────────────────

def null_target_features(
    target_windows_sec: tuple[int, ...] = (30, 60),
) -> dict[str, float]:
    """
    Return a dict with all 15 target columns set to NaN.

    Used for Pass-1 placeholder rows emitted before lookahead data arrives.
    Key order matches the spec §9.1 column table and
    ``output.emitter._build_target_columns()``.
    """
    windows = sorted(target_windows_sec)
    out: dict[str, float] = {}
    for x in windows:
        out[f"max_upside_{x}s"]           = _NAN
    for x in windows:
        out[f"max_drawdown_{x}s"]          = _NAN
    for x in windows:
        out[f"risk_reward_ratio_{x}s"]     = _NAN
    for x in windows:
        out[f"total_premium_decay_{x}s"]   = _NAN
    for x in windows:
        out[f"avg_decay_per_strike_{x}s"]  = _NAN
    for x in windows:
        out[f"direction_{x}s"]             = _NAN
        out[f"direction_{x}s_magnitude"]   = _NAN
    min_w = min(windows)
    out[f"upside_percentile_{min_w}s"]     = _NAN
    return out
