"""
test_feed.py — Unit tests for binary_parser.py.

Constructs synthetic binary packets using struct.pack and verifies that each
parse function extracts the correct field values from the byte buffer.

Run: python -m pytest python_modules/tick_feature_agent/tests/test_feed.py -v
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pytest
from tick_feature_agent.feed.binary_parser import (
    parse_header,
    parse_ticker_packet,
    parse_quote_packet,
    parse_oi_packet,
    parse_prev_close_packet,
    parse_full_packet,
    parse_depth_levels,
    parse_disconnect_packet,
    dispatch,
    ResponseCode,
    RequestCode,
    EXCHANGE_SEGMENT_CODE,
    EXCHANGE_SEGMENT_NAME,
    PacketHeader,
)


# ── Synthetic buffer builders ──────────────────────────────────────────────────

def _make_header(response_code: int, exchange_segment: int, security_id: int,
                 msg_len: int = 0) -> bytes:
    """Build an 8-byte Dhan WS packet header."""
    return struct.pack("<BhBi", response_code, msg_len, exchange_segment, security_id)


def _make_ticker_buf(response_code: int, exch_seg: int, sec_id: int,
                     ltp: float, ltt: int) -> bytes:
    header = _make_header(response_code, exch_seg, sec_id, 16)
    return header + struct.pack("<fi", ltp, ltt)


def _make_full_buf(
    exch_seg: int = 2,
    sec_id: int = 52175,
    ltp: float = 24000.5,
    ltq: int = 10,
    ltt: int = 1744512000,
    atp: float = 24001.0,
    volume: int = 50000,
    total_sell: int = 20000,
    total_buy: int = 30000,
    oi: int = 150000,
    high_oi: int = 200000,
    low_oi: int = 100000,
    day_open: float = 23900.0,
    day_close: float = 23950.0,
    day_high: float = 24100.0,
    day_low: float = 23800.0,
    bid_price: float = 23999.5,
    ask_price: float = 24001.5,
    bid_qty: int = 100,
    ask_qty: int = 80,
) -> bytes:
    header = _make_header(ResponseCode.FULL, exch_seg, sec_id, 162)
    data = struct.pack(
        "<fhifiiiiiiffff",
        ltp, ltq, ltt, atp, volume, total_sell, total_buy,
        oi, high_oi, low_oi, day_open, day_close, day_high, day_low,
    )
    # Level 0: real bid/ask data
    level0 = struct.pack("<iihh2f", bid_qty, ask_qty, 5, 3, bid_price, ask_price)
    # Levels 1–4: all zeros
    zeros = struct.pack("<iihh2f", 0, 0, 0, 0, 0.0, 0.0) * 4
    return header + data + level0 + zeros


# ══════════════════════════════════════════════════════════════════════════════
# parse_header
# ══════════════════════════════════════════════════════════════════════════════

class TestParseHeader:

    def test_basic_fields(self):
        buf = _make_header(response_code=8, exchange_segment=2, security_id=52175, msg_len=162)
        h = parse_header(buf)
        assert h.response_code == 8
        assert h.exchange_segment == 2
        assert h.security_id == 52175
        assert h.message_length == 162

    def test_exchange_segment_zero(self):
        buf = _make_header(response_code=2, exchange_segment=0, security_id=13)
        h = parse_header(buf)
        assert h.exchange_segment == 0
        assert h.security_id == 13

    def test_buf_too_short_raises(self):
        with pytest.raises(ValueError):
            parse_header(b"\x08\x00\x00")

    def test_response_code_50_disconnect(self):
        buf = _make_header(response_code=50, exchange_segment=0, security_id=0)
        h = parse_header(buf)
        assert h.response_code == ResponseCode.DISCONNECT

    def test_returns_named_tuple(self):
        buf = _make_header(8, 2, 99, 162)
        h = parse_header(buf)
        assert isinstance(h, PacketHeader)
        assert h.response_code == 8


# ══════════════════════════════════════════════════════════════════════════════
# parse_ticker_packet (code 2 / code 1 INDEX)
# ══════════════════════════════════════════════════════════════════════════════

class TestTickerPacket:

    def test_ltp_and_ltt_extracted(self):
        buf = _make_ticker_buf(ResponseCode.TICKER, exch_seg=2, sec_id=52175,
                               ltp=245.5, ltt=1744512345)
        result = parse_ticker_packet(buf)
        assert abs(result["ltp"] - 245.5) < 0.001
        assert result["ltt"] == 1744512345

    def test_recv_ts_present(self):
        buf = _make_ticker_buf(ResponseCode.TICKER, 2, 52175, 100.0, 1000)
        result = parse_ticker_packet(buf)
        assert "recv_ts" in result
        assert result["recv_ts"] > 0

    def test_too_short_raises(self):
        with pytest.raises(ValueError):
            parse_ticker_packet(b"\x02" * 10)

    def test_index_packet_parses_correctly(self):
        buf = _make_ticker_buf(ResponseCode.INDEX, exch_seg=0, sec_id=13,
                               ltp=24150.0, ltt=1000)
        result = parse_ticker_packet(buf)
        assert abs(result["ltp"] - 24150.0) < 0.01

    def test_zero_ltp(self):
        buf = _make_ticker_buf(ResponseCode.TICKER, 2, 52175, 0.0, 0)
        result = parse_ticker_packet(buf)
        assert result["ltp"] == 0.0
        assert result["ltt"] == 0


# ══════════════════════════════════════════════════════════════════════════════
# parse_quote_packet (code 4)
# ══════════════════════════════════════════════════════════════════════════════

class TestQuotePacket:

    def _make_buf(self, **kwargs) -> bytes:
        d = dict(
            ltp=24000.0, ltq=5, ltt=1744512000, atp=24001.0,
            volume=12000, total_sell=5000, total_buy=7000,
            day_open=23900.0, day_close=23950.0, day_high=24100.0, day_low=23800.0,
        )
        d.update(kwargs)
        header = _make_header(ResponseCode.QUOTE, 2, 52175, 50)
        payload = struct.pack(
            "<fhifiiiffff",
            d["ltp"], d["ltq"], d["ltt"], d["atp"],
            d["volume"], d["total_sell"], d["total_buy"],
            d["day_open"], d["day_close"], d["day_high"], d["day_low"],
        )
        return header + payload

    def test_ltp_extracted(self):
        result = parse_quote_packet(self._make_buf(ltp=24050.25))
        assert abs(result["ltp"] - 24050.25) < 0.01

    def test_volume_extracted(self):
        result = parse_quote_packet(self._make_buf(volume=9999))
        assert result["volume"] == 9999

    def test_ohlc_extracted(self):
        result = parse_quote_packet(
            self._make_buf(day_open=100.0, day_high=110.0, day_low=90.0, day_close=105.0)
        )
        assert abs(result["day_open"] - 100.0) < 0.001
        assert abs(result["day_high"] - 110.0) < 0.001
        assert abs(result["day_low"] - 90.0) < 0.001

    def test_too_short_raises(self):
        with pytest.raises(ValueError):
            parse_quote_packet(b"\x00" * 30)


# ══════════════════════════════════════════════════════════════════════════════
# parse_oi_packet (code 5)
# ══════════════════════════════════════════════════════════════════════════════

class TestOIPacket:

    def test_oi_extracted(self):
        header = _make_header(ResponseCode.OI, 2, 52175, 12)
        buf = header + struct.pack("<i", 123456)
        result = parse_oi_packet(buf)
        assert result["oi"] == 123456

    def test_large_oi(self):
        header = _make_header(ResponseCode.OI, 2, 52175, 12)
        buf = header + struct.pack("<i", 9_999_999)
        result = parse_oi_packet(buf)
        assert result["oi"] == 9_999_999

    def test_too_short_raises(self):
        with pytest.raises(ValueError):
            parse_oi_packet(b"\x00" * 10)


# ══════════════════════════════════════════════════════════════════════════════
# parse_prev_close_packet (code 6)
# ══════════════════════════════════════════════════════════════════════════════

class TestPrevClosePacket:

    def test_fields_extracted(self):
        header = _make_header(ResponseCode.PREV_CLOSE, 2, 52175, 16)
        buf = header + struct.pack("<fi", 23500.75, 98765)
        result = parse_prev_close_packet(buf)
        assert abs(result["prev_close"] - 23500.75) < 0.01
        assert result["prev_oi"] == 98765

    def test_too_short_raises(self):
        with pytest.raises(ValueError):
            parse_prev_close_packet(b"\x00" * 12)


# ══════════════════════════════════════════════════════════════════════════════
# parse_full_packet (code 8)
# ══════════════════════════════════════════════════════════════════════════════

class TestFullPacket:

    def test_ltp_extracted(self):
        result = parse_full_packet(_make_full_buf(ltp=24000.5))
        assert abs(result["ltp"] - 24000.5) < 0.01

    def test_oi_extracted(self):
        result = parse_full_packet(_make_full_buf(oi=150000))
        assert result["oi"] == 150000

    def test_bid_ask_from_depth_level_0(self):
        result = parse_full_packet(_make_full_buf(bid_price=23999.5, ask_price=24001.5))
        assert abs(result["bid"] - 23999.5) < 0.01
        assert abs(result["ask"] - 24001.5) < 0.01

    def test_bid_ask_size_from_depth_level_0(self):
        result = parse_full_packet(_make_full_buf(bid_qty=100, ask_qty=80))
        assert result["bid_size"] == 100
        assert result["ask_size"] == 80

    def test_depth_has_5_levels(self):
        result = parse_full_packet(_make_full_buf())
        assert len(result["depth"]) == 5

    def test_ohlc_extracted(self):
        result = parse_full_packet(
            _make_full_buf(day_open=23900.0, day_high=24100.0, day_low=23800.0, day_close=23950.0)
        )
        assert abs(result["day_open"] - 23900.0) < 0.01
        assert abs(result["day_high"] - 24100.0) < 0.01
        assert abs(result["day_low"] - 23800.0) < 0.01
        assert abs(result["day_close"] - 23950.0) < 0.01

    def test_too_short_raises(self):
        with pytest.raises(ValueError):
            parse_full_packet(b"\x08" * 100)

    def test_all_keys_present(self):
        result = parse_full_packet(_make_full_buf())
        expected_keys = (
            "ltp", "ltq", "ltt", "atp", "volume", "total_sell", "total_buy",
            "oi", "high_oi", "low_oi", "day_open", "day_close", "day_high",
            "day_low", "bid", "ask", "bid_size", "ask_size", "depth", "recv_ts",
        )
        for key in expected_keys:
            assert key in result, f"Missing key: {key}"

    def test_recv_ts_present(self):
        result = parse_full_packet(_make_full_buf())
        assert result["recv_ts"] > 0


# ══════════════════════════════════════════════════════════════════════════════
# parse_depth_levels
# ══════════════════════════════════════════════════════════════════════════════

class TestDepthLevels:

    def _make_depth_buf(self, levels: list[tuple]) -> bytes:
        buf = b""
        for bid_qty, ask_qty, bid_orders, ask_orders, bid_price, ask_price in levels:
            buf += struct.pack("<iihh2f", bid_qty, ask_qty, bid_orders, ask_orders,
                               bid_price, ask_price)
        return buf

    def test_single_level(self):
        buf = self._make_depth_buf([(100, 80, 5, 3, 23999.5, 24001.5)])
        levels = parse_depth_levels(buf, 0)
        assert len(levels) == 1
        assert levels[0]["bid_qty"] == 100
        assert levels[0]["ask_qty"] == 80
        assert abs(levels[0]["bid_price"] - 23999.5) < 0.01

    def test_five_levels(self):
        data = [
            (100, 80,  5,  3, 23999.5, 24001.5),
            (200, 150, 8,  6, 23998.0, 24003.0),
            (300, 200, 10, 8, 23996.0, 24005.0),
            (400, 250, 12, 10, 23994.0, 24007.0),
            (500, 300, 15, 12, 23992.0, 24009.0),
        ]
        buf = self._make_depth_buf(data)
        levels = parse_depth_levels(buf, 0)
        assert len(levels) == 5
        assert levels[4]["bid_qty"] == 500
        assert abs(levels[4]["bid_price"] - 23992.0) < 0.01

    def test_offset_applied(self):
        padding = b"\x00" * 10
        level = self._make_depth_buf([(50, 40, 2, 2, 100.0, 101.0)])
        buf = padding + level
        levels = parse_depth_levels(buf, 10)
        assert levels[0]["bid_qty"] == 50
        assert abs(levels[0]["ask_price"] - 101.0) < 0.01


# ══════════════════════════════════════════════════════════════════════════════
# parse_disconnect_packet (code 50)
# ══════════════════════════════════════════════════════════════════════════════

class TestDisconnectPacket:

    def test_known_code_807_access_token_expired(self):
        header = _make_header(ResponseCode.DISCONNECT, 0, 0, 10)
        buf = header + struct.pack("<h", 807)
        result = parse_disconnect_packet(buf)
        assert result["disconnect_code"] == 807
        assert "expired" in result["reason"].lower()

    def test_unknown_code(self):
        header = _make_header(ResponseCode.DISCONNECT, 0, 0, 10)
        buf = header + struct.pack("<h", 999)
        result = parse_disconnect_packet(buf)
        assert result["disconnect_code"] == 999
        assert "Unknown" in result["reason"]

    def test_too_short_defaults_code_zero(self):
        # 8 bytes header only — no code bytes
        buf = _make_header(ResponseCode.DISCONNECT, 0, 0, 8)
        result = parse_disconnect_packet(buf)
        assert result["disconnect_code"] == 0


# ══════════════════════════════════════════════════════════════════════════════
# dispatch
# ══════════════════════════════════════════════════════════════════════════════

class TestDispatch:

    def test_dispatch_ticker_code_2(self):
        buf = _make_ticker_buf(ResponseCode.TICKER, exch_seg=2, sec_id=52175,
                               ltp=245.5, ltt=1000)
        header, payload = dispatch(buf)
        assert header.response_code == ResponseCode.TICKER
        assert payload is not None
        assert abs(payload["ltp"] - 245.5) < 0.01

    def test_dispatch_index_code_1(self):
        buf = _make_ticker_buf(ResponseCode.INDEX, exch_seg=0, sec_id=13,
                               ltp=24150.0, ltt=2000)
        header, payload = dispatch(buf)
        assert header.response_code == ResponseCode.INDEX
        assert payload is not None

    def test_dispatch_full_code_8(self):
        buf = _make_full_buf(exch_seg=2, sec_id=52175)
        header, payload = dispatch(buf)
        assert header.response_code == ResponseCode.FULL
        assert payload is not None
        assert "bid" in payload
        assert "ask" in payload

    def test_dispatch_oi_code_5(self):
        header = _make_header(ResponseCode.OI, 2, 52175, 12)
        buf = header + struct.pack("<i", 999999)
        _, payload = dispatch(buf)
        assert payload is not None
        assert payload["oi"] == 999999

    def test_dispatch_prev_close_code_6(self):
        header = _make_header(ResponseCode.PREV_CLOSE, 2, 52175, 16)
        buf = header + struct.pack("<fi", 23000.0, 77777)
        _, payload = dispatch(buf)
        assert payload is not None
        assert payload["prev_oi"] == 77777

    def test_dispatch_market_status_returns_none_payload(self):
        buf = _make_header(ResponseCode.MARKET_STATUS, 0, 0, 8)
        buf += b"\x00" * 8
        header, payload = dispatch(buf)
        assert header.response_code == ResponseCode.MARKET_STATUS
        assert payload is None

    def test_dispatch_unknown_code_returns_none_payload(self):
        buf = _make_header(99, 0, 0, 8)
        buf += b"\x00" * 8
        _, payload = dispatch(buf)
        assert payload is None

    def test_dispatch_buf_too_short_returns_empty_header(self):
        header, payload = dispatch(b"\x08\x00\x00")
        assert header.response_code == 0
        assert payload is None

    def test_dispatch_matches_direct_parser(self):
        """dispatch returns the same result as calling the parser directly."""
        buf = _make_ticker_buf(ResponseCode.TICKER, 2, 52175, 100.0, 500)
        _, via_dispatch = dispatch(buf)
        direct = parse_ticker_packet(buf)
        assert abs(via_dispatch["ltp"] - direct["ltp"]) < 0.001
        assert via_dispatch["ltt"] == direct["ltt"]

    def test_dispatch_corrupt_packet_returns_none_payload(self):
        """A parseable header followed by too-short payload returns None gracefully."""
        # Header says FULL (162 bytes) but buffer is only 20 bytes
        buf = _make_header(ResponseCode.FULL, 2, 52175, 162)
        buf += b"\x00" * 12   # far too short for a Full packet
        _, payload = dispatch(buf)
        assert payload is None


# ══════════════════════════════════════════════════════════════════════════════
# Exchange segment maps
# ══════════════════════════════════════════════════════════════════════════════

class TestExchangeSegmentMaps:

    def test_name_map_has_expected_segments(self):
        assert EXCHANGE_SEGMENT_NAME[0] == "IDX_I"
        assert EXCHANGE_SEGMENT_NAME[2] == "NSE_FNO"
        assert EXCHANGE_SEGMENT_NAME[5] == "MCX_COMM"

    def test_code_map_is_inverse_of_name_map(self):
        for code, name in EXCHANGE_SEGMENT_NAME.items():
            assert EXCHANGE_SEGMENT_CODE[name] == code

    def test_full_packet_header_carries_nse_fno_segment(self):
        buf = _make_full_buf(exch_seg=2, sec_id=52175)
        header, _ = dispatch(buf)
        assert EXCHANGE_SEGMENT_NAME[header.exchange_segment] == "NSE_FNO"
