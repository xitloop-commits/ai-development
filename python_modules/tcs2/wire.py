"""TCS2 - Dhan WebSocket feed v2 binary wire format.

Spec: docs/systems/14_tcs2.md  (D27 - our own code, copied from the rules rather
than imported from tick_feature_agent or the Node adapter)

Pure functions, no state, no I/O. Everything is little-endian.

Packet codes (byte 0 of every packet):
     1  INDEX        price + timestamp only, same shape as TICKER
     2  TICKER       ltp + ltt
     4  QUOTE        ltp, ltq, ltt, atp, volume, buy/sell totals, day OHLC
     5  OI           open interest only
     6  PREV_CLOSE   previous close + previous OI
     7  MARKET_STATUS
     8  FULL         everything plus 5-level depth, 162 bytes
    50  DISCONNECT   server-initiated, with a reason code

TWO DELIBERATE DIFFERENCES FROM TFA'S PARSER
--------------------------------------------
1. **A frame can hold MANY packets, and we read all of them.**
   Every packet header carries its own `message_length`, which exists so packets
   can be concatenated in one WebSocket frame. TFA parses only the first
   (`tick_feature_agent/feed/dhan_feed.py:390` calls `dispatch(buf)` once per
   frame) and silently drops the rest. `iter_packets()` walks the whole frame.
   This is a candidate explanation for why only 192 of 472 nifty legs appeared
   to tick on 2026-09-22 - to be confirmed live in phase 1 by counting packets
   per frame.

2. **Ticks are NamedTuples, not dicts.**
   At roughly 3 million ticks a day across four processes, a fresh 20-key dict
   per tick is real allocation pressure. A NamedTuple is tuple-backed, immutable,
   and still readable by field name.
"""
from __future__ import annotations

import struct
import time
from typing import Iterator, NamedTuple


class ResponseCode:
    INDEX = 1
    TICKER = 2
    QUOTE = 4
    OI = 5
    PREV_CLOSE = 6
    MARKET_STATUS = 7
    FULL = 8
    DISCONNECT = 50


class RequestCode:
    CONNECT = 11
    DISCONNECT = 12
    SUBSCRIBE_TICKER = 15
    UNSUBSCRIBE_TICKER = 16
    SUBSCRIBE_QUOTE = 17
    UNSUBSCRIBE_QUOTE = 18
    SUBSCRIBE_FULL = 21
    UNSUBSCRIBE_FULL = 22


# Byte 3 of the header -> segment name.
EXCHANGE_SEGMENT_NAME: dict[int, str] = {
    0: "IDX_I",
    1: "NSE_EQ",
    2: "NSE_FNO",
    3: "NSE_CURRENCY",
    4: "BSE_EQ",
    5: "MCX_COMM",
    7: "BSE_CURRENCY",
    8: "BSE_FNO",
}
EXCHANGE_SEGMENT_CODE: dict[str, int] = {v: k for k, v in EXCHANGE_SEGMENT_NAME.items()}

# Disconnect reasons. 804 is the one the connection plan is betting against
# (T192): it means a single connection was given more instruments than Dhan
# allows. 5,000 is Dhan's documented cap; 475 is all we have ever proven live.
DISCONNECT_REASON: dict[int, str] = {
    804: "Instruments exceed limit",
    805: "Too many connections",
    806: "Data APIs not subscribed",
    807: "Access token expired",
    808: "Authentication failed",
    809: "Access token invalid",
    810: "Client ID invalid",
}

HEADER_BYTES = 8
FULL_BYTES = 162
DEPTH_LEVELS = 5
_DEPTH_LEVEL_BYTES = 20


class Header(NamedTuple):
    response_code: int      # uint8  @0
    message_length: int     # int16  @1  - this packet's own length
    exchange_segment: int   # uint8  @3
    security_id: int        # int32  @4


class DepthLevel(NamedTuple):
    bid_qty: int
    ask_qty: int
    bid_orders: int
    ask_orders: int
    bid_price: float
    ask_price: float


