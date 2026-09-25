"""TCS2 - validate every value the screen shows.

Spec: docs/systems/14_tcs2.md  D38

    python -m tcs2.validate_cli --instrument nifty50
    python -m tcs2.validate_cli --instrument nifty50 --seconds 60
    python -m tcs2.validate_cli --instrument crudeoil --self-only

Connects, builds the chain from ticks exactly as the screen does, then checks
every displayed value two ways: recomputed from the same data, and against Dhan's
own option chain - the one independent opinion available.

It opens its own Dhan connection, so it uses a slot. With four instruments
running that is the fifth and last. Run it against one instrument at a time.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from . import config as cfg
from . import feed as feedmod
from . import validate as v
from .runtime import InstrumentRuntime
from .wire import RequestCode


async def _collect(rt: InstrumentRuntime, seconds: float) -> None:
    token, cid = feedmod.load_credentials()
    f = feedmod.DhanFeed(token, cid, on_tick=rt._on_tick,
                         mode=RequestCode.SUBSCRIBE_FULL)
    await f.connect()
    await f.subscribe(rt._full_legs(), RequestCode.SUBSCRIBE_FULL)
    quote = rt._quote_legs()
    if quote:
        await f.subscribe(quote, RequestCode.SUBSCRIBE_QUOTE)
    await f.run(seconds=seconds)
    await f.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Validate the screen's values")
    ap.add_argument("--instrument", choices=cfg.INSTRUMENTS, default="nifty50")
    ap.add_argument("--seconds", type=float, default=45.0,
                    help="how long to collect ticks before checking")
    ap.add_argument("--expiry", help="default: the nearest watched expiry")
    ap.add_argument("--band", type=int, default=6,
                    help="strikes each side of ATM to compare against Dhan")
    ap.add_argument("--self-only", action="store_true",
                    help="skip the Dhan comparison")
    args = ap.parse_args(argv)

    # record=False: a validation run must not append to the day's recording.
    rt = InstrumentRuntime(args.instrument, record=False, store=None)
    print(f"{args.instrument}: collecting {args.seconds:.0f}s of ticks ...")
    asyncio.run(_collect(rt, args.seconds))
    rt.publish()

    ch = rt.chain
    expiry = args.expiry or (ch.expiries[0] if ch.expiries else "")
    print(f"legs ticked {int((ch.tick_count > 0).sum()):,}   "
          f"spot {ch.spot:,.2f}   futures {sorted(ch.futures.values())}   "
          f"forward {ch.forward.get(expiry, 0):,.2f}")
    print()

    rep = v.Report()
    print(f"--- recomputed from the same data ({expiry}) ---")
    v.check_self(ch, expiry, rep)
    fut = rt.chain._futures_ids[0] if rt.chain._futures_ids else None
    v.check_flow(rt.flow.get(fut), rep)
    for c in rep.checks:
        print("  " + c.line())

    if not args.self_only and args.instrument in v.CHAIN_UNDERLYING:
        print()
        print("--- against Dhan's own option chain (the referee) ---")
        token, cid = feedmod.load_credentials()
        before = len(rep.checks)
        try:
            dhan = v.fetch_dhan_chain(args.instrument, expiry, token, cid)
            v.check_against_dhan(ch, expiry, dhan, band=args.band, report=rep)
        except Exception as exc:                       # noqa: BLE001
            rep.skip("dhan", f"{type(exc).__name__}: {exc}")
        for c in rep.checks[before:]:
            print("  " + c.line())
    elif args.instrument not in v.CHAIN_UNDERLYING:
        rep.skip("dhan", f"no chain endpoint underlying known for "
                         f"{args.instrument} (MCX)")

    print()
    if rep.skipped:
        for s in rep.skipped:
            print(f"  skipped - {s}")
    print(f"  {rep.summary()}")
    if rep.failures:
        print()
        print("  FAILED:")
        for c in rep.failures:
            print(f"    {c.line()}")
    return 1 if rep.failures else 0


if __name__ == "__main__":
    sys.exit(main())
