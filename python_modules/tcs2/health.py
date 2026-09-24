"""TCS2 - health: per-thread heartbeats, reported independently.

Spec: docs/systems/14_tcs2.md  (D16, D17, D30)

The failure this exists to prevent is precise. On 2026-09-18 the recorder stopped
at 10:00 and nobody noticed for two and a half hours, **with someone at the
desk**, because the screen in front of them still looked alive. A single
process-wide "running" flag would have shown green throughout.

So each thread beats separately and is reported separately:

    feed      is the socket still delivering?
    recorder  is anything still reaching disk?
    gui       is the window still repainting?

A frozen GUI must not make the feed look dead, and - far more important - a live
GUI must not make a stopped recorder look alive.

**Health is a structured object, not print statements** (D17). The screen is one
consumer of it; adding a Telegram consumer later is a subscriber, not a rewrite.
It is also written to file every interval even in v1, because knowing *when*
something stopped is the difference between diagnosing T186 and guessing at it.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

# A thread is late once it has not beaten for this long. Deliberately generous:
# a false alarm trains you to ignore the light, which is how 2026-09-18 happened.
DEFAULT_STALE_SEC = 60.0

OK = "ok"
LATE = "late"
DEAD = "dead"
IDLE = "idle"      # outside market hours, or nothing expected yet


@dataclass
class Beat:
    """One thread's pulse."""

    name: str
    last_beat: float = 0.0
    beats: int = 0
    started_at: float = 0.0
    note: str = ""

    def beat(self, now: float | None = None, note: str = "") -> None:
        now = now if now is not None else time.time()
        if self.started_at == 0.0:
            self.started_at = now
        self.last_beat = now
        self.beats += 1
        if note:
            self.note = note

    def age(self, now: float | None = None) -> float:
        if self.last_beat == 0.0:
            return float("inf")
        now = now if now is not None else time.time()
        return now - self.last_beat

    def status(self, now: float | None = None,
               stale_sec: float = DEFAULT_STALE_SEC,
               expected: bool = True) -> str:
        """How this thread is doing.

        `expected=False` means nothing SHOULD be arriving - outside market hours,
        or before the open. Then silence is IDLE rather than DEAD. Measured
        2026-09-25: with the market closed the recorder had nothing to write and
        its age climbed past every threshold, which would have shown DEAD all
        night. A light that cries wolf is a light you stop looking at, which is
        how 2026-09-18 went unnoticed for two and a half hours.
        """
        if self.last_beat == 0.0:
            return IDLE
        age = self.age(now)
        if age <= stale_sec:
            return OK
        if not expected:
            return IDLE
        if age <= stale_sec * 5:
            return LATE
        return DEAD


@dataclass
class Health:
    """The whole process's health, as data.

    Nothing here formats or prints. The screen renders it, a file records it, and
    any later consumer reads the same object (D17).
    """

    instrument: str
    trade_date: str
    pid: int = field(default_factory=os.getpid)
    started_at: float = field(default_factory=time.time)
    stale_sec: float = DEFAULT_STALE_SEC
    # False outside market hours: silence is then expected, not a stall.
    in_session: bool = True

    feed: Beat = field(default_factory=lambda: Beat("feed"))
    recorder: Beat = field(default_factory=lambda: Beat("recorder"))
    gui: Beat = field(default_factory=lambda: Beat("gui"))

    # Counters the screen shows and a later study reads.
    ticks: int = 0
    frames: int = 0
    legs_seen: int = 0
    legs_subscribed: int = 0
    rows_written: int = 0
    gui_updates_dropped: int = 0
    unknown_prints: int = 0
    disconnects: int = 0
    last_disconnect: str = ""
    first_tick_at: float = 0.0
    last_tick_at: float = 0.0
    analytics_ms: float = 0.0

    @property
    def threads(self) -> tuple[Beat, ...]:
        return (self.feed, self.recorder, self.gui)

    def uptime(self, now: float | None = None) -> float:
        now = now if now is not None else time.time()
        return now - self.started_at

    def worst(self, now: float | None = None) -> str:
        """The worst state any thread is in - what a single light would show.

        Present so the screen can colour one summary dot, never so a caller can
        stop looking at the three separately.
        """
        order = {OK: 0, IDLE: 1, LATE: 2, DEAD: 3}
        return max((self.status_of(t, now) for t in self.threads),
                   key=lambda s: order[s])

    def status_of(self, beat: Beat, now: float | None = None) -> str:
        """A thread's status, taking the session into account.

        The GUI is expected to repaint whatever the market is doing; the feed and
        recorder are only expected to be busy while the market is open.
        """
        expected = True if beat is self.gui else self.in_session
        return beat.status(now, self.stale_sec, expected=expected)

    def tick_rate(self, now: float | None = None) -> float:
        if self.first_tick_at == 0.0 or self.last_tick_at <= self.first_tick_at:
            return 0.0
        return self.ticks / (self.last_tick_at - self.first_tick_at)

    def coverage(self) -> float:
        if not self.legs_subscribed:
            return 0.0
        return self.legs_seen / self.legs_subscribed

    def to_dict(self, now: float | None = None) -> dict:
        now = now if now is not None else time.time()
        d = asdict(self)
        d["ts"] = now
        d["uptime"] = self.uptime(now)
        d["worst"] = self.worst(now)
        d["tick_rate"] = self.tick_rate(now)
        d["coverage"] = self.coverage()
        for name in ("feed", "recorder", "gui"):
            b = getattr(self, name)
            d[name]["age"] = b.age(now)
            d[name]["status"] = self.status_of(b, now)
        return d

    def append_to(self, path: Path, now: float | None = None) -> None:
        """One JSON line per interval.

        Appended rather than overwritten: the value is the timeline, not the
        current value - the screen already has the current value.
        """
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(self.to_dict(now), separators=(",", ":")) + "\n")

    def summary(self, now: float | None = None) -> str:
        """One line for a terminal. The screen renders the object instead."""
        now = now if now is not None else time.time()
        parts = [f"{b.name} {self.status_of(b, now)} {b.age(now):.1f}s"
                 for b in self.threads]
        return (f"{self.instrument} | " + "  ".join(parts)
                + f" | ticks {self.ticks:,} ({self.tick_rate(now):,.0f}/s)"
                + f" | legs {self.legs_seen:,}/{self.legs_subscribed:,}")
