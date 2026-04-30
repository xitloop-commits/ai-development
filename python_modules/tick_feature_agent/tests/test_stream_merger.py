"""
tests/test_stream_merger.py — Phase E6 unit tests for the
prefer-recovered file resolver in `replay/stream_merger.py`.

The bug being guarded against (PY-13/PY-122/PY-123): replay was reading
the corrupt original `.ndjson.gz` and bailing mid-stream, producing zero
or partial parquet output even when a clean `.recovered.ndjson.gz`
already existed next to it. The resolver must prefer the recovered
file when it exists and fall back to the original otherwise.

Run: python -m pytest python_modules/tick_feature_agent/tests/test_stream_merger.py -v
"""
from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent  # python_modules/
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.replay.stream_merger import (
    _FILE_SUFFIXES,
    _resolve_stream_path,
    merge_streams,
)


_INSTRUMENT = "nifty50"


def _write_gz_lines(path: Path, lines: list[dict]) -> None:
    """Write a list of JSON objects as gzipped NDJSON to `path`."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for rec in lines:
            f.write(json.dumps(rec) + "\n")


# ── Resolver: prefer-recovered logic ──────────────────────────────────────

def test_resolver_prefers_recovered_over_original(tmp_path: Path):
    """When both files exist, the resolver must return the recovered one."""
    suffix = "underlying_ticks.ndjson.gz"
    original  = tmp_path / f"{_INSTRUMENT}_{suffix}"
    recovered = tmp_path / f"{_INSTRUMENT}_underlying_ticks.recovered.ndjson.gz"
    _write_gz_lines(original,  [{"recv_ts": "2026-04-14T09:15:00", "src": "original"}])
    _write_gz_lines(recovered, [{"recv_ts": "2026-04-14T09:15:00", "src": "recovered"}])
    assert _resolve_stream_path(tmp_path, _INSTRUMENT, suffix) == recovered


def test_resolver_falls_back_to_original_when_no_recovered(tmp_path: Path):
    """The unmodified path: clean dates have only the original."""
    suffix = "option_ticks.ndjson.gz"
    original = tmp_path / f"{_INSTRUMENT}_{suffix}"
    _write_gz_lines(original, [{"recv_ts": "2026-04-14T09:15:00"}])
    assert _resolve_stream_path(tmp_path, _INSTRUMENT, suffix) == original


def test_resolver_returns_recovered_when_only_recovered_exists(tmp_path: Path):
    """If an operator manually removed/renamed a hopelessly broken
    original but kept the .recovered.ndjson.gz, replay must still
    pick it up."""
    suffix = "chain_snapshots.ndjson.gz"
    recovered = tmp_path / f"{_INSTRUMENT}_chain_snapshots.recovered.ndjson.gz"
    _write_gz_lines(recovered, [{"recv_ts": "2026-04-14T09:15:00"}])
    assert _resolve_stream_path(tmp_path, _INSTRUMENT, suffix) == recovered


def test_resolver_returns_none_when_neither_exists(tmp_path: Path):
    suffix = "underlying_ticks.ndjson.gz"
    assert _resolve_stream_path(tmp_path, _INSTRUMENT, suffix) is None


@pytest.mark.parametrize("suffix", _FILE_SUFFIXES)
def test_resolver_works_for_each_canonical_suffix(tmp_path: Path, suffix: str):
    """Run the prefer-recovered logic against each of the three real
    stream suffixes — guards against future suffix-list edits silently
    skipping one stream."""
    stem = suffix[: -len(".ndjson.gz")]
    recovered = tmp_path / f"{_INSTRUMENT}_{stem}.recovered.ndjson.gz"
    _write_gz_lines(recovered, [{"recv_ts": "2026-04-14T09:15:00"}])
    assert _resolve_stream_path(tmp_path, _INSTRUMENT, suffix) == recovered


# ── End-to-end merge_streams: recovered file is read ──────────────────────

class _FakeLogger:
    def __init__(self):
        self.events: list[tuple[str, str]] = []

    def warn(self, code: str, msg: str = "") -> None:
        self.events.append((code, msg))

    def debug(self, code: str, msg: str = "") -> None:
        self.events.append((code, msg))

    def codes(self) -> list[str]:
        return [c for c, _ in self.events]


def test_merge_streams_uses_recovered_and_logs_audit_event(tmp_path: Path):
    """End-to-end: write distinct content into the original (corrupt
    in production but here just different) and recovered files, then
    confirm `merge_streams` yields the recovered content and emits the
    `REPLAY_USING_RECOVERED` audit log."""
    suffix = "underlying_ticks.ndjson.gz"
    original  = tmp_path / f"{_INSTRUMENT}_{suffix}"
    recovered = tmp_path / f"{_INSTRUMENT}_underlying_ticks.recovered.ndjson.gz"
    _write_gz_lines(original,  [{"recv_ts": "T1", "src": "original"}])
    _write_gz_lines(recovered, [{"recv_ts": "T1", "src": "recovered"}])

    # Other two streams: only originals so we don't over-trigger the
    # audit log; the test asserts exactly one REPLAY_USING_RECOVERED.
    _write_gz_lines(tmp_path / f"{_INSTRUMENT}_option_ticks.ndjson.gz",
                    [{"recv_ts": "T2"}])
    _write_gz_lines(tmp_path / f"{_INSTRUMENT}_chain_snapshots.ndjson.gz",
                    [{"recv_ts": "T3"}])

    logger = _FakeLogger()
    events = list(merge_streams(tmp_path, _INSTRUMENT, logger=logger))

    # Underlying tick should have come from the recovered file
    underlying = [e for e in events if e["type"] == "underlying_tick"]
    assert len(underlying) == 1
    assert underlying[0]["data"]["src"] == "recovered"

    # Exactly one REPLAY_USING_RECOVERED audit event for the one stream
    # that fell back. The other two original-only streams must NOT trip it.
    assert logger.codes().count("REPLAY_USING_RECOVERED") == 1


def test_merge_streams_no_audit_event_when_only_originals(tmp_path: Path):
    """Clean date — every stream is the canonical original. No
    audit-log noise should be emitted."""
    for suffix, ts in zip(_FILE_SUFFIXES, ("T1", "T2", "T3")):
        _write_gz_lines(tmp_path / f"{_INSTRUMENT}_{suffix}",
                        [{"recv_ts": ts}])

    logger = _FakeLogger()
    events = list(merge_streams(tmp_path, _INSTRUMENT, logger=logger))

    assert len(events) == 3
    assert "REPLAY_USING_RECOVERED" not in logger.codes()


def test_merge_streams_warns_when_no_files_present(tmp_path: Path):
    """When neither original nor recovered exists, emit the existing
    REPLAY_STREAM_EMPTY warning per stream and yield nothing."""
    logger = _FakeLogger()
    events = list(merge_streams(tmp_path, _INSTRUMENT, logger=logger))
    assert events == []
    # One warning per missing stream
    assert logger.codes().count("REPLAY_STREAM_EMPTY") == 3
