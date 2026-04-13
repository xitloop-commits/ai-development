"""
binary_parser.py — Stateless binary packet parsers for Dhan WS feed v2.

Direct port of server/broker/adapters/dhan/websocket.ts parsing logic.
All packets are Little Endian. No state, no side effects — pure functions.

Packet codes (response_code, byte 0 of every message):
    1  INDEX       — index ticks (treated like Ticker)
    2  TICKER      — ltp + ltt only
    4  QUOTE       — ltp, ltq, ltt, atp, volume, OHLC
    5  OI          — open interest only
    6  PREV_CLOSE  — prevClose + prevOI
    7  MARKET_STATUS
    8  FULL        — all fields + 5-level market depth (162 bytes)
   50  DISCONNECT  — server-initiated disconnect with reason code

TFA subscribes all instruments in FULL mode (RequestCode 21) — required
for bid/ask/bid_size/ask_size from depth level 0.
"""

from __future__ import annotations

import struct
import time
from typing import NamedTuple


# ── Response / Request codes ──────────────────────────────────────────────────

class ResponseCode:
    INDEX         = 1
    TICKER        = 2
    QUOTE         = 4
    OI            = 5
    PREV_CLOSE    = 6
    MARKET_STATUS = 7
    FULL          = 8
    DISCONNECT    = 50


class RequestCode:
    CONNECT            = 11
    DISCONNECT         = 12
    SUBSCRIBE_TICKER   = 15
    UNSUBSCRIBE_TICKER = 16
    SUBSCRIBE_QUOTE    = 17
    UNSUBSCRIBE_QUOTE  = 18
    SUBSCRIBE_FULL     = 21
    UNSUBSCRIBE_FULL   = 22


# ── Exchange segment mapping ──────────────────────────────────────────────────

# Byte 3 of header → string name
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

# String name → byte value (for subscribe messages)
EXCHANGE_SEGMENT_CODE: dict[str, int] = {v: k for k, v in EXCHANGE_SEGMENT_NAME.items()}

# Disconnect reason codes
DISCONNECT_REASON: dict[int, str] = {
    804: "Instruments exceed limit",
    805: "Too many connections",
    806: "Data APIs not subscribed",
    807: "Access token expired",
    808: "Authentication failed",
    809: "Access token invalid",
    810: "Client ID invalid",
}


# ── Header ────────────────────────────────────────────────────────────────────

class PacketHeader(NamedTuple):
    response_code:    int   # uint8  @0
    message_length:   int   # int16  @1
    exchange_segment: int   # uint8  @3  (numeric code)
    security_id:      int   # int32  @4

# Struct: uint8(1) + int16(2) + uint8(1) + int32(4) = 8 bytes
_HDR_FMT = struct.Struct("<BhBi")


def parse_header(buf: bytes | bytearray) -> PacketHeader:
    """Parse the 8-byte header present in every Dhan WS packet."""
    if len(buf) < 8:
        raise ValueError(f"Buffer too short for header: {len(buf)} < 8 bytes")
    rc, msg_len, exch_seg, sec_id = _HDR_FMT.unpack_from(buf, 0)
    return PacketHeader(
        response_code=rc,
        message_length=msg_len,
        exchange_segment=exch_seg,
        security_id=sec_id,
    )


# ── Ticker (code 2) ───────────────────────────────────────────────────────────
# Bytes: 0-7 header | 8-11 ltp(f32) | 12-15 ltt(i32)

_TICKER_FMT = struct.Struct("<fi")   # ltp, ltt


def parse_ticker_packet(buf: bytes | bytearray) -> dict:
    """Parse Ticker packet (code 2). Returns ltp and ltt."""
    if len(buf) < 16:
        raise ValueError(f"Ticker packet too short: {len(buf)} < 16")
    ltp, ltt = _TICKER_FMT.unpack_from(buf, 8)
    return {
        "ltp": ltp,
        "ltt": ltt,
        "recv_ts": time.time(),
    }


# ── Quote (code 4) ────────────────────────────────────────────────────────────
# Bytes: 8-11 ltp(f32) | 12-13 ltq(i16) | 14-17 ltt(i32) | 18-21 atp(f32)
#        22-25 volume(i32) | 26-29 totalSellQty(i32) | 30-33 totalBuyQty(i32)
#        34-37 dayOpen(f32) | 38-41 dayClose(f32) | 42-45 dayHigh(f32) | 46-49 dayLow(f32)

_QUOTE_FMT = struct.Struct("<fhifiiiffff")   # 40 bytes at offset 8


def parse_quote_packet(buf: bytes | bytearray) -> dict:
    """Parse Quote packet (code 4)."""
    if len(buf) < 50:
        raise ValueError(f"Quote packet too short: {len(buf)} < 50")
    (ltp, ltq, ltt, atp, volume, total_sell, total_buy,
     day_open, day_close, day_high, day_low) = _QUOTE_FMT.unpack_from(buf, 8)
    return {
        "ltp":          ltp,
        "ltq":          ltq,
        "ltt":          ltt,
        "atp":          atp,
        "volume":       volume,
        "total_sell":   total_sell,
        "total_buy":    total_buy,
        "day_open":     day_open,
        "day_close":    day_close,
        "day_high":     day_high,
        "day_low":      day_low,
        "recv_ts":      time.time(),
    }


# ── OI (code 5) ───────────────────────────────────────────────────────────────
# Bytes: 8-11 oi(i32)

def parse_oi_packet(buf: bytes | bytearray) -> dict:
    """Parse OI packet (code 5). Returns open interest."""
    if len(buf) < 12:
        raise ValueError(f"OI packet too short: {len(buf)} < 12")
    oi, = struct.unpack_from("<i", buf, 8)
    return {"oi": oi, "recv_ts": time.time()}


