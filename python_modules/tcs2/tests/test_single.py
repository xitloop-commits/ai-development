"""TCS2 - tests for the one-process-per-instrument lock.

Spec: docs/systems/14_tcs2.md  D9, D14, D44

D14 said one process per instrument and nothing enforced it. Two processes would
each append to the same recording and each seal members on its own clock, so
compressed members would interleave mid-write - producing exactly the damage D44
exists to prevent, from a cause D44 cannot protect against.
"""
from __future__ import annotations

import os

import pytest

from tcs2.single import AlreadyRunning, InstrumentLock, _alive


def lock(tmp_path, instrument: str = "nifty50") -> InstrumentLock:
    return InstrumentLock(instrument, directory=tmp_path)


# -- liveness ------------------------------------------------------------

def test_this_process_is_alive():
    assert _alive(os.getpid())


def test_an_impossible_pid_is_not_alive():
    assert not _alive(-1)
    assert not _alive(0)


def test_a_very_unlikely_pid_is_not_alive():
    assert not _alive(4_000_000_00 % 2_000_000 + 999_999)


# -- acquire and release -------------------------------------------------

def test_acquiring_writes_our_pid(tmp_path):
    lk = lock(tmp_path)
    lk.acquire()
    try:
        assert lk.path.exists()
        assert int(lk.path.read_text(encoding="utf-8")) == os.getpid()
        assert lk.owner() == os.getpid()
    finally:
        lk.release()


def test_releasing_removes_the_file(tmp_path):
    lk = lock(tmp_path)
    lk.acquire()
    lk.release()
    assert not lk.path.exists()


def test_the_same_process_may_re_acquire(tmp_path):
    """A restart within one process must not deadlock against itself."""
    lk = lock(tmp_path)
    lk.acquire()
    lk.acquire()
    lk.release()


def test_a_free_instrument_has_no_owner(tmp_path):
    assert lock(tmp_path).owner() is None


# -- the thing it exists for --------------------------------------------

def test_a_second_process_is_refused(tmp_path):
    """Two processes for one instrument would corrupt the recording."""
    first = lock(tmp_path)
    first.acquire()
    try:
        second = InstrumentLock("nifty50", directory=tmp_path)
        # Pretend the second is a different process by writing a live pid that
        # is not ours - the parent of this interpreter will do on POSIX, and on
        # Windows we simulate by checking the refusal logic directly.
        second.path.write_text(str(os.getpid() + 0), encoding="utf-8")
        # Same pid is allowed through by design (re-acquire), so assert the
        # refusal path with a pid we know is alive and different.
        import subprocess
        import sys
        proc = subprocess.Popen([sys.executable, "-c",
                                 "import time; time.sleep(30)"])
        try:
            second.path.write_text(str(proc.pid), encoding="utf-8")
            with pytest.raises(AlreadyRunning):
                second.acquire()
        finally:
            proc.kill()
            proc.wait(timeout=10)
    finally:
        first.release()


def test_the_refusal_explains_itself(tmp_path):
    """An error at 08:54 has to say what to do, not just that it failed."""
    import subprocess
    import sys
    lk = lock(tmp_path)
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        lk.path.parent.mkdir(parents=True, exist_ok=True)
        lk.path.write_text(str(proc.pid), encoding="utf-8")
        with pytest.raises(AlreadyRunning) as exc:
            lk.acquire()
        msg = str(exc.value)
        assert "nifty50" in msg
        assert str(proc.pid) in msg
        assert str(lk.path) in msg          # tells you what to delete
    finally:
        proc.kill()
        proc.wait(timeout=10)


# -- crash recovery ------------------------------------------------------

def test_a_stale_lock_from_a_crash_is_taken_over(tmp_path):
    """A crash must never require a manual cleanup.

    It would be forgotten at 08:54 on a Monday, and then nothing runs that day.
    """
    lk = lock(tmp_path)
    lk.path.parent.mkdir(parents=True, exist_ok=True)
    lk.path.write_text("999999999", encoding="utf-8")     # a pid long gone
    assert lk.owner() is None
    lk.acquire()
    try:
        assert lk.owner() == os.getpid()
    finally:
        lk.release()


def test_a_corrupt_lock_file_is_treated_as_free(tmp_path):
    lk = lock(tmp_path)
    lk.path.parent.mkdir(parents=True, exist_ok=True)
    lk.path.write_text("not a pid", encoding="utf-8")
    assert lk.owner() is None
    lk.acquire()
    lk.release()


def test_an_empty_lock_file_is_treated_as_free(tmp_path):
    lk = lock(tmp_path)
    lk.path.parent.mkdir(parents=True, exist_ok=True)
    lk.path.write_text("", encoding="utf-8")
    assert lk.owner() is None


# -- different instruments do not collide -------------------------------

def test_instruments_lock_independently(tmp_path):
    """Four processes run at once (D9) - they must not block each other."""
    held = [InstrumentLock(name, directory=tmp_path)
            for name in ("nifty50", "banknifty", "crudeoil", "naturalgas")]
    for lk in held:
        lk.acquire()
    try:
        assert len({lk.path for lk in held}) == 4
        for lk in held:
            assert lk.owner() == os.getpid()
    finally:
        for lk in held:
            lk.release()


# -- context manager -----------------------------------------------------

def test_the_lock_releases_on_the_way_out(tmp_path):
    lk = lock(tmp_path)
    with lk:
        assert lk.path.exists()
    assert not lk.path.exists()


def test_the_lock_releases_even_when_the_body_raises(tmp_path):
    lk = lock(tmp_path)
    with pytest.raises(ValueError):
        with lk:
            raise ValueError("boom")
    assert not lk.path.exists()
