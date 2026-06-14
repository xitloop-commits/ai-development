"""
Tests for 2026-06-14 Ctrl+C graceful drain helpers in replay_runner.

Covers:
  - _worker_sigint_ignore actually installs SIG_IGN on SIGINT (so pool
    workers don't blow up with a traceback on console Ctrl+C).
  - _interrupted_pause_for_keypress respects LUBAS_HEADLESS=1 so
    scripted / cron runs don't hang waiting for input that never comes.
  - _interrupted_pause_for_keypress no-ops when stdin isn't a TTY on
    non-Windows hosts (same scripted-runs guard).

Does NOT cover the in-process drain loop end-to-end — that needs a
real ProcessPoolExecutor + a worker that blocks long enough to be
interrupted. Smoke-tested manually instead; the helpers exercised
here are the bits where the behavioural change lives.
"""

from __future__ import annotations

import os
import signal
import sys
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_PY_MODULES = _HERE.parents[1]
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

from tick_feature_agent.replay.replay_runner import (  # noqa: E402
    _interrupted_pause_for_keypress,
    _worker_sigint_ignore,
)


def test_worker_sigint_ignore_installs_sig_ign(monkeypatch):
    """Running ``_worker_sigint_ignore`` swaps the SIGINT handler
    on the calling process to ``SIG_IGN``. We capture + restore so we
    don't kill the pytest runner's own Ctrl+C handling.
    """
    prev = signal.getsignal(signal.SIGINT)
    try:
        _worker_sigint_ignore()
        # After the initializer runs, the calling process should ignore
        # SIGINT — i.e. signal.getsignal returns signal.SIG_IGN.
        assert signal.getsignal(signal.SIGINT) == signal.SIG_IGN
    finally:
        # Restore so pytest's own Ctrl+C handler survives.
        signal.signal(signal.SIGINT, prev)


def test_pause_for_keypress_returns_immediately_when_headless(monkeypatch):
    """LUBAS_HEADLESS=1 means there's no operator at the keyboard
    (cron, scheduled task, scripted run). The pause helper must
    return without reading anything.
    """
    monkeypatch.setenv("LUBAS_HEADLESS", "1")
    # Pass a dummy dashboard object — helper doesn't actually use it.
    _interrupted_pause_for_keypress(dashboard=None)  # must not block


def test_pause_for_keypress_returns_immediately_when_stdin_not_tty(monkeypatch):
    """On non-Windows hosts the helper short-circuits when stdin
    isn't a TTY (CI runners, ``replay | tee`` pipes, etc.). The
    Windows branch uses msvcrt.getch which doesn't have the same
    TTY check — skip this assertion on Windows.
    """
    if sys.platform == "win32":
        pytest.skip("Windows branch uses msvcrt.getch; no stdin-TTY guard")
    monkeypatch.delenv("LUBAS_HEADLESS", raising=False)

    class _NonTTYStdin:
        def isatty(self) -> bool:
            return False

        def readline(self) -> str:
            # If the helper accidentally reads, return empty so it
            # doesn't hang.
            return ""

    monkeypatch.setattr(sys, "stdin", _NonTTYStdin())
    _interrupted_pause_for_keypress(dashboard=None)  # must not block


def test_pause_for_keypress_swallows_exceptions(monkeypatch):
    """Any unexpected failure inside the pause helper must NOT
    propagate to the caller — Ctrl+C cleanup paths must never raise
    a secondary exception that masks the original KeyboardInterrupt.
    """
    monkeypatch.delenv("LUBAS_HEADLESS", raising=False)
    # Force the helper down a path that will raise. On Windows, msvcrt
    # is always importable, so we patch sys.stdin to a stub whose
    # isatty raises (POSIX branch) — and on Windows we patch msvcrt
    # via sys.modules to a broken stub.
    if sys.platform == "win32":
        class _BrokenMsvcrt:
            def getch(self):
                raise RuntimeError("simulated broken getch")
        monkeypatch.setitem(sys.modules, "msvcrt", _BrokenMsvcrt())
    else:
        class _BrokenStdin:
            def isatty(self) -> bool:
                raise RuntimeError("simulated broken isatty")
        monkeypatch.setattr(sys, "stdin", _BrokenStdin())
    _interrupted_pause_for_keypress(dashboard=None)  # must not raise
