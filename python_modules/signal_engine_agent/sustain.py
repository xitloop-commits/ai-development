"""
sustain.py — Wave 1: Sustained-tick filter (Phase 1A persistence layer).

Per-instrument N-tick deque that holds the most recent gate decisions.
A signal "emits" only when the last N decisions ALL match the current one
AND none are WAIT. This kills momentary flickers and ensures the model's
direction prediction has held for ~10 ticks (≈10s) before triggering a
trade.

Replaces the legacy_filter Stage 4 sustained-direction logic; the gate
path lost it during the legacy → gate cutover.

Usage:
    sus = SustainFilter(window_n=10)
    for tick in stream:
        decision = decide_action_v2(...)  # may return WAIT
        confirmed = sus.observe(decision.action)  # returns the action only
        if confirmed != "WAIT":                    # if last N all match
            emit_signal(decision)
"""

from __future__ import annotations

from collections import deque

_WAIT = "WAIT"


class SustainFilter:
    """N-tick sustained-direction filter. Stateful, instrument-scoped."""

    __slots__ = ("_window_n", "_history")

    def __init__(self, window_n: int = 10) -> None:
        if window_n < 1:
            raise ValueError(f"window_n must be ≥ 1, got {window_n}")
        self._window_n = window_n
        self._history: deque[str] = deque(maxlen=window_n)

    def observe(self, action: str) -> str:
        """
        Add a decision to the window and return the confirmed action.

        Returns:
            The action if last N observations are all equal to it AND not WAIT.
            Otherwise "WAIT".
        """
        self._history.append(action or _WAIT)
        if len(self._history) < self._window_n:
            return _WAIT
        first = self._history[0]
        if first == _WAIT:
            return _WAIT
        if all(a == first for a in self._history):
            return first
        return _WAIT

    def reset(self) -> None:
        """Clear the window. Call on session boundary or manual override."""
        self._history.clear()

    @property
    def window_n(self) -> int:
        return self._window_n