class Tick(NamedTuple):
    """One parsed packet.

    Fields absent from a given packet type stay at their defaults, so a consumer
    never has to branch on packet type to read a price. `kind` says which packet
    it came from when that matters.
    """

    security_id: int
    segment: int
    kind: int                       # the ResponseCode it arrived as
    recv_ts: float
    ltp: float = 0.0
    ltq: int = 0
    ltt: int = 0
    atp: float = 0.0
    volume: int = 0                 # cumulative for the day, NOT per trade
    total_buy: int = 0
    total_sell: int = 0
    oi: int = 0
    high_oi: int = 0
    low_oi: int = 0
    day_open: float = 0.0
    day_high: float = 0.0
    day_low: float = 0.0
    day_close: float = 0.0
    prev_close: float = 0.0
    prev_oi: int = 0
    bid: float = 0.0
    ask: float = 0.0
    bid_size: int = 0
    ask_size: int = 0
    depth: tuple[DepthLevel, ...] = ()

    @property
    def has_book(self) -> bool:
        """True when this packet carried a real book.

        Both sides zero means no depth was sent - a pre-depth packet, not a
        market with no bid and no ask. Trade-side classification must treat that
        as unknown rather than as a passive print.
        """
        return not (self.bid == 0.0 and self.ask == 0.0)


class Disconnect(NamedTuple):
    code: int
    reason: str


_HDR = struct.Struct("<BhBi")                  # 8 bytes
_TICKER = struct.Struct("<fi")                 # ltp, ltt                  @8
_QUOTE = struct.Struct("<fhifiiiffff")         # 40 bytes                  @8
_OI = struct.Struct("<i")                      # oi                        @8
_PREV = struct.Struct("<fi")                   # prevClose, prevOI         @8
_FULL = struct.Struct("<fhifiiiiiiffff")       # 54 bytes                  @8
_DEPTH = struct.Struct("<iihh2f")              # 20 bytes per level
_DISC = struct.Struct("<h")


def parse_header(buf: bytes, offset: int = 0) -> Header:
    if len(buf) - offset < HEADER_BYTES:
        raise ValueError(f"short header: {len(buf) - offset} < {HEADER_BYTES}")
    return Header(*_HDR.unpack_from(buf, offset))


def _depth(buf: bytes, offset: int) -> tuple[DepthLevel, ...]:
    out = []
    for i in range(DEPTH_LEVELS):
        base = offset + i * _DEPTH_LEVEL_BYTES
        if base + _DEPTH_LEVEL_BYTES > len(buf):
            break
        out.append(DepthLevel(*_DEPTH.unpack_from(buf, base)))
    return tuple(out)


