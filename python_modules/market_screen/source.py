"""Market Status Screen — where the ticks come from.

Two sources, same output shape, so the screen cannot tell them apart:

LIVE     ws://localhost:3000/ws/ticks forwards the RAW Dhan binary frames
         (server/broker/tickWs.ts:92), which we decode with the platform's own
         parser. This deliberately does NOT open a second broker connection and
         does NOT touch TFA's feed — it reuses what the server already
         distributes to the browser.

REPLAY   a recorded day from data/raw/<date>/, played back at a chosen speed.
         Needed because the screen has to be buildable and testable while the
         market is shut, which is most of the time.

Both yield (instrument, tick_dict) where tick_dict is the same shape the
recordings use, so `claude_cohort.flow.FlowState` consumes either unchanged.
"""
from __future__ import annotations

import glob
import gzip
import json
import os
import queue
import threading
import time
import zlib
from datetime import datetime
from typing import Callable, Iterator, Optional

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RAW_DIR = os.path.join(_ROOT, "data", "raw")
PROFILE_DIR = os.path.join(_ROOT, "config", "instrument_profiles")

INSTRUMENTS = ("nifty50", "banknifty", "crudeoil", "naturalgas")

DEFAULT_WS = "ws://localhost:3000/ws/ticks"


# ── security id -> instrument ────────────────────────────────────────────


def resolve_security_map(date: Optional[str] = None) -> dict:
    """{security_id(str): instrument}.

    The recorded 'underlying' is the near-month FUTURES contract, whose id is
    resolved by TFA at session open and changes every month. Neither the profile
    NOR metadata.json can be trusted for this: both record
    `underlying_security_id` = 13 for NIFTY, which is the SPOT index. Dhan sends
    the spot index in ticker mode only — price and nothing else, no volume, no
    book — so mapping by either would give a feed with no order flow at all and
    the screen would sit silently empty. The ticks themselves are authoritative.
    """
    out: dict = {}
    date = date or datetime.now().strftime("%Y-%m-%d")

    # Read the ids out of the RECORDINGS, newest day first. metadata.json is not
    # usable for this: it stores the profile's `underlying_security_id` (13 for
    # NIFTY, the spot index) while the ticks actually carry the resolved FUTURES
    # contract (68407 on 2026-09-16). Mapping by metadata would silently watch a
    # feed that has no volume and no book, so order flow would read as empty.
    days = sorted({os.path.basename(os.path.dirname(p))
                   for p in glob.glob(os.path.join(RAW_DIR, "*", "*_underlying_ticks.ndjson.gz"))},
                  reverse=True)
    if date in days:
        days.insert(0, days.pop(days.index(date)))
    for day in days:
        for inst in INSTRUMENTS:
            if inst in out.values():
                continue
            path = os.path.join(RAW_DIR, day, f"{inst}_underlying_ticks.ndjson.gz")
            if not os.path.exists(path):
                continue
            try:
                with gzip.open(path, "rt") as fh:
                    for line in fh:
                        sid = (json.loads(line) or {}).get("security_id")
                        if sid:
                            out[str(sid)] = inst
                            break
            except (EOFError, zlib.error, OSError, json.JSONDecodeError, ValueError):
                continue
        if len(out) >= len(INSTRUMENTS):
            break
    return out


# ── live ─────────────────────────────────────────────────────────────────


class LiveSource:
    """Decodes the server's raw Dhan binary relay into tick dicts.

    Runs its own thread and pushes onto a queue so the UI never blocks.
    """

    def __init__(self, url: str = DEFAULT_WS, security_map: Optional[dict] = None):
        self.url = url
        self.security_map = security_map or resolve_security_map()
        self.q: queue.Queue = queue.Queue(maxsize=20000)
        self.status = "starting"
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run_forever(self) -> None:
        import asyncio

        while not self._stop.is_set():
            try:
                asyncio.run(self._consume())
            except Exception as exc:
                self.status = f"disconnected ({type(exc).__name__})"
                # The server may simply not be running yet; keep retrying quietly.
                for _ in range(50):
                    if self._stop.is_set():
                        return
                    time.sleep(0.1)

    async def _consume(self) -> None:
        import websockets

        from tick_feature_agent.feed.binary_parser import dispatch

        async with websockets.connect(self.url, max_size=None) as ws:
            self.status = "live"
            while not self._stop.is_set():
                frame = await ws.recv()
                if not isinstance(frame, (bytes, bytearray)):
                    continue
                # A frame can carry several packets back to back.
                off = 0
                while off + 8 <= len(frame):
                    header, payload = dispatch(frame[off:])
                    size = header.message_length if header.message_length > 0 else 0
                    if size <= 0 or off + size > len(frame):
                        break
                    if payload is not None:
                        inst = self.security_map.get(str(header.security_id))
                        if inst:
                            payload.setdefault("security_id", str(header.security_id))
                            self._push(inst, payload)
                    off += size

    def _push(self, inst: str, tick: dict) -> None:
        try:
            self.q.put_nowait((inst, tick))
        except queue.Full:
            pass  # drop rather than stall the feed


# ── replay ───────────────────────────────────────────────────────────────


class ReplaySource:
    """Plays a recorded day back through the same queue as LiveSource."""

    def __init__(self, date: str, instruments=INSTRUMENTS, speed: float = 60.0):
        self.date = date
        self.instruments = [i for i in instruments if self._path(i)]
        self.speed = max(0.0, float(speed))
        self.q: queue.Queue = queue.Queue(maxsize=20000)
        self.status = f"replay {date} @{speed:g}x"
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def _path(self, inst: str) -> Optional[str]:
        p = os.path.join(RAW_DIR, self.date, f"{inst}_underlying_ticks.ndjson.gz")
        return p if os.path.exists(p) else None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        # Merge all instruments in timestamp order so the quadrants advance
        # together, the way they do live.
        streams = []
        for inst in self.instruments:
            try:
                streams.append((inst, self._iter(inst)))
            except OSError:
                continue
        heads = []
        for inst, it in streams:
            nxt = next(it, None)
            if nxt is not None:
                heads.append([nxt.get("recv_ts", 0.0), inst, nxt, it])

        wall0 = time.time()
        t0 = min((h[0] for h in heads), default=0.0)
        while heads and not self._stop.is_set():
            heads.sort(key=lambda h: h[0])
            ts, inst, tick, it = heads[0]
            if self.speed > 0:
                target = wall0 + (ts - t0) / self.speed
                delay = target - time.time()
                if delay > 0:
                    time.sleep(min(delay, 0.25))
                    continue
            try:
                self.q.put_nowait((inst, tick))
            except queue.Full:
                pass
            nxt = next(it, None)
            if nxt is None:
                heads.pop(0)
            else:
                heads[0] = [nxt.get("recv_ts", 0.0), inst, nxt, it]
        self.status = f"replay {self.date} finished"

    def _iter(self, inst: str) -> Iterator[dict]:
        path = self._path(inst)
        try:
            with gzip.open(path, "rt") as fh:
                for line in fh:
                    if self._stop.is_set():
                        return
                    try:
                        yield json.loads(line)
                    except (json.JSONDecodeError, ValueError):
                        continue
        except (EOFError, zlib.error, OSError):
            return


def latest_recorded_date(instrument: str = "nifty50") -> Optional[str]:
    pat = os.path.join(RAW_DIR, "*", f"{instrument}_underlying_ticks.ndjson.gz")
    dates = sorted(os.path.basename(os.path.dirname(p)) for p in glob.glob(pat))
    return dates[-1] if dates else None
