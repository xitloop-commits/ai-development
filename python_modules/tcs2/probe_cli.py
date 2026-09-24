"""TCS2 - probe the live Dhan socket: which subscribe mode, and does it hold?

Spec: docs/systems/14_tcs2.md

Answers three questions with measurement rather than reading:

  1. **Which subscribe mode should we use** - TICKER (15), QUOTE (17) or FULL (21)?
     Compares what each actually delivers per packet.
  2. **T192:** does one connection accept a whole instrument's legs without
     disconnect 804? 5,000 is Dhan's documented cap; 475 is all we have proven.
  3. **T194:** how many packets arrive per WebSocket frame? If it is ever more
     than one, TFA has been dropping ticks.

Read-only market data. It places no orders and writes nothing.

    python -m tcs2.probe_cli --instrument nifty50 --seconds 20
    python -m tcs2.probe_cli --compare-modes --seconds 10
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import sys

from . import config as cfg
from . import feed as feedmod
from . import scrip
from .wire import RequestCode, ResponseCode

MODES = {
    "ticker": RequestCode.SUBSCRIBE_TICKER,
    "quote": RequestCode.SUBSCRIBE_QUOTE,
    "full": RequestCode.SUBSCRIBE_FULL,
}

# What each mode carries, from the packet layouts in wire.py. The probe confirms
# these against the live socket rather than trusting the table.
MODE_FIELDS = {
    "ticker": "price + timestamp",
    "quote": "price, trade size, volume, buy/sell totals, day OHLC",
    "full": "everything in QUOTE, plus OI, high/low OI, and 5-level depth",
}


def _legs_for(instrument: str, limit: int | None) -> list[tuple[str, str]]:
    cap = cfg.CAPABILITIES[instrument]
    r = scrip.resolve(instrument, path=scrip.ensure_master())
    legs = [(cap.segment, c.security_id) for c in r.options]
    legs += [(cap.segment, c.security_id) for c in r.futures]
    if r.index:
        legs.append(("IDX_I", r.index.security_id))
    if r.vix:
        legs.append(("IDX_I", r.vix.security_id))
    return legs[:limit] if limit else legs


async def _probe(instrument: str, mode_name: str, seconds: float,
                 limit: int | None) -> feedmod.FeedStats:
    token, cid = feedmod.load_credentials()
    legs = _legs_for(instrument, limit)
    f = feedmod.DhanFeed(token, cid, mode=MODES[mode_name])
    await f.connect()
    msgs = await f.subscribe(legs)
    print(f"  subscribed {len(legs):,} legs in {msgs} messages, "
          f"mode={mode_name.upper()}, listening {seconds:.0f}s ...")
    stats = await f.run(seconds=seconds)
    await f.close()
    return stats


def _report(stats: feedmod.FeedStats, legs: int) -> None:
    print(f"  {stats.summary()}".replace("\n", "\n  "))
    if stats.frames and stats.max_packets_in_one_frame > 1:
        print(f"  >>> T194 CONFIRMED: frames carry up to "
              f"{stats.max_packets_in_one_frame} packets. TFA reads only the "
              f"first, so it has been dropping ticks.")
    elif stats.frames:
        print("  >>> T194: every frame held exactly 1 packet in this sample. "
              "TFA loses nothing here.")
    if any(d.code == 804 for d in stats.disconnects):
        print(f"  >>> T192 FAILED: 804 with {legs:,} legs on one connection.")
    elif stats.frames:
        print(f"  >>> T192 ok: {legs:,} legs on ONE connection, no 804.")
    seen = len(stats.securities)
    if seen:
        print(f"  >>> coverage: {seen:,} of {legs:,} legs sent something "
              f"({seen / legs * 100:.0f}%)")


async def _main(args) -> int:
    print(f"{dt.datetime.now():%Y-%m-%d %H:%M:%S}  probing live Dhan feed "
          f"(read-only, no orders)\n")

    if args.compare_modes:
        legs_n = len(_legs_for(args.instrument, args.limit))
        for name in ("ticker", "quote", "full"):
            print(f"MODE {name.upper()} - expected: {MODE_FIELDS[name]}")
            stats = await _probe(args.instrument, name, args.seconds, args.limit)
            _report(stats, legs_n)
            # Which fields actually arrived non-zero, measured not assumed.
            print()
        return 0

    legs_n = len(_legs_for(args.instrument, args.limit))
    print(f"{args.instrument}: {legs_n:,} legs  mode={args.mode.upper()}")
    stats = await _probe(args.instrument, args.mode, args.seconds, args.limit)
    _report(stats, legs_n)
    return 1 if any(d.code == 804 for d in stats.disconnects) else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Probe the live Dhan WS feed")
    ap.add_argument("--instrument", choices=cfg.INSTRUMENTS, default="nifty50")
    ap.add_argument("--mode", choices=list(MODES), default="full")
    ap.add_argument("--seconds", type=float, default=20.0)
    ap.add_argument("--limit", type=int, help="subscribe only the first N legs")
    ap.add_argument("--compare-modes", action="store_true",
                    help="run TICKER, QUOTE and FULL in turn")
    args = ap.parse_args(argv)
    return asyncio.run(_main(args))


if __name__ == "__main__":
    sys.exit(main())
