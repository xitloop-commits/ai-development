"""
bars.py — 1m / 5m / 15m OHLCV aggregator (spec §2.1.4 B-block foundational).

Stateful per-instrument bar builder that consumes underlying ticks and
maintains a short rolling history of finalised OHLCV bars on multiple
timeframes. Downstream feature modules (`multi_tf.py`, `technical.py`,
`premium_vwap.py`) read from this aggregator instead of redoing the
windowing themselves.

Bar boundary convention:
    Bar start = floor(tick_ts / tf_sec) * tf_sec  (epoch seconds).
    Both 09:15:00 IST (NSE) and 09:00:00 IST (MCX) align cleanly to
    1/5/15-minute boundaries this way — no session-specific offset needed.

Bar finalisation:
    A bar is "open" while ticks keep landing inside its window. When the
    next tick falls into a later bar, the open bar is APPENDED to the
    history deque and a fresh bar is opened. The currently-open bar is
    queryable via current_bar() but is not part of get_recent_bars().

Why no scipy / pandas:
    The aggregator is on the hot per-tick path. Pure stdlib (deque,
    dataclass) keeps overhead at a few microseconds per tick.

Public API:
    Bar                       Frozen dataclass: start_ts, open, high, low,
                              close, volume, tick_count.
    BarAggregator(timeframes_sec=(60, 300, 900), max_bars_per_tf=60)
        .add_tick(ts, ltp, tick_volume=0.0)
        .get_recent_bars(tf_sec, n=None) -> list[Bar]   (oldest → newest)
        .current_bar(tf_sec) -> Bar | None              (in-progress)
        .reset()                                        (session start)

Invalid input handling:
    Non-finite ts or ltp, or ts going backwards on the same TF, are
    dropped silently. Bad input must not poison the aggregator — we'd
    rather miss a tick than lose the whole bar series.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass


@dataclass(frozen=True)
class Bar:
    """Single OHLCV bar."""

    start_ts: float       # bar window start, epoch seconds
    open: float
    high: float
    low: float
    close: float
    volume: float         # sum of tick_volume contributions in this window
    tick_count: int       # number of ticks that contributed to this bar


class _OpenBar:
    """Mutable scratch bar; converted to a frozen Bar on finalisation."""

    __slots__ = ("start_ts", "open", "high", "low", "close", "volume", "tick_count")

    def __init__(self, start_ts: float, ltp: float, tick_volume: float) -> None:
        self.start_ts = start_ts
        self.open = ltp
        self.high = ltp
        self.low = ltp
        self.close = ltp
        self.volume = max(0.0, tick_volume)
        self.tick_count = 1

    def update(self, ltp: float, tick_volume: float) -> None:
        if ltp > self.high:
            self.high = ltp
        if ltp < self.low:
            self.low = ltp
        self.close = ltp
        if tick_volume > 0:
            self.volume += tick_volume
        self.tick_count += 1

    def finalise(self) -> Bar:
        return Bar(
            start_ts=self.start_ts,
            open=self.open,
            high=self.high,
            low=self.low,
            close=self.close,
            volume=self.volume,
            tick_count=self.tick_count,
        )


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


class BarAggregator:
    """Stateful multi-timeframe OHLCV aggregator."""

    def __init__(
        self,
        timeframes_sec: tuple[int, ...] = (60, 300, 900),
        max_bars_per_tf: int = 60,
    ) -> None:
        if not timeframes_sec:
            raise ValueError("BarAggregator needs at least one timeframe")
        for tf in timeframes_sec:
            if not isinstance(tf, int) or tf <= 0:
                raise ValueError(f"timeframe {tf!r} must be a positive int")
        if max_bars_per_tf <= 0:
            raise ValueError("max_bars_per_tf must be positive")

        self._timeframes: tuple[int, ...] = tuple(timeframes_sec)
        self._max_bars = max_bars_per_tf
        self._history: dict[int, deque[Bar]] = {
            tf: deque(maxlen=max_bars_per_tf) for tf in self._timeframes
        }
        self._open: dict[int, _OpenBar | None] = {tf: None for tf in self._timeframes}

    @property
    def timeframes(self) -> tuple[int, ...]:
        return self._timeframes

    def reset(self) -> None:
        """Drop all bars + open windows. Call on session start / rollover."""
        for tf in self._timeframes:
            self._history[tf].clear()
            self._open[tf] = None

    def add_tick(self, ts: float, ltp: float, tick_volume: float = 0.0) -> None:
        """Push a tick into every configured timeframe."""
        ts_v = _safe_float(ts)
        ltp_v = _safe_float(ltp)
        if ts_v is None or ltp_v is None or ltp_v <= 0:
            return
        vol_v = _safe_float(tick_volume) or 0.0

        for tf in self._timeframes:
            bar_start = (int(ts_v) // tf) * tf
            cur = self._open[tf]

            if cur is None:
                self._open[tf] = _OpenBar(bar_start, ltp_v, vol_v)
                continue

            if bar_start == cur.start_ts:
                cur.update(ltp_v, vol_v)
                continue

            if bar_start > cur.start_ts:
                # Bar boundary crossed — finalise the previous open bar,
                # then start a fresh one at the new boundary.
                self._history[tf].append(cur.finalise())
                self._open[tf] = _OpenBar(bar_start, ltp_v, vol_v)
                continue

            # bar_start < cur.start_ts → tick went backwards in time. Drop.
            # (Out-of-order ticks shouldn't happen on a live feed; replay
            # callers must feed monotonic timestamps.)

    def get_recent_bars(self, tf_sec: int, n: int | None = None) -> list[Bar]:
        """
        Return FINALISED bars for `tf_sec`, oldest first.

        n=None → all bars currently in the deque (up to max_bars_per_tf).
        n=k    → the last k bars; if fewer exist, return what we have.
        """
        if tf_sec not in self._history:
            return []
        dq = self._history[tf_sec]
        if n is None or n >= len(dq):
            return list(dq)
        # deque doesn't support arbitrary slicing — materialise the tail.
        return list(dq)[-n:]

    def current_bar(self, tf_sec: int) -> Bar | None:
        """Snapshot of the in-progress (not-yet-finalised) bar for `tf_sec`."""
        cur = self._open.get(tf_sec)
        return cur.finalise() if cur is not None else None