def parse_packet(buf: bytes, offset: int = 0) -> Tick | Disconnect | None:
    """Parse one packet at `offset`. None for unknown or truncated packets."""
    h = parse_header(buf, offset)
    rc = h.response_code
    body = offset + HEADER_BYTES
    avail = len(buf) - offset
    now = time.time()

    if rc in (ResponseCode.TICKER, ResponseCode.INDEX):
        if avail < 16:
            return None
        ltp, ltt = _TICKER.unpack_from(buf, body)
        return Tick(h.security_id, h.exchange_segment, rc, now, ltp=ltp, ltt=ltt)

    if rc == ResponseCode.QUOTE:
        if avail < 50:
            return None
        (ltp, ltq, ltt, atp, volume, total_sell, total_buy,
         d_open, d_close, d_high, d_low) = _QUOTE.unpack_from(buf, body)
        return Tick(h.security_id, h.exchange_segment, rc, now,
                    ltp=ltp, ltq=ltq, ltt=ltt, atp=atp, volume=volume,
                    total_buy=total_buy, total_sell=total_sell,
                    day_open=d_open, day_close=d_close,
                    day_high=d_high, day_low=d_low)

    if rc == ResponseCode.OI:
        if avail < 12:
            return None
        (oi,) = _OI.unpack_from(buf, body)
        return Tick(h.security_id, h.exchange_segment, rc, now, oi=oi)

    if rc == ResponseCode.PREV_CLOSE:
        if avail < 16:
            return None
        prev_close, prev_oi = _PREV.unpack_from(buf, body)
        return Tick(h.security_id, h.exchange_segment, rc, now,
                    prev_close=prev_close, prev_oi=prev_oi)

    if rc == ResponseCode.FULL:
        if avail < FULL_BYTES:
            return None
        (ltp, ltq, ltt, atp, volume, total_sell, total_buy, oi, high_oi, low_oi,
         d_open, d_close, d_high, d_low) = _FULL.unpack_from(buf, body)
        levels = _depth(buf, body + 54)
        top = levels[0] if levels else None
        return Tick(h.security_id, h.exchange_segment, rc, now,
                    ltp=ltp, ltq=ltq, ltt=ltt, atp=atp, volume=volume,
                    total_buy=total_buy, total_sell=total_sell,
                    oi=oi, high_oi=high_oi, low_oi=low_oi,
                    day_open=d_open, day_close=d_close,
                    day_high=d_high, day_low=d_low,
                    bid=top.bid_price if top else 0.0,
                    ask=top.ask_price if top else 0.0,
                    bid_size=top.bid_qty if top else 0,
                    ask_size=top.ask_qty if top else 0,
                    depth=levels)

    if rc == ResponseCode.DISCONNECT:
        code = _DISC.unpack_from(buf, body)[0] if avail >= 10 else 0
        return Disconnect(code, DISCONNECT_REASON.get(code, f"Unknown ({code})"))

    return None        # MARKET_STATUS and anything new: caller logs and carries on


# Minimum bytes a packet of each code occupies, used to advance when a header
# reports a message_length we cannot trust.
_MIN_LEN = {
    ResponseCode.INDEX: 16, ResponseCode.TICKER: 16, ResponseCode.QUOTE: 50,
    ResponseCode.OI: 12, ResponseCode.PREV_CLOSE: 16, ResponseCode.FULL: FULL_BYTES,
    ResponseCode.DISCONNECT: 10, ResponseCode.MARKET_STATUS: HEADER_BYTES,
}


def iter_packets(buf: bytes) -> Iterator[Tick | Disconnect]:
    """Walk EVERY packet in a frame, not just the first.

    Dhan concatenates packets in one WebSocket frame and each header carries its
    own `message_length`. Reading one packet per frame loses the rest silently,
    which is what TFA does today.

    A `message_length` that is zero, negative, or shorter than the packet type's
    own minimum cannot be trusted to advance the cursor, so the minimum is used
    instead. If neither can advance, parsing stops rather than looping forever.
    """
    pos = 0
    n = len(buf)
    while pos + HEADER_BYTES <= n:
        try:
            h = parse_header(buf, pos)
        except ValueError:
            return
        parsed = parse_packet(buf, pos)
        if parsed is not None:
            yield parsed
        step = h.message_length
        floor = _MIN_LEN.get(h.response_code, HEADER_BYTES)
        if step < floor:
            step = floor
        if step <= 0:
            return
        pos += step


def build_subscribe(security_ids: list[tuple[str, str]], request_code: int,
                    ) -> list[dict]:
    """Subscribe messages, split to at most MAX_INSTRUMENTS_PER_MSG each.

    `security_ids` is a list of (segment_name, security_id). Returns JSON-ready
    dicts; the caller adds nothing.
    """
    from . import config as cfg

    out: list[dict] = []
    chunk = cfg.MAX_INSTRUMENTS_PER_MSG
    for i in range(0, len(security_ids), chunk):
        batch = security_ids[i:i + chunk]
        out.append({
            "RequestCode": request_code,
            "InstrumentCount": len(batch),
            "InstrumentList": [
                {"ExchangeSegment": seg, "SecurityId": str(sid)} for seg, sid in batch
            ],
        })
    return out
