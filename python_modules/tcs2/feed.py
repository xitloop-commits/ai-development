"""TCS2 - our own Dhan WebSocket feed client.

Spec: docs/systems/14_tcs2.md  (D7, D13, D14, D27)

One connection per process (D13), owned entirely by this module. Imports nothing
from tick_feature_agent or the Node adapter (D27).

    wss://api-feed.dhan.co?version=2&token=<token>&clientId=<id>&authType=2

Design notes:
  * **Every packet in a frame is read** (`wire.iter_packets`). See T194.
  * **Stats are collected for free**, including a packets-per-frame histogram.
    That histogram is the measurement T194 needs and the reason this client
    counts at all.
  * **The callback runs on the receive path**, so it must be fast. Under D16 the
    feed lives on a worker thread and the screen reads snapshots, so the callback
    must never touch the GUI.
  * **A disconnect code is surfaced, not swallowed.** 804 means the connection was
    given more instruments than Dhan allows, which is the one thing the
    connection plan (T192) is betting against.
"""
from __future__ import annotations

import asyncio
import collections
import json
import time
from dataclasses import dataclass, field
from typing import Callable, Iterable

import websockets

from . import config as cfg
from . import wire
from .wire import Disconnect, RequestCode, Tick

DHAN_WS_URL = "wss://api-feed.dhan.co"

TickHandler = Callable[[Tick], None]


@dataclass
class FeedStats:
    """Counters the feed keeps as it runs. Cheap, and they answer real questions."""

    connected_at: float = 0.0
    frames: int = 0
    bytes_in: int = 0
    packets: int = 0
    ticks: int = 0
    unknown_packets: int = 0
    by_kind: collections.Counter = field(default_factory=collections.Counter)
    packets_per_frame: collections.Counter = field(default_factory=collections.Counter)
    securities: set[int] = field(default_factory=set)
    last_tick_at: float = 0.0
    disconnects: list[Disconnect] = field(default_factory=list)

    @property
    def uptime(self) -> float:
        return time.time() - self.connected_at if self.connected_at else 0.0

    @property
    def ticks_per_sec(self) -> float:
        up = self.uptime
        return self.ticks / up if up > 0 else 0.0

    @property
    def max_packets_in_one_frame(self) -> int:
        return max(self.packets_per_frame) if self.packets_per_frame else 0

    def kind_name(self, code: int) -> str:
        return {
            wire.ResponseCode.INDEX: "INDEX",
            wire.ResponseCode.TICKER: "TICKER",
            wire.ResponseCode.QUOTE: "QUOTE",
            wire.ResponseCode.OI: "OI",
            wire.ResponseCode.PREV_CLOSE: "PREV_CLOSE",
            wire.ResponseCode.FULL: "FULL",
        }.get(code, f"code {code}")

    def summary(self) -> str:
        lines = [
            f"uptime {self.uptime:.1f}s   frames {self.frames:,}   "
            f"packets {self.packets:,}   ticks {self.ticks:,} "
            f"({self.ticks_per_sec:,.0f}/s)",
            f"bytes in {self.bytes_in:,}   distinct securities seen "
            f"{len(self.securities):,}",
        ]
        if self.by_kind:
            kinds = "  ".join(f"{self.kind_name(k)}={v:,}"
                              for k, v in self.by_kind.most_common())
            lines.append(f"packet types: {kinds}")
        if self.packets_per_frame:
            hist = "  ".join(f"{n}pkt x{c:,}"
                             for n, c in sorted(self.packets_per_frame.items()))
            lines.append(f"packets per frame: {hist}")
            lines.append(f"MAX packets in one frame: {self.max_packets_in_one_frame}")
        for d in self.disconnects:
            lines.append(f"DISCONNECT {d.code}: {d.reason}")
        return "\n".join(lines)


