"""TCS2 - tests for the Dhan binary wire format.

Spec: docs/systems/14_tcs2.md

Packets are built here byte by byte from the documented layout, so these tests
check our parser against the SPEC rather than against TFA's parser. If both are
wrong in the same way, these tests still catch it.
"""
from __future__ import annotations

import struct

import pytest

from tcs2 import wire
from tcs2.wire import DepthLevel, Disconnect, ResponseCode, Tick


def _hdr(code: int, length: int, segment: int, sec_id: int) -> bytes:
    return struct.pack("<BhBi", code, length, segment, sec_id)


def ticker(sec_id: int = 111, ltp: float = 23476.25, ltt: int = 1790000000) -> bytes:
    return _hdr(ResponseCode.TICKER, 16, 2, sec_id) + struct.pack("<fi", ltp, ltt)


def oi_packet(sec_id: int = 222, oi: int = 5_696_000) -> bytes:
    return _hdr(ResponseCode.OI, 12, 2, sec_id) + struct.pack("<i", oi)


def quote(sec_id: int = 333) -> bytes:
    return _hdr(ResponseCode.QUOTE, 50, 2, sec_id) + struct.pack(
        "<fhifiiiffff",
        101.5, 130, 1790000001, 100.25, 131235, 163670, 1154140,
        99.0, 100.5, 104.0, 98.5)


def full(sec_id: int = 444, ltp: float = 1.10, bid: float = 1.05,
         ask: float = 1.15, oi: int = 2_679_560) -> bytes:
    body = struct.pack(
        "<fhifiiiiiiffff",
        ltp, 130, 1790068500, 1.30, 131235, 163670, 1154140,
        oi, oi + 500, oi - 500,
        1.5, 2.95, 1.5, 1.1)
    depth = b""
    for i in range(5):
        depth += struct.pack("<iihh2f",
                             19045 - i, 17095 - i, 12, 9,
                             bid - i * 0.05, ask + i * 0.05)
    pkt = _hdr(ResponseCode.FULL, wire.FULL_BYTES, 2, sec_id) + body + depth
    assert len(pkt) == wire.FULL_BYTES, len(pkt)
    return pkt


# -- header --------------------------------------------------------------

def test_header_fields():
    h = wire.parse_header(ticker(sec_id=68407))
    assert h.response_code == ResponseCode.TICKER
    assert h.message_length == 16
    assert h.exchange_segment == 2
    assert h.security_id == 68407


def test_short_header_raises():
    with pytest.raises(ValueError):
        wire.parse_header(b"\x02\x10")


# -- individual packet types --------------------------------------------

def test_ticker():
    t = wire.parse_packet(ticker(ltp=23476.25))
    assert isinstance(t, Tick)
    assert t.kind == ResponseCode.TICKER
    assert t.ltp == pytest.approx(23476.25)
    assert t.oi == 0 and t.volume == 0      # not carried by a ticker packet


def test_index_packet_parses_like_a_ticker():
    """Code 1 is the index, and it carries price only.

    This is why spec 15 S1 cannot supply volume or structure: the NIFTY index
    arrives in ticker mode with no volume, no OI and no book.
    """
    buf = _hdr(ResponseCode.INDEX, 16, 0, 13) + struct.pack("<fi", 23476.2, 1790000000)
    t = wire.parse_packet(buf)
    assert t.kind == ResponseCode.INDEX
    assert t.ltp == pytest.approx(23476.2)
    assert t.volume == 0 and t.oi == 0 and not t.has_book


def test_oi_packet():
    t = wire.parse_packet(oi_packet(oi=5_696_000))
    assert t.oi == 5_696_000
    assert t.ltp == 0.0


def test_quote_packet():
    t = wire.parse_packet(quote())
    assert t.volume == 131235
    assert t.total_buy == 1154140
    assert t.total_sell == 163670
    assert t.day_high == pytest.approx(104.0)


def test_prev_close_packet():
    buf = _hdr(ResponseCode.PREV_CLOSE, 16, 2, 555) + struct.pack("<fi", 2.95, 2_600_000)
    t = wire.parse_packet(buf)
    assert t.prev_close == pytest.approx(2.95)
    assert t.prev_oi == 2_600_000


def test_full_packet_all_fields_and_depth():
    t = wire.parse_packet(full(ltp=1.10, bid=1.05, ask=1.15, oi=2_679_560))
    assert t.kind == ResponseCode.FULL
    assert t.ltp == pytest.approx(1.10)
    assert t.oi == 2_679_560
    assert t.high_oi == 2_680_060
    assert t.low_oi == 2_679_060
    assert t.bid == pytest.approx(1.05)
    assert t.ask == pytest.approx(1.15)
    assert t.bid_size == 19045
    assert t.ask_size == 17095
    assert len(t.depth) == 5
    assert isinstance(t.depth[0], DepthLevel)
    # level 1 is worse than level 0 on both sides
    assert t.depth[1].bid_price < t.depth[0].bid_price
    assert t.depth[1].ask_price > t.depth[0].ask_price


def test_full_packet_is_162_bytes():
    assert len(full()) == 162


def test_truncated_full_returns_none():
    assert wire.parse_packet(full()[:100]) is None


