"""
tests/test_replay.py — Unit tests for replay/ modules (Phase 14).

Tests stream_merger.py and checkpoint.py.

Run: python -m pytest python_modules/tick_feature_agent/tests/test_replay.py -v
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.replay.checkpoint import ReplayCheckpoint
from tick_feature_agent.replay.stream_merger import merge_streams

# ── Helpers ────────────────────────────────────────────────────────────────────


def _write_gz(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


def _make_date_folder(
    tmp_path: Path,
    instrument: str,
    underlying_ticks: list[dict],
    option_ticks: list[dict],
    chain_snapshots: list[dict],
) -> Path:
    folder = tmp_path / "data" / "raw" / "2026-04-14"
    _write_gz(folder / f"{instrument}_underlying_ticks.ndjson.gz", underlying_ticks)
    _write_gz(folder / f"{instrument}_option_ticks.ndjson.gz", option_ticks)
    _write_gz(folder / f"{instrument}_chain_snapshots.ndjson.gz", chain_snapshots)
    return folder


def _ts(h, m, s, ms=0) -> str:
    """Build an IST timestamp string for test ordering."""
    return f"2026-04-14T{h:02d}:{m:02d}:{s:02d}.{ms:03d}+05:30"


# ══════════════════════════════════════════════════════════════════════════════
# TestStreamMerger
# ══════════════════════════════════════════════════════════════════════════════


class TestStreamMerger:

    def test_single_stream_ordered(self, tmp_path):
        records = [
            {"recv_ts": _ts(9, 15, 1), "ltp": 100.0},
            {"recv_ts": _ts(9, 15, 2), "ltp": 101.0},
        ]
        folder = _make_date_folder(
            tmp_path, "nifty50", underlying_ticks=records, option_ticks=[], chain_snapshots=[]
        )
        events = list(merge_streams(folder, "nifty50"))
        assert len(events) == 2
        assert all(e["type"] == "underlying_tick" for e in events)

    def test_chronological_merge(self, tmp_path):
        """
        Underlying tick at T=1, option tick at T=2, chain snapshot at T=3.
        After merge: [underlying, option, chain].
        """
        folder = _make_date_folder(
            tmp_path,
            "nifty50",
            underlying_ticks=[{"recv_ts": _ts(9, 15, 1), "ltp": 100.0}],
            option_ticks=[{"recv_ts": _ts(9, 15, 2), "ltp": 50.0}],
            chain_snapshots=[{"recv_ts": _ts(9, 15, 3), "spot": 24100.0}],
        )
        events = list(merge_streams(folder, "nifty50"))
        assert len(events) == 3
        types = [e["type"] for e in events]
        assert types == ["underlying_tick", "option_tick", "chain_snapshot"]

    def test_interleaved_streams(self, tmp_path):
        """
        U1 at T=1, O1 at T=1.5, U2 at T=2, C1 at T=2.5.
        """
        folder = _make_date_folder(
            tmp_path,
            "nifty50",
            underlying_ticks=[
                {"recv_ts": _ts(9, 15, 1, 0), "ltp": 100.0},
                {"recv_ts": _ts(9, 15, 2, 0), "ltp": 101.0},
            ],
            option_ticks=[
                {"recv_ts": _ts(9, 15, 1, 500), "ltp": 50.0},
            ],
            chain_snapshots=[
                {"recv_ts": _ts(9, 15, 2, 500), "spot": 24100.0},
            ],
        )
        events = list(merge_streams(folder, "nifty50"))
        assert len(events) == 4
        # Check order by looking at first two events
        assert events[0]["type"] == "underlying_tick"
        assert events[1]["type"] == "option_tick"
        assert events[2]["type"] == "underlying_tick"
        assert events[3]["type"] == "chain_snapshot"

    def test_missing_file_skipped(self, tmp_path):
        """Missing option_ticks file should not crash — just skip."""
        folder = tmp_path / "data" / "raw" / "2026-04-14"
        # Only write underlying ticks
        _write_gz(
            folder / "nifty50_underlying_ticks.ndjson.gz",
            [{"recv_ts": _ts(9, 15, 1), "ltp": 100.0}],
        )
        # option_ticks and chain_snapshots are missing
        events = list(merge_streams(folder, "nifty50"))
        assert len(events) == 1
        assert events[0]["type"] == "underlying_tick"

    def test_empty_streams_return_empty(self, tmp_path):
        folder = _make_date_folder(
            tmp_path, "nifty50", underlying_ticks=[], option_ticks=[], chain_snapshots=[]
        )
        events = list(merge_streams(folder, "nifty50"))
        assert events == []

    def test_event_data_preserved(self, tmp_path):
        record = {"recv_ts": _ts(9, 15, 1), "ltp": 24100.5, "bid": 24100.0}
        folder = _make_date_folder(
            tmp_path, "nifty50", underlying_ticks=[record], option_ticks=[], chain_snapshots=[]
        )
        events = list(merge_streams(folder, "nifty50"))
        assert events[0]["data"]["ltp"] == 24100.5
        assert events[0]["data"]["bid"] == 24100.0

    def test_malformed_line_skipped(self, tmp_path):
        folder = tmp_path / "data" / "raw" / "2026-04-14"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / "nifty50_underlying_ticks.ndjson.gz"
        with gzip.open(path, "wt") as f:
            f.write(
                "{valid}\n".replace("{valid}", json.dumps({"recv_ts": _ts(9, 15, 1), "ltp": 1.0}))
            )
            f.write("MALFORMED LINE\n")
            f.write(json.dumps({"recv_ts": _ts(9, 15, 2), "ltp": 2.0}) + "\n")
        _write_gz(folder / "nifty50_option_ticks.ndjson.gz", [])
        _write_gz(folder / "nifty50_chain_snapshots.ndjson.gz", [])
        events = list(merge_streams(folder, "nifty50"))
        # Only 2 valid records
        assert len(events) == 2

    def test_large_multi_stream_ordering(self, tmp_path):
        """50 underlying + 50 option ticks interleaved — verify strict ordering."""
        import bisect

        underlying = [
            {"recv_ts": _ts(9, 15, i, 0), "seq": f"u{i}", "ltp": float(i)} for i in range(1, 51)
        ]
        options = [
            {"recv_ts": _ts(9, 15, i, 500), "seq": f"o{i}", "ltp": float(i)} for i in range(1, 51)
        ]
        folder = _make_date_folder(
            tmp_path,
            "nifty50",
            underlying_ticks=underlying,
            option_ticks=options,
            chain_snapshots=[],
        )
        events = list(merge_streams(folder, "nifty50"))
        assert len(events) == 100
        # Verify timestamps are non-decreasing
        timestamps = [e["data"]["recv_ts"] for e in events]
        assert timestamps == sorted(timestamps)


# ══════════════════════════════════════════════════════════════════════════════
# TestReplayCheckpoint
# ══════════════════════════════════════════════════════════════════════════════


class TestReplayCheckpoint:

    def _cp(self, tmp_path):
        return ReplayCheckpoint(tmp_path / "checkpoints" / "replay_progress.json")

    def test_mark_complete(self, tmp_path):
        cp = self._cp(tmp_path)
        cp.mark_complete("nifty50", "2026-04-01")
        entry = cp.get_entry("nifty50")
        assert entry["last_completed_date"] == "2026-04-01"
        assert entry["sessions_completed"] == 1

    def test_mark_complete_multiple(self, tmp_path):
        cp = self._cp(tmp_path)
        cp.mark_complete("nifty50", "2026-04-01")
        cp.mark_complete("nifty50", "2026-04-02")
        cp.mark_complete("nifty50", "2026-04-03")
        entry = cp.get_entry("nifty50")
        assert entry["last_completed_date"] == "2026-04-03"
        assert entry["sessions_completed"] == 3

    def test_get_resume_date_no_checkpoint(self, tmp_path):
        """No checkpoint → resume from date_from."""
        cp = self._cp(tmp_path)
        result = cp.get_resume_date("nifty50", "2026-04-01")
        assert result == "2026-04-01"

    def test_get_resume_date_after_last_completed(self, tmp_path):
        """Checkpoint at 2026-04-05 → resume from 2026-04-06."""
        cp = self._cp(tmp_path)
        cp.mark_complete("nifty50", "2026-04-05")
        result = cp.get_resume_date("nifty50", "2026-04-01")
        assert result == "2026-04-06"

    def test_get_resume_date_uses_max_of_next_vs_from(self, tmp_path):
        """
        If last_completed = 2026-04-02 and date_from = 2026-04-10:
        next = 2026-04-03, but max(2026-04-03, 2026-04-10) = 2026-04-10.
        """
        cp = self._cp(tmp_path)
        cp.mark_complete("nifty50", "2026-04-02")
        result = cp.get_resume_date("nifty50", "2026-04-10")
        assert result == "2026-04-10"

    def test_independent_instruments(self, tmp_path):
        cp = self._cp(tmp_path)
        cp.mark_complete("nifty50", "2026-04-05")
        cp.mark_complete("crudeoil", "2026-04-03")
        assert cp.get_entry("nifty50")["last_completed_date"] == "2026-04-05"
        assert cp.get_entry("crudeoil")["last_completed_date"] == "2026-04-03"

    def test_get_entry_missing_instrument(self, tmp_path):
        cp = self._cp(tmp_path)
        assert cp.get_entry("nonexistent") is None

    def test_reset_single_instrument(self, tmp_path):
        cp = self._cp(tmp_path)
        cp.mark_complete("nifty50", "2026-04-05")
        cp.mark_complete("crudeoil", "2026-04-03")
        cp.reset("nifty50")
        assert cp.get_entry("nifty50") is None
        assert cp.get_entry("crudeoil") is not None

    def test_reset_all(self, tmp_path):
        cp = self._cp(tmp_path)
        cp.mark_complete("nifty50", "2026-04-05")
        cp.mark_complete("crudeoil", "2026-04-03")
        cp.reset()
        assert cp.get_entry("nifty50") is None
        assert cp.get_entry("crudeoil") is None

    def test_creates_parent_dirs(self, tmp_path):
        cp = ReplayCheckpoint(tmp_path / "deep" / "nested" / "progress.json")
        cp.mark_complete("nifty50", "2026-04-01")
        assert (tmp_path / "deep" / "nested" / "progress.json").exists()

    def test_checkpoint_file_is_valid_json(self, tmp_path):
        cp = self._cp(tmp_path)
        cp.mark_complete("nifty50", "2026-04-01")
        path = tmp_path / "checkpoints" / "replay_progress.json"
        data = json.loads(path.read_text())
        assert "nifty50" in data

    def test_mark_does_not_regress_date(self, tmp_path):
        """Marking an older date should not move last_completed_date backwards."""
        cp = self._cp(tmp_path)
        cp.mark_complete("nifty50", "2026-04-10")
        cp.mark_complete("nifty50", "2026-04-05")  # older date
        entry = cp.get_entry("nifty50")
        assert entry["last_completed_date"] == "2026-04-10"  # unchanged
        assert entry["sessions_completed"] == 2  # counter still increments


# ══════════════════════════════════════════════════════════════════════════════
# TestReplayIncludeDates  (per-date launcher picker support)
# ══════════════════════════════════════════════════════════════════════════════


class TestReplayIncludeDates:
    """Date-selection contract for ``replay()``:
      1. ``include_dates`` (per-date picker) wins over the range — only
         the listed dates run; date-range walk is skipped entirely.
      2. ``include_dates`` bypasses the checkpoint — user has chosen
         exactly what to (re-)replay.
      3. De-duplicate and sort the input list.
      4. Without ``include_dates``, walk the range starting from the
         checkpoint's resume date.

    2026-06-14 rewrite: pre-existing version of these tests monkey-
    patched ``run_one_date`` on the parent process and ran replay
    via ``workers=1`` to force a serial in-process branch. That
    branch was removed when single + multi date paths unified, so
    the tests now exercise the same contract through the pure
    ``_resolve_dates_to_process`` helper — no spawning, no patching.
    """

    def test_include_dates_processes_only_listed_dates(self, tmp_path):
        from tick_feature_agent.replay.checkpoint import ReplayCheckpoint
        from tick_feature_agent.replay.replay_runner import _resolve_dates_to_process

        cp = ReplayCheckpoint(tmp_path / "raw" / "replay_checkpoint.json")
        out = _resolve_dates_to_process(
            instrument="nifty50",
            date_from="2026-04-01",   # ignored when include_dates is set
            date_to="2026-04-10",     # ignored
            include_dates=["2026-04-03", "2026-04-07"],
            checkpoint=cp,
        )
        assert out == ["2026-04-03", "2026-04-07"]

    def test_include_dates_bypasses_checkpoint(self, tmp_path):
        """A pre-existing checkpoint that says 'completed up to
        2026-04-09' must NOT cause earlier explicit dates to be
        skipped."""
        from tick_feature_agent.replay.checkpoint import ReplayCheckpoint
        from tick_feature_agent.replay.replay_runner import _resolve_dates_to_process

        cp = ReplayCheckpoint(tmp_path / "raw" / "replay_checkpoint.json")
        cp.mark_complete("nifty50", "2026-04-09")

        out = _resolve_dates_to_process(
            instrument="nifty50",
            date_from="2026-04-01",
            date_to="2026-04-10",
            include_dates=["2026-04-02", "2026-04-04"],
            checkpoint=cp,
        )
        # Both pre-checkpoint dates land in the run list despite the
        # checkpoint saying 2026-04-09 is done.
        assert out == ["2026-04-02", "2026-04-04"]

    def test_include_dates_dedupes_and_sorts(self, tmp_path):
        from tick_feature_agent.replay.checkpoint import ReplayCheckpoint
        from tick_feature_agent.replay.replay_runner import _resolve_dates_to_process

        cp = ReplayCheckpoint(tmp_path / "raw" / "replay_checkpoint.json")
        out = _resolve_dates_to_process(
            instrument="nifty50",
            date_from="2026-04-01",
            date_to="2026-04-10",
            include_dates=["2026-04-05", "2026-04-02", "2026-04-05"],
            checkpoint=cp,
        )
        assert out == ["2026-04-02", "2026-04-05"]

    def test_no_include_dates_falls_back_to_range_walk(self, tmp_path):
        """Without ``include_dates``, the range-walk + checkpoint-
        respecting behaviour is preserved."""
        from tick_feature_agent.replay.checkpoint import ReplayCheckpoint
        from tick_feature_agent.replay.replay_runner import _resolve_dates_to_process

        cp = ReplayCheckpoint(tmp_path / "raw" / "replay_checkpoint.json")
        out = _resolve_dates_to_process(
            instrument="nifty50",
            date_from="2026-04-01",
            date_to="2026-04-03",
            include_dates=None,
            checkpoint=cp,
        )
        assert out == ["2026-04-01", "2026-04-02", "2026-04-03"]

    def test_no_include_dates_resumes_from_checkpoint(self, tmp_path):
        """Range walk MUST honour the checkpoint's resume date so
        already-completed dates aren't re-replayed. (Pre-2026-06-14
        this was implicitly covered by the monkey-patched serial
        branch; explicit assertion now.)"""
        from tick_feature_agent.replay.checkpoint import ReplayCheckpoint
        from tick_feature_agent.replay.replay_runner import _resolve_dates_to_process

        cp = ReplayCheckpoint(tmp_path / "raw" / "replay_checkpoint.json")
        cp.mark_complete("nifty50", "2026-04-05")

        out = _resolve_dates_to_process(
            instrument="nifty50",
            date_from="2026-04-01",
            date_to="2026-04-08",
            include_dates=None,
            checkpoint=cp,
        )
        # Resume picks up at the day after the last completed date.
        assert out == [
            "2026-04-06", "2026-04-07", "2026-04-08",
        ]


# ══════════════════════════════════════════════════════════════════════════════
# TestT47Parallelism  (worker-count resolver + concurrent checkpoint writes)
# ══════════════════════════════════════════════════════════════════════════════


class TestT47Parallelism:
    """T47 — replay-runner ProcessPoolExecutor fan-out across dates.

    These tests exercise the pieces that are independent of the actual
    subprocess pool: the worker-count resolver (pure function) and the
    portalocker-protected ``ReplayCheckpoint.mark_complete`` under thread
    concurrency. The full end-to-end fan-out path needs real profile + raw
    data and is exercised by manual smoke-test before each ship.
    """

    def test_resolve_workers_auto_default(self):
        from tick_feature_agent.replay.replay_runner import (
            DEFAULT_WORKERS_TARGET,
            _resolve_workers,
        )
        # Auto = min(num_dates, DEFAULT_WORKERS_TARGET)
        assert _resolve_workers(3, None) == 3
        assert _resolve_workers(50, None) == DEFAULT_WORKERS_TARGET
        assert _resolve_workers(DEFAULT_WORKERS_TARGET, None) == DEFAULT_WORKERS_TARGET

    def test_resolve_workers_hard_cap(self):
        from tick_feature_agent.replay.replay_runner import (
            WORKERS_HARD_CAP,
            _resolve_workers,
        )
        # User-requested above cap → clamped to cap (and to num_dates)
        assert _resolve_workers(100, WORKERS_HARD_CAP + 10) == WORKERS_HARD_CAP
        # Cap can't exceed available dates
        assert _resolve_workers(3, WORKERS_HARD_CAP + 10) == 3

    def test_resolve_workers_explicit_serial(self):
        from tick_feature_agent.replay.replay_runner import _resolve_workers
        # Explicit 1 → serial (used by tests + opt-out users)
        assert _resolve_workers(10, 1) == 1
        # Zero / negative / None → auto
        assert _resolve_workers(10, 0) == 10
        assert _resolve_workers(10, -5) == 10

    def test_resolve_workers_empty(self):
        from tick_feature_agent.replay.replay_runner import _resolve_workers
        # Empty date list still returns >=1 (degenerate)
        assert _resolve_workers(0, None) == 1
        assert _resolve_workers(0, 5) == 1

    def test_checkpoint_mark_complete_thread_concurrency(self, tmp_path):
        """Filelock-protected ``mark_complete`` must not lose updates when
        called concurrently. We use threads (not processes) so the test is
        portable and fast; the same lock semantics apply to ProcessPool
        workers via portalocker."""
        import threading
        from tick_feature_agent.replay.checkpoint import ReplayCheckpoint

        cp_path = tmp_path / "raw" / "replay_checkpoint.json"
        cp = ReplayCheckpoint(cp_path)

        instrument = "nifty50"
        dates = [f"2026-04-{d:02d}" for d in range(1, 21)]  # 20 dates

        def _worker(d: str) -> None:
            cp.mark_complete(instrument, d)

        threads = [threading.Thread(target=_worker, args=(d,)) for d in dates]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Every date should be reflected in sessions_completed; no update lost.
        entry = cp.get_entry(instrument)
        assert entry is not None, "checkpoint entry vanished after concurrent writes"
        assert entry["sessions_completed"] == len(dates), (
            f"expected {len(dates)} sessions_completed, "
            f"got {entry['sessions_completed']} — lock failed to serialise writes"
        )
        # last_completed_date should be the max of the inputs (lexically OK
        # for ISO dates)
        assert entry["last_completed_date"] == max(dates)


# ══════════════════════════════════════════════════════════════════════════════
# TestProgressDashboard  (T47 rich dashboard — basic API contract)
# ══════════════════════════════════════════════════════════════════════════════


class TestProgressDashboard:
    """We don't try to assert on rich's rendered output (terminal-dependent);
    instead we verify the dashboard's input/output contract: it accepts a
    plain dict, tracks status transitions, and returns an accurate summary.
    """

    def test_summary_counts_status_transitions(self):
        from tick_feature_agent.replay.progress_dashboard import ProgressDashboard

        dates = ["2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04"]
        d: dict = {}
        # Use plain dict; the dashboard works the same way regardless of
        # whether it's a Manager proxy or a regular dict.
        dash = ProgressDashboard("nifty50", dates, workers=2, progress_dict=d)
        # On construction, missing dates are seeded as "pending"
        for date in dates:
            assert d[date]["status"] == "pending"
        # Mark terminal — summary updates
        dash.mark_terminal("2026-04-01", "pass")
        dash.mark_terminal("2026-04-02", "warn")
        dash.mark_terminal("2026-04-03", "fail")
        summary = dash.summary()
        assert summary["pass"] == 1
        assert summary["warn"] == 1
        assert summary["fail"] == 1
        assert summary["pending"] == 1
        assert summary["skip"] == 0
        assert summary["running"] == 0

    def test_render_does_not_crash_on_empty_state(self):
        """Rendering should be tolerant of dates that have no data yet —
        a freshly-spawned worker may not have pushed its first progress
        update by the time the dashboard's refresh thread polls."""
        from tick_feature_agent.replay.progress_dashboard import ProgressDashboard

        dash = ProgressDashboard(
            "nifty50",
            ["2026-04-01", "2026-04-02"],
            workers=2,
            progress_dict={},
        )
        # Public-via-internal — we just need to know it doesn't raise.
        # The Group object is opaque; rich renders it elsewhere.
        renderable = dash._render()
        assert renderable is not None
