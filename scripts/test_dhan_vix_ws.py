"""
Standalone test — subscribe India VIX over Dhan WS in different modes
and see which (if any) actually delivers packets.

Usage:
    set DHAN_ACCESS_TOKEN=<jwt>
    set DHAN_CLIENT_ID=1101615161
    python scripts/test_dhan_vix_ws.py

Or pass on the command line:
    python scripts/test_dhan_vix_ws.py --token <jwt> --client-id 1101615161 --mode ticker

Modes:
    ticker  → RequestCode 15  (Dhan's own example for IDX_I uses this)
    quote   → RequestCode 17
    full    → RequestCode 21  (what TFA currently uses — silently fails for VIX)

The script subscribes ONLY India VIX (sec_id 21, segment IDX_I) plus NIFTY-INDEX
(sec_id 13, segment IDX_I) as a control. NIFTY-INDEX is in the same segment as
VIX; if NIFTY-INDEX streams but VIX doesn't, the issue is account entitlement.
If BOTH stream, our TFA's FULL mode is the culprit. If NEITHER streams, IDX_I
subscription needs a different mode or message shape than what we're sending.

Prints every binary packet's parsed header (response_code, segment, sec_id,
message_length) plus the LTP if it can be parsed. No persistence — pure diag.

Stop with Ctrl+C.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import struct
import sys
import time
from datetime import datetime, timezone, timedelta

import websockets

_IST = timezone(timedelta(hours=5, minutes=30))
_DHAN_WS_URL = "wss://api-feed.dhan.co"
_HDR_FMT = struct.Struct("<BhBi")  # uint8 + int16 + uint8 + int32

# Response codes (from Dhan binary header byte 0)
RC_NAMES = {
    1: "INDEX", 2: "TICKER", 4: "QUOTE", 5: "OI", 6: "PREV_CLOSE",
    7: "MARKET_STATUS", 8: "FULL", 50: "DISCONNECT",
}

# Exchange segment numeric codes (Dhan binary header byte 3)
SEG_NAMES = {
    0: "IDX_I", 1: "NSE_EQ", 2: "NSE_FNO", 3: "NSE_CURRENCY",
    4: "BSE_EQ", 5: "MCX_COMM", 7: "BSE_CURRENCY", 8: "BSE_FNO",
}

# RequestCode → human label
MODE_REQUEST_CODE = {
    "ticker": 15,  # SUBSCRIBE_TICKER  — Dhan example for indices
    "quote":  17,  # SUBSCRIBE_QUOTE
    "full":   21,  # SUBSCRIBE_FULL    — what TFA uses today
}

VIX_SEC_ID = "21"           # India VIX (confirmed from Dhan scrip master)
NIFTY_IDX_SEC_ID = "13"     # NIFTY 50 INDEX — control instrument


def _now_ist() -> str:
    return datetime.now(_IST).strftime("%H:%M:%S.%f")[:-3]


def _parse_header(buf: bytes) -> tuple[int, int, int, int]:
    if len(buf) < 8:
        return -1, 0, -1, -1
    rc, msg_len, seg, sec_id = _HDR_FMT.unpack_from(buf, 0)
    return rc, msg_len, seg, sec_id


def _try_parse_ltp(buf: bytes, rc: int) -> float | None:
    """For INDEX (rc=1) and TICKER (rc=2) packets Dhan publishes 4 bytes of
    LTP after the 8-byte header. Other packet shapes return None."""
    if rc in (1, 2) and len(buf) >= 12:
        (ltp,) = struct.unpack_from("<f", buf, 8)
        return ltp
    return None


async def _run(token: str, client_id: str, mode: str) -> None:
    request_code = MODE_REQUEST_CODE[mode]
    url = f"{_DHAN_WS_URL}?version=2&token={token}&clientId={client_id}&authType=2"

    print(f"[{_now_ist()}] Connecting to {_DHAN_WS_URL}")
    print(f"  client_id={client_id}  mode={mode} (RequestCode={request_code})")

    async with websockets.connect(url, open_timeout=15.0, ping_interval=None, ping_timeout=None) as ws:
        print(f"[{_now_ist()}] Connected")

        # Subscribe both VIX and NIFTY-INDEX in IDX_I — same segment, different instruments
        sub_msg = {
            "RequestCode": request_code,
            "InstrumentCount": 2,
            "InstrumentList": [
                {"ExchangeSegment": "IDX_I", "SecurityId": NIFTY_IDX_SEC_ID},
                {"ExchangeSegment": "IDX_I", "SecurityId": VIX_SEC_ID},
            ],
        }
        await ws.send(json.dumps(sub_msg))
        print(f"[{_now_ist()}] Subscribed: {sub_msg}")
        print(f"[{_now_ist()}] Waiting for packets… (Ctrl+C to stop)")
        print()

        # Per-instrument counters
        counts: dict[str, int] = {}
        rc_counts: dict[int, int] = {}
        t_start = time.monotonic()

        async for msg in ws:
            if not isinstance(msg, (bytes, bytearray)):
                # text frames sometimes appear for status; print as-is
                print(f"[{_now_ist()}] TEXT: {msg[:200]!r}")
                continue

            rc, msg_len, seg, sec_id = _parse_header(msg)
            rc_name = RC_NAMES.get(rc, f"?({rc})")
            seg_name = SEG_NAMES.get(seg, f"?({seg})")
            key = f"{seg_name}:{sec_id}"
            counts[key] = counts.get(key, 0) + 1
            rc_counts[rc] = rc_counts.get(rc, 0) + 1

            ltp = _try_parse_ltp(bytes(msg), rc)
            ltp_s = f"  ltp={ltp:.2f}" if ltp is not None else ""
            # Print first 5 of each (seg,sec_id) then go quiet
            if counts[key] <= 5:
                print(
                    f"[{_now_ist()}] rc={rc_name}({rc})  seg={seg_name}({seg})  "
                    f"sec_id={sec_id}  len={msg_len}{ltp_s}"
                )
            elif counts[key] == 6:
                print(f"[{_now_ist()}] (silencing further {key}; summary at end)")

            # Periodic summary every 30s
            if (time.monotonic() - t_start) >= 30 and counts:
                print()
                print(f"[{_now_ist()}] === 30s summary ===")
                print(f"  total packets: {sum(counts.values())}")
                print(f"  per-instrument:")
                for k, c in sorted(counts.items(), key=lambda kv: -kv[1]):
                    print(f"    {k:>12}: {c:>6}")
                print(f"  per-response_code:")
                for c_rc, c in sorted(rc_counts.items(), key=lambda kv: -kv[1]):
                    print(f"    {RC_NAMES.get(c_rc, '?'):>12}({c_rc}): {c:>6}")
                print()
                t_start = time.monotonic()


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--token",
        default=os.environ.get("DHAN_ACCESS_TOKEN"),
        help="Dhan access token (or set DHAN_ACCESS_TOKEN env)",
    )
    p.add_argument(
        "--client-id",
        default=os.environ.get("DHAN_CLIENT_ID"),
        help="Dhan client id (or set DHAN_CLIENT_ID env)",
    )
    p.add_argument(
        "--mode",
        choices=list(MODE_REQUEST_CODE.keys()),
        default="ticker",
        help="Subscription mode (default: ticker — Dhan's example for IDX_I)",
    )
    args = p.parse_args()

    if not args.token or not args.client_id:
        print("ERROR: provide --token and --client-id (or set DHAN_ACCESS_TOKEN + DHAN_CLIENT_ID)")
        return 2

    try:
        asyncio.run(_run(args.token, args.client_id, args.mode))
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