# -- the book flag -------------------------------------------------------

def test_has_book_is_false_when_both_sides_are_zero():
    """A pre-depth packet is 'no book', not 'a market with no bid and no ask'.

    Trade-side classification must treat it as unknown, never as a passive print.
    """
    t = wire.parse_packet(ticker())
    assert not t.has_book
    t2 = wire.parse_packet(full(bid=1.05, ask=1.15))
    assert t2.has_book


# -- many packets in one frame (the TFA difference) ---------------------

def test_reads_every_packet_in_a_frame():
    """The reason this module exists: TFA reads only the first packet per frame.

    Three packets for three different securities must all come out.
    """
    frame = full(sec_id=1) + full(sec_id=2) + full(sec_id=3)
    ticks = list(wire.iter_packets(frame))
    assert [t.security_id for t in ticks] == [1, 2, 3]


def test_reads_mixed_packet_types_in_one_frame():
    frame = ticker(sec_id=10) + oi_packet(sec_id=20) + full(sec_id=30) + quote(sec_id=40)
    ticks = list(wire.iter_packets(frame))
    assert [t.security_id for t in ticks] == [10, 20, 30, 40]
    assert [t.kind for t in ticks] == [
        ResponseCode.TICKER, ResponseCode.OI, ResponseCode.FULL, ResponseCode.QUOTE]


def test_single_packet_frame_still_works():
    ticks = list(wire.iter_packets(full(sec_id=7)))
    assert len(ticks) == 1 and ticks[0].security_id == 7


def test_unknown_code_is_skipped_not_fatal():
    """An unrecognised packet must not stop the packets behind it."""
    unknown = _hdr(99, 16, 2, 5) + b"\x00" * 8
    frame = unknown + full(sec_id=8)
    ticks = list(wire.iter_packets(frame))
    assert [t.security_id for t in ticks] == [8]


def test_market_status_is_skipped():
    frame = _hdr(ResponseCode.MARKET_STATUS, 8, 2, 0) + full(sec_id=9)
    ticks = list(wire.iter_packets(frame))
    assert [t.security_id for t in ticks] == [9]


def test_lying_message_length_cannot_cause_an_infinite_loop():
    """A header claiming length 0 must not stall the walk.

    The packet type's own minimum advances the cursor instead.
    """
    bad = _hdr(ResponseCode.FULL, 0, 2, 1) + full()[8:]
    ticks = list(wire.iter_packets(bad + full(sec_id=2)))
    assert [t.security_id for t in ticks] == [1, 2]


def test_trailing_garbage_shorter_than_a_header_is_ignored():
    frame = full(sec_id=4) + b"\x01\x02\x03"
    ticks = list(wire.iter_packets(frame))
    assert [t.security_id for t in ticks] == [4]


def test_empty_frame_yields_nothing():
    assert list(wire.iter_packets(b"")) == []


# -- disconnect ----------------------------------------------------------

def test_disconnect_804_is_the_one_the_plan_bets_against():
    """804 means a connection was given more instruments than Dhan allows (T192)."""
    buf = _hdr(ResponseCode.DISCONNECT, 10, 0, 0) + struct.pack("<h", 804)
    d = wire.parse_packet(buf)
    assert isinstance(d, Disconnect)
    assert d.code == 804
    assert d.reason == "Instruments exceed limit"


def test_unknown_disconnect_code_still_reports():
    buf = _hdr(ResponseCode.DISCONNECT, 10, 0, 0) + struct.pack("<h", 999)
    d = wire.parse_packet(buf)
    assert d.code == 999 and "999" in d.reason


# -- subscribe messages --------------------------------------------------

def test_subscribe_splits_into_batches_of_100():
    """Dhan accepts at most 100 instruments per message.

    nifty's ~1,500 legs therefore need 15 messages.
    """
    legs = [("NSE_FNO", str(i)) for i in range(1500)]
    msgs = wire.build_subscribe(legs, wire.RequestCode.SUBSCRIBE_FULL)
    assert len(msgs) == 15
    assert all(m["InstrumentCount"] <= 100 for m in msgs)
    assert sum(m["InstrumentCount"] for m in msgs) == 1500
    assert all(m["RequestCode"] == 21 for m in msgs)


def test_subscribe_preserves_every_id_exactly_once():
    legs = [("MCX_COMM", str(i)) for i in range(786)]
    msgs = wire.build_subscribe(legs, wire.RequestCode.SUBSCRIBE_FULL)
    seen = [inst["SecurityId"] for m in msgs for inst in m["InstrumentList"]]
    assert seen == [str(i) for i in range(786)]


def test_subscribe_of_nothing_is_no_messages():
    assert wire.build_subscribe([], wire.RequestCode.SUBSCRIBE_FULL) == []


def test_segment_codes_round_trip():
    for name, code in wire.EXCHANGE_SEGMENT_CODE.items():
        assert wire.EXCHANGE_SEGMENT_NAME[code] == name
    assert wire.EXCHANGE_SEGMENT_CODE["NSE_FNO"] == 2
    assert wire.EXCHANGE_SEGMENT_CODE["MCX_COMM"] == 5
    assert wire.EXCHANGE_SEGMENT_CODE["IDX_I"] == 0
