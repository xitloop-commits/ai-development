"""TCS2 - print exactly which contracts each process would subscribe today.

Spec: docs/systems/14_tcs2.md

This is the Phase 0 acceptance check: it is done when the leg counts land inside
config.EXPECTED_LEGS and the expiry choice matches D19 - three chains for nifty,
two for everything else, current + next futures always.

    python -m tcs2.resolve_cli                 # all four, today
    python -m tcs2.resolve_cli --save          # also write the D22 audit files
    python -m tcs2.resolve_cli --date 2026-09-29
    python -m tcs2.resolve_cli --refresh       # force a scrip master download
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys

from . import config as cfg
from . import scrip


def _fmt(n: int) -> str:
    return f"{n:,}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Resolve TCS2 contracts for a day")
    ap.add_argument("--date", help="YYYY-MM-DD, default today")
    ap.add_argument("--save", action="store_true", help="write the resolved leg lists")
    ap.add_argument("--refresh", action="store_true", help="force scrip master download")
    ap.add_argument("--instrument", choices=cfg.INSTRUMENTS, help="just one")
    args = ap.parse_args(argv)

    on = dt.date.fromisoformat(args.date) if args.date else dt.date.today()
    path = scrip.ensure_master(force=args.refresh)
    age = scrip.cache_age_hours(path)
    print(f"scrip master: {path}  ({path.stat().st_size / 1e6:.1f} MB, "
          f"{age:.1f}h old)" if age is not None else f"scrip master: {path}")
    print(f"trade date:   {on}\n")

    names = [args.instrument] if args.instrument else list(cfg.INSTRUMENTS)
    total = 0
    failures = 0

    for name in names:
        cap = cfg.CAPABILITIES[name]
        try:
            r = scrip.resolve(name, on=on, path=path)
        except scrip.ScripError as e:
            print(f"{name:11s} FAILED: {e}")
            failures += 1
            continue

        lo, hi = cfg.EXPECTED_LEGS[name]
        ok = lo <= r.total_legs <= hi
        flag = "ok" if ok else f"OUT OF RANGE (expected {_fmt(lo)}-{_fmt(hi)})"
        if not ok:
            failures += 1
        total += r.total_legs

        print(f"{name}  [{cap.exchange}]  {_fmt(r.total_legs)} legs  {flag}")
        print(f"   option expiries ({len(r.option_expiries)} of "
              f"{cap.option_expiries} wanted):")
        for e in r.option_expiries:
            legs = [c for c in r.options if c.expiry == e]
            ce = sum(1 for c in legs if c.option_type == "CE")
            pe = sum(1 for c in legs if c.option_type == "PE")
            flags = sorted({c.expiry_flag for c in legs})
            strikes = sorted({c.strike for c in legs})
            span = f"{strikes[0]:,.0f}-{strikes[-1]:,.0f}" if strikes else "-"
            dte = (dt.date.fromisoformat(e) - on).days
            print(f"      {e}  {dte:>3}d  flag={','.join(flags):3s}  "
                  f"{len(strikes):>3} strikes  {ce:>4} CE + {pe:>4} PE  [{span}]")
        print("   futures:")
        for c in r.futures:
            dte = (dt.date.fromisoformat(c.expiry) - on).days if c.expiry else 0
            print(f"      {c.security_id:>8}  {c.display_name:<28} exp {c.expiry} ({dte}d)")
        print(f"   index: {(r.index.display_name + ' / ' + r.index.security_id) if r.index else 'NONE (futures is the underlying)'}")
        print(f"   vix:   {(r.vix.display_name + ' / ' + r.vix.security_id) if r.vix else 'NONE (no MCX equivalent)'}")

        msgs = -(-r.total_legs // cfg.MAX_INSTRUMENTS_PER_MSG)
        conns = -(-r.total_legs // cfg.MAX_INSTRUMENTS_PER_CONN)
        headroom = cfg.MAX_INSTRUMENTS_PER_CONN / max(1, r.total_legs)
        print(f"   subscribe: {msgs} messages of <={cfg.MAX_INSTRUMENTS_PER_MSG}, "
              f"{conns} connection ({headroom:.1f}x headroom)")
        if conns > cfg.MAX_CONNECTIONS_PER_PROCESS:
            print(f"   *** D13 VIOLATION: needs {conns} connections ***")
            failures += 1

        if args.save:
            print(f"   saved: {scrip.save_resolved(r)}")
        print()

    print(f"TOTAL {_fmt(total)} legs across {len(names)} processes "
          f"({len(names)} of 5 Dhan connections)")
    if failures:
        print(f"\n{failures} check(s) failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
