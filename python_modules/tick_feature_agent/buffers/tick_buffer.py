"""
tick_buffer.py — Fixed-size circular buffer for underlying futures ticks.

One CircularBuffer(maxlen=50) per TFA process. Stores the last N underlying
ticks so feature modules can compute rolling windows (5 / 10 / 20 / 50 ticks)
without any mid-session allocation.

Tick tuple layout (index constants defined below for readability):
    (timestamp, ltp, bid, ask, volume)
     0           1    2    3    4
"""

from __future__ import annotations

from collections import deque
from typing import NamedTuple

# ── Tick structure ────────────────────────────────────────────────────────────


class UnderlyingTick(NamedTuple):
    timestamp: float  # Unix epoch seconds (recv_ts from feed)
    ltp: float  # Last traded price
    bid: float  # Best bid
    ask: float  # Best ask
    volume: int  # Cumulative day volume at this tick


# ── CircularBuffer ────────────────────────────────────────────────────────────


class CircularBuffer:
    """
    Fixed-size circular buffer backed by collections.deque(maxlen=n).

    Memory is allocated once at construction. When full, the oldest entry
    is silently dropped on push — no reallocation, no blocking.

    Typical use: one instance per TFA process for the underlying feed.
        buf = CircularBuffer(maxlen=50)
        buf.push(UnderlyingTick(...))
        last5 = buf.get_last(5)
    """

    __slots__ = ("_buf", "_maxlen")

    def __init__(self, maxlen: int) -> None:
        if maxlen <= 0:
            raise ValueError(f"CircularBuffer maxlen must be > 0, got {maxlen}")
        self._maxlen = maxlen
        self._buf: deque[UnderlyingTick] = deque(maxlen=maxlen)

    # ── Write ─────────────────────────────────────────────────────────────────

    def push(self, tick: UnderlyingTick) -> None:
        """Append a tick. If buffer is full the oldest entry is silently dropped."""
        self._buf.append(tick)

    # ── Read ──────────────────────────────────────────────────────────────────

    def get_last(self, n: int) -> list[UnderlyingTick]:
        """
        Return the last n ticks as a list (oldest first).
        If fewer than n ticks are available, returns all ticks.
        Never raises — callers should check len(result) before using.
        """
        if n <= 0:
            return []
        buf = self._buf
        length = len(buf)
        if n >= length:
            return list(buf)
        # deque supports negative indexing via islice equivalent
        return list(buf)[length - n :]

    def latest(self) -> UnderlyingTick | None:
        """Return the most recent tick, or None if buffer is empty."""
        return self._buf[-1] if self._buf else None

    def oldest(self) -> UnderlyingTick | None:
        """Return the oldest tick in the buffer, or None if empty."""
        return self._buf[0] if self._buf else None

    # ── State ─────────────────────────────────────────────────────────────────

    def is_full(self, n: int | None = None) -> bool:
        """
        Return True if at least n ticks are available.
        If n is None, checks whether the buffer has reached its maxlen.
        """
        if n is None:
            return len(self._buf) >= self._maxlen
        return len(self._buf) >= n

    def __len__(self) -> int:
        return len(self._buf)

    def clear(self) -> None:
        """Remove all entries. Called on session start or expiry rollover."""
        self._buf.clear()

    @property
    def maxlen(self) -> int:
        return self._maxlen