class DhanFeed:
    """One Dhan WS connection. One per process (D13)."""

    def __init__(self, access_token: str, client_id: str,
                 on_tick: TickHandler | None = None,
                 mode: int = RequestCode.SUBSCRIBE_FULL) -> None:
        self._token = access_token
        self._client_id = str(client_id)
        self._on_tick = on_tick
        self._mode = mode
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._running = False
        self.stats = FeedStats()

    @property
    def url(self) -> str:
        return (f"{DHAN_WS_URL}?version=2&token={self._token}"
                f"&clientId={self._client_id}&authType=2")

    async def connect(self) -> None:
        # max_size=None: a frame holding many packets can be large, and a size cap
        # would drop exactly the batched frames T194 is about.
        self._ws = await websockets.connect(self.url, max_size=None,
                                            ping_interval=20, ping_timeout=20)
        self._running = True
        self.stats.connected_at = time.time()

    async def subscribe(self, legs: Iterable[tuple[str, str]]) -> int:
        """Subscribe (segment_name, security_id) pairs. Returns messages sent.

        Split into batches of MAX_INSTRUMENTS_PER_MSG because Dhan rejects more
        than that in one message. nifty's ~1,500 legs is 15 messages.
        """
        if self._ws is None:
            raise RuntimeError("not connected")
        msgs = wire.build_subscribe(list(legs), self._mode)
        for m in msgs:
            await self._ws.send(json.dumps(m))
        return len(msgs)

    def _handle_frame(self, buf: bytes) -> None:
        self.stats.frames += 1
        self.stats.bytes_in += len(buf)
        n = 0
        for parsed in wire.iter_packets(buf):
            n += 1
            if isinstance(parsed, Disconnect):
                self.stats.disconnects.append(parsed)
                self._running = False
                continue
            self.stats.ticks += 1
            self.stats.by_kind[parsed.kind] += 1
            self.stats.securities.add(parsed.security_id)
            self.stats.last_tick_at = parsed.recv_ts
            if self._on_tick is not None:
                self._on_tick(parsed)
        self.stats.packets += n
        self.stats.packets_per_frame[n] += 1

    async def run(self, seconds: float | None = None) -> FeedStats:
        """Receive until `seconds` elapse, or forever when None."""
        if self._ws is None:
            raise RuntimeError("not connected")
        deadline = time.time() + seconds if seconds else None
        try:
            while self._running:
                timeout = None
                if deadline is not None:
                    timeout = deadline - time.time()
                    if timeout <= 0:
                        break
                try:
                    buf = await asyncio.wait_for(self._ws.recv(), timeout=timeout)
                except asyncio.TimeoutError:
                    break
                if isinstance(buf, bytes):
                    self._handle_frame(buf)
        except websockets.ConnectionClosed:
            self._running = False
        return self.stats

    async def close(self) -> None:
        self._running = False
        if self._ws is not None:
            await self._ws.close()
            self._ws = None


# -- credentials ---------------------------------------------------------

def load_credentials(broker_id: str = "dhan-primary-ac",
                     mongo_uri: str = "mongodb://localhost:27017/lucky_baskar",
                     ) -> tuple[str, str]:
    """Read the Dhan token and client id.

    D7 says TCS2 does not depend on the API SERVER; Mongo is a database, not the
    server, and the 2026-09-18 outage was the Node process, not the database.
    Reading credentials straight from Mongo keeps TCS2 independent of anything
    that gets restarted during a session.
    """
    from pymongo import MongoClient

    db = MongoClient(mongo_uri, serverSelectionTimeoutMS=5000).get_default_database()
    doc = db.broker_configs.find_one({"brokerId": broker_id})
    if not doc:
        raise RuntimeError(f"no broker_configs doc for {broker_id}")
    creds = doc.get("credentials") or {}
    token, cid = creds.get("accessToken"), creds.get("clientId")
    if not token or not cid:
        raise RuntimeError(f"{broker_id}: credentials incomplete")
    return token, str(cid)
