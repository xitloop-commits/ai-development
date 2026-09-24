"""TCS2 - the instrument process entry point.

Spec: docs/systems/14_tcs2.md

    python -m tcs2 nifty50

One process per instrument (D9), one connection each (D13), sharing nothing
(D14), with the screen inside the process (D16).
"""
from __future__ import annotations

import argparse
import sys

from . import config as cfg


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tcs2",
                                 description="Run one TCS2 instrument process")
    ap.add_argument("instrument", choices=cfg.INSTRUMENTS)
    ap.add_argument("--no-screen", action="store_true",
                    help="run headless and print health to the terminal")
    args = ap.parse_args(argv)

    if args.no_screen:
        import time

        from .runtime import InstrumentRuntime
        rt = InstrumentRuntime(args.instrument)
        rt.start()
        try:
            while rt.running:
                time.sleep(5)
                print(rt.health.summary())
        except KeyboardInterrupt:
            pass
        finally:
            rt.stop()
        return 0

    from .screen import run
    run(args.instrument)
    return 0


if __name__ == "__main__":
    sys.exit(main())
