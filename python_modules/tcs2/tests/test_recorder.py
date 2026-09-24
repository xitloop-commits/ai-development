"""TCS2 - tests for the recorder and the damage-tolerant reader.

Spec: docs/systems/14_tcs2.md  D8, D44

The case these are written against is real. On 2026-09-18, 16 of 326 recordings
were damaged and some lost up to 99.9% of the day, because one broken chunk sits
in front of everything behind it and a standard reader stops there.

So the tests do not just check that good files read back. They deliberately
damage files and assert how much survives.
"""
from __future__ import annotations

import gzip
import json
import time

import pytest

from tcs2 import recorder
from tcs2.recorder import ReadReport, TickRecorder, read_json, read_lines


def rec(tmp_path, seal_every_sec=10.0, name="ticks.ndjson.gz") -> TickRecorder:
    return TickRecorder(tmp_path / name, seal_every_sec=seal_every_sec)


def write_and_stop(r: TickRecorder, records: list[dict]) -> None:
    r.start()
    for x in records:
        r.write(x)
    r.stop()


def sample(n: int) -> list[dict]:
    return [{"i": i, "sid": 1000 + (i % 50), "ltp": 100.0 + i, "oi": 5000 + i}
            for i in range(n)]


# -- round trip ----------------------------------------------------------

def test_everything_written_reads_back(tmp_path):
    r = rec(tmp_path)
    rows = sample(500)
    write_and_stop(r, rows)
    got = list(read_json(r.path))
    assert len(got) == 500
    assert [g["i"] for g in got] == [x["i"] for x in rows]


def test_the_file_is_ordinary_gzip(tmp_path):
    """Sealed members concatenate into a perfectly normal gzip file."""
    r = rec(tmp_path)
    write_and_stop(r, sample(100))
    with gzip.open(r.path, "rb") as f:
        assert len(f.read().strip().split(b"\n")) == 100


def test_nothing_is_lost_on_a_graceful_stop(tmp_path):
    """A clean stop must not be the thing that loses the last ten seconds."""
    r = rec(tmp_path, seal_every_sec=3600.0)     # would never seal on its own
    write_and_stop(r, sample(250))
    assert len(list(read_json(r.path))) == 250
    assert r.stats.members_sealed >= 1


def test_a_record_may_be_written_as_bytes(tmp_path):
    r = rec(tmp_path)
    r.start()
    r.write(b'{"raw":1}')
    r.stop()
    assert list(read_json(r.path)) == [{"raw": 1}]


def test_empty_file_reads_as_nothing(tmp_path):
    r = rec(tmp_path)
    write_and_stop(r, [])
    assert list(read_json(r.path)) == []


# -- sealing -------------------------------------------------------------

def test_members_are_sealed_on_a_timer(tmp_path):
    r = rec(tmp_path, seal_every_sec=0.15)
    r.start()
    for i in range(3):
        r.write({"i": i})
        time.sleep(0.2)
    r.stop()
    assert r.stats.members_sealed >= 3
    assert len(list(read_json(r.path))) == 3


def test_a_sealed_member_is_readable_before_the_writer_stops(tmp_path):
    """The whole point of D44: safety does not wait for a clean shutdown."""
    r = rec(tmp_path, seal_every_sec=0.15)
    r.start()
    for i in range(5):
        r.write({"i": i})
    time.sleep(0.5)                  # long enough to seal
    mid = list(read_json(r.path))    # read while the recorder is still running
    r.stop()
    assert len(mid) == 5, "sealed data must be readable without stopping"


def test_sealing_more_often_costs_size_but_not_content(tmp_path):
    """The ~10% penalty D44 accepted, demonstrated."""
    rows = sample(4000)
    rare = TickRecorder(tmp_path / "rare.gz", seal_every_sec=3600.0)
    write_and_stop(rare, rows)
    often = TickRecorder(tmp_path / "often.gz", seal_every_sec=0.0)
    write_and_stop(often, rows)

    assert len(list(read_json(rare.path))) == len(list(read_json(often.path))) == 4000
    assert often.path.stat().st_size > rare.path.stat().st_size


