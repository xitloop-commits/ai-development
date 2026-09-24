"""TCS2 - build the option chain live from ticks and print it.

Spec: docs/systems/14_tcs2.md  (D12, D21, D25, D38)

This is the end-to-end check for phase 2: connect, subscribe the whole chain,
let ticks build it, compute IV and the Greeks, and print the result so it can be
read against the broker's own option chain. The D38 screen is this, in a window.

    python -m tcs2.chain_cli --instrument nifty50 --seconds 20
    python -m tcs2.chain_cli --instrument crudeoil --around 10
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import sys

import numpy as np

from . import config as cfg
from . import feed as feedmod
from . import scrip
from .chain import Chain
from .wire import RequestCode


def _fmt(v: float, width: int = 9, places: int = 2) -> str:
    """Blank, never 0, when we have no answer (D38)."""
    if v is None or (isinstance(v, float) and (np.isnan(v) or v == 0.0)):
        return " " * width
    return f"{v:>{width}.{places}f}"


def _oi(v: int, width: int = 10) -> str:
    if not v:
        return " " * width
    if abs(v) >= 100_000:
        return f"{v / 100_000:>{width - 1},.1f}L"
    return f"{v:>{width},}"


async def _run(args) -> int:
    token, cid = feedmod.load_credentials()
    resolved = scrip.resolve(args.instrument, path=scrip.ensure_master())
    cap = cfg.CAPABILITIES[args.instrument]
    chain = Chain(resolved)

    legs = [(cap.segment, c.security_id) for c in resolved.options]
    legs += [(cap.segment, c.security_id) for c in resolved.futures]
    if resolved.index:
        legs.append(("IDX_I", resolved.index.security_id))
    if resolved.vix:
        legs.append(("IDX_I", resolved.vix.security_id))

    f = feedmod.DhanFeed(token, cid, on_tick=chain.on_tick,
                         mode=RequestCode.SUBSCRIBE_FULL)
    await f.connect()
    msgs = await f.subscribe(legs)
    print(f"{dt.datetime.now():%Y-%m-%d %H:%M:%S}  {args.instrument}: "
          f"{len(legs):,} legs in {msgs} messages, collecting {args.seconds:.0f}s ...")
    await f.run(seconds=args.seconds)
    await f.close()

    took = chain.refresh_analytics()
    print(f"\nfeed: {f.stats.frames:,} frames, {f.stats.ticks:,} ticks, "
          f"{len(f.stats.securities):,} securities")
    print(f"chain: {chain.ticks_applied:,} applied, {chain.unknown_ticks:,} unknown, "
          f"IV + Greeks in {took * 1000:.1f} ms")
    print(f"spot {chain.spot:,.2f}   vix {chain.vix or float('nan'):.2f}   "
          f"futures {list(chain.futures.values())}")

    for expiry in chain.expiries:
        s = chain.summary(expiry)
        print(f"\n{'=' * 104}")
        print(f"EXPIRY {expiry}   {s.days_to_expiry:.2f} days   "
              f"forward {chain.forward.get(expiry, 0):,.2f}   "
              f"basis {s.basis:+,.2f}   legs ticked {s.legs_seen:,}")
        print(f"  PCR(OI) {s.pcr_oi:.2f}   PCR(vol) {s.pcr_volume:.2f}   "
              f"max pain {s.max_pain:,.0f}   ATM {s.atm_strike:,.0f}   "
              f"straddle {s.atm_straddle:,.2f}   ATM IV {s.atm_iv * 100:.2f}%")
        print(f"  call wall {s.call_wall_strike:,.0f} ({_oi(s.call_wall_oi).strip()})"
              f"   put wall {s.put_wall_strike:,.0f} ({_oi(s.put_wall_oi).strip()})")

        rows = chain.rows(expiry)
        if args.around and s.atm_strike:
            rows = [r for r in rows
                    if abs(r["strike"] - s.atm_strike)
                    <= args.around * cap.strike_step]
        print(f"\n{'--- CALLS ---':>52}          {'--- PUTS ---':<52}")
        print(f"{'OI':>10}{'chg':>9}{'vol':>9}{'IV%':>7}{'delta':>7}{'LTP':>9}"
              f"  {'STRIKE':^9}  "
              f"{'LTP':<9}{'delta':<7}{'IV%':<7}{'vol':<9}{'chg':<9}{'OI':<10}")
        for r in rows:
            c = r.get("call", {})
            p = r.get("put", {})
            atm = "*" if r["strike"] == s.atm_strike else " "
            print(
                f"{_oi(c.get('oi', 0))}{_oi(c.get('oi_change', 0), 9)}"
                f"{_oi(c.get('volume', 0), 9)}"
                f"{_fmt((c.get('iv') or float('nan')) * 100, 7)}"
                f"{_fmt(c.get('delta'), 7)}{_fmt(c.get('ltp'), 9)}"
                f"  {atm}{r['strike']:>8,.0f}  "
                f"{_fmt(p.get('ltp'), 9)}{_fmt(p.get('delta'), 7)}"
                f"{_fmt((p.get('iv') or float('nan')) * 100, 7)}"
                f"{_oi(p.get('volume', 0), 9)}{_oi(p.get('oi_change', 0), 9)}"
                f"{_oi(p.get('oi', 0))}")

    changes = chain.drain_oi_changes()
    print(f"\nintraday OI rows captured: {len(changes):,}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build and print the chain from ticks")
    ap.add_argument("--instrument", choices=cfg.INSTRUMENTS, default="nifty50")
    ap.add_argument("--seconds", type=float, default=20.0)
    ap.add_argument("--around", type=int, default=8,
                    help="show only N strikes each side of ATM (0 = all)")
    return asyncio.run(_run(ap.parse_args(argv)))


if __name__ == "__main__":
    sys.exit(main())
