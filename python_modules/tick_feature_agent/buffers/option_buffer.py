"""
option_buffer.py — Per-strike circular buffers for option tick data.

One OptionBufferStore per TFA process. Holds 10 ticks per (strike, opt_type)
pair. Pre-allocated at subscription time — no mid-session dict growth for
known strikes. New strikes discovered intra-session are added lazily.

Option tick tuple layout:
    (timestamp, ltp, bid, ask, bid_size, ask_size, volume)
     0           1    2    3    4         5          6

Option types:
    "CE"  — Call option
    "PE"  — Put option
"""

from __future__ import annotations

from collections import deque
from typing import NamedTuple

# ── Option tick structure ─────────────────────────────────────────────────────


class OptionTick(NamedTuple):
    timestamp: float  # Unix epoch seconds (recv_ts from feed)
    ltp: float  # Last traded price
    bid: float  # Best bid
    ask: float  # Best ask
    bid_size: int  # Total bid quantity at best bid
    ask_size: int  # Total ask quantity at best ask
    volume: int  # Cumulative day volume at this tick


# ── Per-strike buffer ─────────────────────────────────────────────────────────


class _StrikeBuffer:
    """Internal — one circular buffer + availability flag per (strike, opt_type)."""

    __slots__ = ("_buf", "tick_available")

    def __init__(self, maxlen: int) -> None:
        self._buf: deque[OptionTick] = deque(maxlen=maxlen)
        self.tick_available: bool = False  # False until first tick received

    def push(self, tick: OptionTick) -> None:
        self._buf.append(tick)
        self.tick_available = True  # latches True on first tick, never resets

    def get_last(self, n: int) -> list[OptionTick]:
        buf = self._buf
        length = len(buf)
        if n <= 0:
            return []
        if n >= length:
            return list(buf)
        return list(buf)[length - n :]

    def latest(self) -> OptionTick | None:
        return self._buf[-1] if self._buf else None

    def __len__(self) -> int:
        return len(self._buf)

    def clear(self) -> None:
        self._buf.clear()
        self.tick_available = False


# ── OptionBufferStore ─────────────────────────────────────────────────────────


class OptionBufferStore:
    """
    Container for all per-strike option buffers in one TFA process.

    Keys are (strike: int, opt_type: str) where opt_type is "CE" or "PE".
    Buffers are created lazily on first push — either at subscription time
    (pre-populate via register_strike) or on the first tick for a new strike.

    Usage:
        store = OptionBufferStore(maxlen=10)
        store.register_strikes([21800, 21850, 21900], opt_types=["CE", "PE"])

        store.push(21850, "CE", OptionTick(...))
        last3 = store.get_last(21850, "CE", n=3)
        available = store.tick_available(21850, "CE")
    """

    __slots__ = ("_store", "_maxlen")

    def __init__(self, maxlen: int = 10) -> None:
        if maxlen <= 0:
            raise ValueError(f"OptionBufferStore maxlen must be > 0, got {maxlen}")
        self._maxlen = maxlen
        self._store: dict[tuple[int, str], _StrikeBuffer] = {}

    # ── Registration ──────────────────────────────────────────────────────────

    def register_strikes(
        self,
        strikes: list[int],
        opt_types: list[str] | None = None,
    ) -> None:
        """
        Pre-create buffers for all (strike, opt_type) combinations.
        Call at subscription time so the dict never grows during tick processing.

        Args:
            strikes:   List of strike prices (integers).
            opt_types: Option types to register. Default: ["CE", "PE"].
        """
        if opt_types is None:
            opt_types = ["CE", "PE"]
        for strike in strikes:
            for opt_type in opt_types:
                key = (strike, opt_type)
                if key not in self._store:
                    self._store[key] = _StrikeBuffer(self._maxlen)

    def register_strike(self, strike: int, opt_type: str) -> None:
        """Register a single (strike, opt_type) pair if not already present."""
        key = (strike, opt_type)
        if key not in self._store:
            self._store[key] = _StrikeBuffer(self._maxlen)

    # ── Write ─────────────────────────────────────────────────────────────────

    def push(self, strike: int, opt_type: str, tick: OptionTick) -> None:
        """
        Push a tick into the buffer for (strike, opt_type).
        Creates the buffer lazily if the strike was not pre-registered
        (e.g. a new strike discovered intra-session).
        """
        key = (strike, opt_type)
        if key not in self._store:
            self._store[key] = _StrikeBuffer(self._maxlen)
        self._store[key].push(tick)

    # ── Read ──────────────────────────────────────────────────────────────────

    def get_last(self, strike: int, opt_type: str, n: int) -> list[OptionTick]:
        """
        Return the last n ticks for (strike, opt_type), oldest first.
        Returns [] if the strike is not registered or has no ticks.
        """
        buf = self._store.get((strike, opt_type))
        if buf is None:
            return []
        return buf.get_last(n)

    def latest(self, strike: int, opt_type: str) -> OptionTick | None:
        """Return the most recent tick for (strike, opt_type), or None."""
        buf = self._store.get((strike, opt_type))
        return buf.latest() if buf is not None else None

    def get_buffer(self, strike: int, opt_type: str) -> _StrikeBuffer | None:
        """Return the raw _StrikeBuffer for (strike, opt_type), or None."""
        return self._store.get((strike, opt_type))

    # ── Availability ──────────────────────────────────────────────────────────

    def tick_available(self, strike: int, opt_type: str) -> bool:
        """
        Return True if at least one tick has been received for (strike, opt_type).
        Returns False for unregistered or empty strikes.
        Latches True on first tick — never resets within a session.
        """
        buf = self._store.get((strike, opt_type))
        return buf.tick_available if buf is not None else False

    def last_tick_time(self, strike: int, opt_type: str) -> float | None:
        """
        Return the timestamp of the most recent tick for (strike, opt_type).
        Returns None if no tick has arrived.
        """
        buf = self._store.get((strike, opt_type))
        if buf is None:
            return None
        latest = buf.latest()
        return latest.timestamp if latest is not None else None

    def strikes_with_ticks(self) -> list[int]:
        """Return sorted list of strikes that have received at least one CE or PE tick."""
        seen: set[int] = set()
        for (strike, _), buf in self._store.items():
            if buf.tick_available:
                seen.add(strike)
        return sorted(seen)

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def clear_all(self) -> None:
        """
        Clear all buffers and reset tick_available flags.
        Called on session start and expiry rollover.
        Note: registered strikes are kept — only the data is cleared.
        """
        for buf in self._store.values():
            buf.clear()

    def clear_strike(self, strike: int, opt_type: str) -> None:
        """Clear one specific buffer (e.g. on targeted rollover)."""
        buf = self._store.get((strike, opt_type))
        if buf is not None:
            buf.clear()

    # ── Introspection ─────────────────────────────────────────────────────────

    def registered_strikes(self) -> list[int]:
        """Return sorted list of all registered strike prices."""
        return sorted({strike for strike, _ in self._store})

    def registered_count(self) -> int:
        """Total number of (strike, opt_type) buffers registered."""
        return len(self._store)

    @property
    def maxlen(self) -> int:
        return self._maxlen