# ── PrevClose (code 6) ────────────────────────────────────────────────────────
# Bytes: 8-11 prevClose(f32) | 12-15 prevOI(i32)

_PREV_CLOSE_FMT = struct.Struct("<fi")


def parse_prev_close_packet(buf: bytes | bytearray) -> dict:
    """Parse PrevClose packet (code 6). Returns prevClose and prevOI."""
    if len(buf) < 16:
        raise ValueError(f"PrevClose packet too short: {len(buf)} < 16")
    prev_close, prev_oi = _PREV_CLOSE_FMT.unpack_from(buf, 8)
    return {
        "prev_close": prev_close,
        "prev_oi":    prev_oi,
        "recv_ts":    time.time(),
    }


# ── Depth levels ──────────────────────────────────────────────────────────────
# Each level: bidQty(i32) askQty(i32) bidOrders(i16) askOrders(i16) bidPrice(f32) askPrice(f32) = 20 bytes

_DEPTH_LEVEL_FMT = struct.Struct("<iihh2f")   # 20 bytes per level


def parse_depth_levels(buf: bytes | bytearray, offset: int) -> list[dict]:
    """Parse 5 market depth levels starting at `offset`."""
    levels = []
    for i in range(5):
        base = offset + i * 20
        if base + 20 > len(buf):
            break
        bid_qty, ask_qty, bid_orders, ask_orders, bid_price, ask_price = \
            _DEPTH_LEVEL_FMT.unpack_from(buf, base)
        levels.append({
            "bid_qty":    bid_qty,
            "ask_qty":    ask_qty,
            "bid_orders": bid_orders,
            "ask_orders": ask_orders,
            "bid_price":  bid_price,
            "ask_price":  ask_price,
        })
    return levels


# ── Full (code 8) ─────────────────────────────────────────────────────────────
# 162 bytes total: 8 header + 54 data + 100 depth (5 × 20)
#
# Bytes: 8-11 ltp(f32) | 12-13 ltq(i16) | 14-17 ltt(i32) | 18-21 atp(f32)
#        22-25 volume(i32) | 26-29 totalSellQty(i32) | 30-33 totalBuyQty(i32)
#        34-37 oi(i32) | 38-41 highOI(i32) | 42-45 lowOI(i32)
#        46-49 dayOpen(f32) | 50-53 dayClose(f32) | 54-57 dayHigh(f32) | 58-61 dayLow(f32)
#        62-161 depth (5 × 20 bytes)

_FULL_FMT = struct.Struct("<fhifiiiiiiffff")   # 54 bytes at offset 8


def parse_full_packet(buf: bytes | bytearray) -> dict:
    """
    Parse Full packet (code 8). 162 bytes.
    Returns all fields including 5-level depth and derived bid/ask/bid_size/ask_size.
    """
    if len(buf) < 162:
        raise ValueError(f"Full packet too short: {len(buf)} < 162 bytes")

    (ltp, ltq, ltt, atp, volume, total_sell, total_buy,
     oi, high_oi, low_oi,
     day_open, day_close, day_high, day_low) = _FULL_FMT.unpack_from(buf, 8)

    depth = parse_depth_levels(buf, 62)
    top = depth[0] if depth else {}

    return {
        "ltp":          ltp,
        "ltq":          ltq,         # per-tick traded qty — TFA uses this as 'volume'
        "ltt":          ltt,
        "atp":          atp,
        "volume":       volume,      # cumulative day volume (TFA ignores for features)
        "total_sell":   total_sell,
        "total_buy":    total_buy,
        "oi":           oi,
        "high_oi":      high_oi,
        "low_oi":       low_oi,
        "day_open":     day_open,
        "day_close":    day_close,
        "day_high":     day_high,
        "day_low":      day_low,
        # Derived from depth level 0
        "bid":          top.get("bid_price", 0.0),
        "ask":          top.get("ask_price", 0.0),
        "bid_size":     top.get("bid_qty", 0),
        "ask_size":     top.get("ask_qty", 0),
        "depth":        depth,
        "recv_ts":      time.time(),
    }


# ── Disconnect (code 50) ──────────────────────────────────────────────────────

def parse_disconnect_packet(buf: bytes | bytearray) -> dict:
    """Parse server-initiated disconnect packet (code 50)."""
    code = 0
    if len(buf) >= 10:
        code, = struct.unpack_from("<h", buf, 8)
    reason = DISCONNECT_REASON.get(code, f"Unknown ({code})")
    return {"disconnect_code": code, "reason": reason}


# ── Dispatch ──────────────────────────────────────────────────────────────────

def dispatch(buf: bytes | bytearray) -> tuple[PacketHeader, dict | None]:
    """
    Parse any Dhan WS binary message.

    Returns (header, payload_dict) where payload_dict is None for unknown
    or too-short packets. Does NOT raise on unknown response codes —
    unknown codes return (header, None) so the caller can log and continue.
    """
    if len(buf) < 8:
        return PacketHeader(0, 0, 0, 0), None

    header = parse_header(buf)
    rc = header.response_code

    try:
        if rc in (ResponseCode.TICKER, ResponseCode.INDEX):
            return header, parse_ticker_packet(buf)
        elif rc == ResponseCode.QUOTE:
            return header, parse_quote_packet(buf)
        elif rc == ResponseCode.OI:
            return header, parse_oi_packet(buf)
        elif rc == ResponseCode.PREV_CLOSE:
            return header, parse_prev_close_packet(buf)
        elif rc == ResponseCode.FULL:
            return header, parse_full_packet(buf)
        elif rc == ResponseCode.DISCONNECT:
            return header, parse_disconnect_packet(buf)
        else:
            return header, None
    except (ValueError, struct.error):
        return header, None
