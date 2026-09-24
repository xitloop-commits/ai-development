"""TCS2 - where TCS2 DIFFERS from TFA, and why.

Spec: docs/systems/14_tcs2.md  D27, D42

**TFA is not an oracle.** This file is a difference detector, not a correctness
proof. A disagreement here means "go and find out which is right", never "TCS2 is
wrong" - TFA has already been shown wrong once, in T195, where it labels a
bookless packet as a passive trade while its own docstring calls it missing data.

TCS2's correctness comes from the spec, from Dhan, and from measurement:

  * the packet layouts are confirmed against the LIVE socket - measured
    bytes-per-packet matched the documented layouts exactly in all three
    subscribe modes on 2026-09-25 (D36)
  * the segment codes and the 100-per-message batch size are confirmed by
    1,500 legs subscribing successfully on one connection (D37)
  * trade-side classification is Lee-Ready, a published rule, not TFA's invention
  * the option maths is confirmed by put-call parity recovering the futures price
    to within 0.3 points (D40)

This is the ONLY place in TCS2 that may import tick_feature_agent, and only as a
test.
"""
from __future__ import annotations

import struct

import pytest

from tcs2 import wire

# Test-only import. Never do this from a TCS2 runtime module (D27).
tfa = pytest.importorskip("tick_feature_agent.feed.binary_parser")


def _hdr(code: int, length: int, seg: int, sid: int) -> bytes:
    return struct.pack("<BhBi", code, length, seg, sid)


def _full_body() -> bytes:
    return struct.pack(
        "<fhifiiiiiiffff",
        1.10, 130, 1790068500, 1.30, 131235, 163670, 1154140,
        2679560, 2680060, 2679060,
        1.5, 2.95, 1.5, 1.1)


def _depth_bytes() -> bytes:
    out = b""
    for i in range(5):
        out += struct.pack("<iihh2f", 19045 - i, 17095 - i, 12, 9,
                           1.05 - i * 0.05, 1.15 + i * 0.05)
    return out


def _full(sec_id: int = 56908) -> bytes:
    return _hdr(8, 162, 2, sec_id) + _full_body() + _depth_bytes()


FULL_FIELDS = [
    "ltp", "ltq", "ltt", "atp", "volume", "total_buy", "total_sell",
    "oi", "high_oi", "low_oi",
    "day_open", "day_high", "day_low", "day_close",
    "bid", "ask", "bid_size", "ask_size",
]


def test_full_packet_fields_match_tfa():
    """Both read the same documented layout, so a mismatch means one has a bug.

    Which one would need finding out - the live socket is the arbiter, and it
    already confirmed our layout byte-for-byte (D36).
    """
    pkt = _full()
    ours = wire.parse_packet(pkt)
    theirs = tfa.parse_full_packet(pkt)
    for f in FULL_FIELDS:
        assert getattr(ours, f) == pytest.approx(theirs[f]), f


def test_full_packet_depth_levels_match_tfa():
    pkt = _full()
    ours = wire.parse_packet(pkt)
    theirs = tfa.parse_full_packet(pkt)
    assert len(ours.depth) == len(theirs["depth"]) == 5
    for i, (o, t) in enumerate(zip(ours.depth, theirs["depth"])):
        assert o.bid_qty == t["bid_qty"], i
        assert o.ask_qty == t["ask_qty"], i
        assert o.bid_orders == t["bid_orders"], i
        assert o.ask_orders == t["ask_orders"], i
        assert o.bid_price == pytest.approx(t["bid_price"]), i
        assert o.ask_price == pytest.approx(t["ask_price"]), i


def test_header_matches_tfa():
    pkt = _full(sec_id=68407)
    ours = wire.parse_header(pkt)
    theirs = tfa.parse_header(pkt)
    assert ours.response_code == theirs.response_code
    assert ours.message_length == theirs.message_length
    assert ours.exchange_segment == theirs.exchange_segment
    assert ours.security_id == theirs.security_id


def test_ticker_and_oi_match_tfa():
    tick = _hdr(2, 16, 2, 111) + struct.pack("<fi", 23476.25, 1790000000)
    assert wire.parse_packet(tick).ltp == pytest.approx(
        tfa.parse_ticker_packet(tick)["ltp"])

    oi = _hdr(5, 12, 2, 222) + struct.pack("<i", 5_696_000)
    assert wire.parse_packet(oi).oi == tfa.parse_oi_packet(oi)["oi"]


def test_disconnect_reason_table_matches_tfa():
    assert wire.DISCONNECT_REASON == tfa.DISCONNECT_REASON


def test_segment_tables_match_tfa():
    assert wire.EXCHANGE_SEGMENT_NAME == tfa.EXCHANGE_SEGMENT_NAME


def test_deliberate_difference_multi_packet_frames():
    """The one intentional divergence - do not 'fix' this test.

    A frame holding three packets: TFA surfaces the first and drops two, TCS2
    surfaces all three. See T194.
    """
    frame = _full(sec_id=1) + _full(sec_id=2) + _full(sec_id=3)

    ours = [t.security_id for t in wire.iter_packets(frame)]
    assert ours == [1, 2, 3]

    header, _ = tfa.dispatch(frame)
    assert header.security_id == 1, "TFA reads only the first packet in a frame"


# -- trade-side classification (D27) ------------------------------------

ofi = pytest.importorskip("tick_feature_agent.features.ofi")


@pytest.mark.parametrize("ltp,bid,ask", [
    (101.0, 99.0, 101.0),        # exactly at the offer
    (102.0, 99.0, 101.0),        # through the offer
    (99.0, 99.0, 101.0),         # exactly at the bid
    (98.0, 99.0, 101.0),         # through the bid
    (100.0, 99.0, 101.0),        # inside the spread
    (100.0, 100.0, 100.0),       # zero spread
    (0.05, 0.05, 0.10),          # a near-worthless leg
    (56000.0, 55990.0, 56010.0),  # a large-priced instrument
])
def test_classify_matches_tfa_wherever_a_book_exists(ltp, bid, ask):
    """Both implement Lee-Ready, a published rule - so both should agree.

    Agreement here is a sanity check on two independent transcriptions of the
    same published rule, not evidence that either is correct.
    """
    from tcs2 import flow
    ours = flow.classify(ltp, bid, ask)
    theirs = ofi._trade_direction(ltp, bid, ask)
    assert float(ours) == theirs


def test_deliberate_difference_a_missing_book_is_not_passive():
    """The second intentional divergence - do not 'fix' this test.

    Both reference implementations SAY a bookless packet is missing data, and
    both then RETURN their passive value:

      * `tick_feature_agent/features/ofi.py` - docstring "treated as missing",
        returns 0.0, which is also its passive value
      * `claude_cohort/flow.py:64` - comment "no book, not a passive trade",
        returns PASSIVE

    Downstream that makes "we could not tell" indistinguishable from "neither
    side was aggressive", so bookless prints are silently counted in the passive
    share and dilute the buy and sell shares. TCS2 returns UNKNOWN and excludes
    them. See T195.
    """
    from tcs2 import flow
    assert flow.classify(100.0, 0.0, 0.0) == flow.UNKNOWN
    assert flow.UNKNOWN != flow.PASSIVE
    assert ofi._trade_direction(100.0, 0.0, 0.0) == 0.0    # their passive value
