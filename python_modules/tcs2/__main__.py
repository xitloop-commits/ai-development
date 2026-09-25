"""TCS2 - the instrument process entry point.

Spec: docs/systems/14_tcs2.md

    python -m tcs2 nifty50

One process per instrument (D9), one connection each (D13), sharing nothing
(D14), with the screen inside the process (D16).
"""
from __future__ import annotations

import argparse
import signal
import sys
import threading

from . import config as cfg
from .single import (AlreadyRunning, InstrumentLock, clear_stop,
                     stop_requested)

# Set when a stop signal arrives. Checked by the headless loop and used to close
# the window in screen mode.
_STOPPING = threading.Event()


def _install_signal_handlers() -> None:
    """Turn a stop signal into a graceful shutdown.

    D18 has scheduled tasks starting these processes, so something will
    eventually stop them - and a hard kill loses the open recording chunk and
    leaves the lock behind. A graceful stop seals the chunk, drains the write
    queue and releases the lock.

    SIGBREAK is included because on Windows that is what a console stop sends.
    """
    def handle(_signum, _frame):
        _STOPPING.set()

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, handle)
            except (ValueError, OSError):
                pass        # not the main thread, or unsupported on this platform


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tcs2",
                                 description="Run one TCS2 instrument process")
    ap.add_argument("instrument", choices=cfg.INSTRUMENTS)
    ap.add_argument("--no-screen", action="store_true",
                    help="run headless and print health to the terminal")
    ap.add_argument("--stop", action="store_true",
                    help="ask a running process for this instrument to stop")
    ap.add_argument("--no-store", action="store_true",
                    help="run without the database tiers (ticks are still recorded)")
    args = ap.parse_args(argv)

    if args.stop:
        from .single import request_stop
        print(f"stop requested: {request_stop(args.instrument)}")
        return 0

    # One process per instrument (D14). Two would interleave writes into the
    # same recording and take two of the five Dhan connection slots.
    lock = InstrumentLock(args.instrument)
    try:
        lock.acquire()
    except AlreadyRunning as exc:
        print(f"refusing to start: {exc}", file=sys.stderr)
        return 2

    try:
        return _run(args)
    finally:
        lock.release()


def _run(args) -> int:
    _install_signal_handlers()
    # A request left behind by the last shutdown would stop this one instantly.
    clear_stop(args.instrument)

    def watch_for_stop() -> None:
        while not _STOPPING.wait(timeout=1.0):
            if stop_requested(args.instrument):
                _STOPPING.set()
                return

    threading.Thread(target=watch_for_stop, name="tcs2-stop-watch",
                     daemon=True).start()

    store = None
    if not args.no_store:
        try:
            from .store import Store
            store = Store()
            store.ensure_collections()
        except Exception as exc:                      # noqa: BLE001
            # Never block the feed on the database. Ticks reach disk regardless,
            # and every tier is rebuildable from them.
            print(f"database unavailable, continuing without it: {exc}",
                  file=sys.stderr)

    if args.no_screen:
        from .runtime import InstrumentRuntime
        rt = InstrumentRuntime(args.instrument, store=store)
        rt.start()
        try:
            while rt.running and not _STOPPING.is_set():
                # Waiting on the event rather than sleeping means a stop signal
                # is acted on at once instead of up to five seconds later.
                if _STOPPING.wait(timeout=5.0):
                    break
                print(rt.health.summary(), flush=True)
        except KeyboardInterrupt:
            pass
        finally:
            print("stopping: sealing the recording ...", flush=True)
            rt.stop()
            print(rt.health.summary(), flush=True)
        return 0

    from .screen import run
    run(args.instrument, stopping=_STOPPING, store=store)
    return 0


def _log_crash(instrument: str, exc: BaseException) -> None:
    """Write a startup failure to disk.

    Necessary because the screen runs under `pythonw.exe`, which has no console
    and **discards stdout and stderr entirely** - so shell redirection cannot
    capture anything and a crash would otherwise be completely silent. The
    process has to record its own death.
    """
    import datetime
    import traceback
    try:
        d = cfg.LOGS_DIR
        d.mkdir(parents=True, exist_ok=True)
        with open(d / f"tcs2-{instrument}.log", "a", encoding="utf-8") as f:
            f.write(f"\n=== {datetime.datetime.now():%Y-%m-%d %H:%M:%S} ===\n")
            traceback.print_exception(type(exc), exc, exc.__traceback__, file=f)
    except Exception:                                 # noqa: BLE001
        pass          # a logging failure must not replace the real error


if __name__ == "__main__":
    _inst = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException as _exc:                      # noqa: BLE001
        _log_crash(_inst, _exc)
        raise
