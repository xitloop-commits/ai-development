"""TCS2 - one process per instrument, enforced at startup.

Spec: docs/systems/14_tcs2.md  (D9, D13, D14, D44)

D14 says one process per instrument and nothing shared. Nothing enforced it.

Two processes for the same instrument would each open the same recording file in
append mode and each seal members on its own clock, so compressed members would
interleave mid-write - producing exactly the damage D44 exists to prevent, from
a cause D44 cannot protect against. They would also take two of the five Dhan
connection slots for one instrument, and write conflicting rows into the same
database documents.

The lock is a file holding the owning process id. A stale lock left by a crash is
detected by checking whether that process is still alive, so a crash never
requires a manual cleanup - which would be forgotten at 08:54 on a Monday.
"""
from __future__ import annotations

import os
from pathlib import Path

from . import config as cfg


class AlreadyRunning(RuntimeError):
    """Another process already owns this instrument."""


def _alive(pid: int) -> bool:
    """Is this process id currently running?"""
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        k = ctypes.windll.kernel32
        h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            if k.GetExitCodeProcess(h, ctypes.byref(code)):
                return code.value == STILL_ACTIVE
            return False
        finally:
            k.CloseHandle(h)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True          # exists, owned by someone else


class InstrumentLock:
    """Held for the life of one instrument process."""

    def __init__(self, instrument: str, directory: Path | None = None) -> None:
        self.instrument = instrument
        self.path = (directory or cfg.DATA_ROOT / "locks") / f"{instrument}.pid"
        self._held = False

    def owner(self) -> int | None:
        """The pid currently holding this lock, or None if free or stale."""
        try:
            pid = int(self.path.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            return None
        return pid if _alive(pid) else None

    def acquire(self) -> None:
        existing = self.owner()
        if existing is not None and existing != os.getpid():
            raise AlreadyRunning(
                f"{self.instrument} is already running as pid {existing}. "
                f"Two processes for one instrument would interleave writes into "
                f"the same recording and take two Dhan connection slots (D14). "
                f"Stop it first, or delete {self.path} if you are certain it is "
                f"gone.")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(str(os.getpid()), encoding="utf-8")
        self._held = True

    def release(self) -> None:
        if not self._held:
            return
        try:
            if self.owner() in (os.getpid(), None):
                self.path.unlink(missing_ok=True)
        except OSError:
            pass
        self._held = False

    def __enter__(self) -> "InstrumentLock":
        self.acquire()
        return self

    def __exit__(self, *_exc) -> None:
        self.release()


# -- stopping ------------------------------------------------------------
#
# Signals are not a usable stop mechanism here. Measured 2026-09-25 on Windows:
# `os.kill(pid, SIGTERM)` did not reach the handler at all - the process kept
# running and kept its lock. D18 has scheduled tasks starting these processes,
# so something has to be able to stop them cleanly, and a hard kill loses the
# open recording chunk.
#
# A sentinel file works on every platform and needs no permissions: the launcher
# or the scheduled task creates it, the process notices within a second, seals
# its recording, drains the write queue and releases the lock.

def stop_path(instrument: str, directory: Path | None = None) -> Path:
    return (directory or cfg.DATA_ROOT / "locks") / f"{instrument}.stop"


def request_stop(instrument: str, directory: Path | None = None) -> Path:
    """Ask a running instrument process to shut down gracefully."""
    p = stop_path(instrument, directory)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(str(os.getpid()), encoding="utf-8")
    return p


def stop_requested(instrument: str, directory: Path | None = None) -> bool:
    return stop_path(instrument, directory).exists()


def clear_stop(instrument: str, directory: Path | None = None) -> None:
    """Remove a stale request so the next start is not stopped immediately."""
    stop_path(instrument, directory).unlink(missing_ok=True)