# -- damage: the 2026-09-18 case ----------------------------------------

def _truncate(path, keep_frac: float) -> None:
    raw = path.read_bytes()
    path.write_bytes(raw[: int(len(raw) * keep_frac)])


def _corrupt_middle(path, at_frac: float = 0.5, run: int = 64) -> None:
    raw = bytearray(path.read_bytes())
    at = int(len(raw) * at_frac)
    for i in range(at, min(at + run, len(raw))):
        raw[i] ^= 0xFF
    path.write_bytes(bytes(raw))


def test_a_crash_mid_write_loses_only_the_open_member(tmp_path):
    """Truncation is what a crash looks like: the open member is cut off."""
    r = rec(tmp_path, seal_every_sec=0.1)
    r.start()
    for i in range(200):
        r.write({"i": i})
        if i % 50 == 0:
            time.sleep(0.15)          # force several seals
    r.stop()
    full = len(list(read_json(r.path)))

    _truncate(r.path, 0.90)
    rep = ReadReport()
    survived = len(list(read_json(r.path, rep)))
    assert survived > full * 0.5, f"only {survived} of {full} survived truncation"


def test_damage_in_the_middle_does_not_hide_everything_behind_it(tmp_path):
    """The exact 2026-09-18 failure: one bad chunk blocking the whole tail.

    A standard gzip reader gives up at the fault. Ours must not.
    """
    r = rec(tmp_path, seal_every_sec=0.05)
    r.start()
    for i in range(300):
        r.write({"i": i})
        if i % 30 == 0:
            time.sleep(0.06)
    r.stop()
    full = [x["i"] for x in read_json(r.path)]
    assert len(full) == 300

    _corrupt_middle(r.path, at_frac=0.4)

    # What a standard reader manages.
    standard = 0
    try:
        with gzip.open(r.path, "rb") as f:
            for _ in f:
                standard += 1
    except Exception:                 # noqa: BLE001
        pass

    rep = ReadReport()
    ours = [x["i"] for x in read_json(r.path, rep)]

    assert rep.damaged_members >= 1
    assert len(ours) > standard, (
        f"tolerant reader got {len(ours)}, standard reader got {standard}")
    # The tail behind the damage is the part that used to be lost entirely.
    assert max(ours) > max(full) * 0.8


def test_a_damaged_file_is_reported_as_damaged(tmp_path):
    """Silence is what cost us in T185: the files looked fine.

    Sealing on every write makes member boundaries deterministic, so the
    corruption lands inside a member rather than wherever the timing put one.
    """
    r = rec(tmp_path, seal_every_sec=0.0)
    r.start()
    for i in range(200):
        r.write({"i": i, "pad": "x" * 200})
    r.stop()

    clean = ReadReport()
    list(read_json(r.path, clean))
    assert clean.clean
    assert clean.damaged_members == 0
    assert clean.members >= 2

    # Damage the payload of a member well inside the file, not a boundary.
    raw = bytearray(r.path.read_bytes())
    at = len(raw) // 2
    for i in range(at, min(at + 32, len(raw))):
        raw[i] ^= 0xFF
    r.path.write_bytes(bytes(raw))

    dirty = ReadReport()
    list(read_json(r.path, dirty))
    assert not dirty.clean, "a damaged file must not read as clean"
    assert dirty.damaged_members >= 1


def test_standard_gzip_check_flags_a_damaged_file(tmp_path):
    r = rec(tmp_path, seal_every_sec=0.05)
    r.start()
    for i in range(100):
        r.write({"i": i})
        time.sleep(0.001)
    r.stop()
    assert recorder.is_readable_by_standard_gzip(r.path)
    _corrupt_middle(r.path, at_frac=0.5)
    assert not recorder.is_readable_by_standard_gzip(r.path)


def test_leading_garbage_is_stepped_over(tmp_path):
    r = rec(tmp_path)
    write_and_stop(r, sample(50))
    raw = r.path.read_bytes()
    r.path.write_bytes(b"\x00" * 300 + raw)
    assert len(list(read_json(r.path))) == 50


def test_a_torn_last_line_is_discarded_not_handed_on(tmp_path):
    """A truncated record must never reach a consumer looking whole."""
    r = rec(tmp_path, seal_every_sec=3600.0)
    write_and_stop(r, sample(100))
    raw = r.path.read_bytes()
    r.path.write_bytes(raw[:-40])
    for row in read_json(r.path):
        assert "i" in row and isinstance(row["i"], int)


# -- lines spanning members ---------------------------------------------

def test_a_line_split_across_members_is_stitched_back(tmp_path):
    """Sealing mid-record must not corrupt that record."""
    r = rec(tmp_path, seal_every_sec=0.0)     # seal on every pass
    r.start()
    big = {"i": 0, "payload": "x" * 5000}
    for _ in range(20):
        r.write(big)
    r.stop()
    got = list(read_json(r.path))
    assert len(got) == 20
    assert all(len(g["payload"]) == 5000 for g in got)


# -- the queue -----------------------------------------------------------

def test_the_writer_never_blocks_the_caller(tmp_path):
    """The feed thread must never wait on the disk."""
    r = rec(tmp_path)
    r.start()
    t0 = time.perf_counter()
    for i in range(20_000):
        r.write({"i": i})
    queued_in = time.perf_counter() - t0
    r.stop()
    assert queued_in < 3.0, f"queueing 20k records took {queued_in:.1f}s"
    assert len(list(read_json(r.path))) == 20_000


def test_backlog_is_visible_rather_than_silent(tmp_path):
    """Ticks are never dropped, so a slow disk must show up as a backlog.

    Dropping a GUI frame is allowed; dropping a tick is not, because ticks
    cannot be re-obtained.
    """
    r = rec(tmp_path)
    r.start()
    for i in range(5000):
        r.write({"i": i})
    r.stop()
    assert r.stats.dropped == 0
    assert r.stats.queue_high_water > 0


def test_stats_track_what_was_written(tmp_path):
    r = rec(tmp_path, seal_every_sec=0.05)
    r.start()
    for i in range(100):
        r.write({"i": i})
        time.sleep(0.001)
    r.stop()
    assert r.stats.lines == 100
    assert r.stats.bytes_written > 0
    assert r.stats.members_sealed >= 1
    assert r.stats.last_write_at > 0
    assert not r.stats.errors


def test_recorder_reports_when_it_is_running(tmp_path):
    r = rec(tmp_path)
    assert not r.running
    r.start()
    assert r.running
    r.stop()
    assert not r.running


def test_starting_twice_is_refused(tmp_path):
    r = rec(tmp_path)
    r.start()
    with pytest.raises(RuntimeError):
        r.start()
    r.stop()


# -- appending -----------------------------------------------------------

def test_a_restart_appends_rather_than_truncating(tmp_path):
    """A restart mid-session must not delete the morning."""
    p = tmp_path / "day.ndjson.gz"
    first = TickRecorder(p, seal_every_sec=0.05)
    write_and_stop(first, sample(50))
    second = TickRecorder(p, seal_every_sec=0.05)
    second.start()
    for i in range(50, 100):
        second.write({"i": i, "sid": 1, "ltp": 1.0, "oi": 1})
    second.stop()
    got = [x["i"] for x in read_json(p)]
    assert got == list(range(100))


# -- the reader's own report --------------------------------------------

def test_read_report_counts_members_and_lines(tmp_path):
    r = rec(tmp_path, seal_every_sec=0.05)
    r.start()
    for i in range(120):
        r.write({"i": i})
        if i % 20 == 0:
            time.sleep(0.06)
    r.stop()
    rep = ReadReport()
    list(read_lines(r.path, rep))
    assert rep.lines == 120
    assert rep.members >= 2
    assert rep.bytes_recovered > 0
