"""
test_recover_gz.py — Phase E6 lock for the PY-128 'recovered ≥ existing'
line-count guard in `scripts/recover_gz.py`.

Run: python -m pytest scripts/test_recover_gz.py -v
"""

from __future__ import annotations

import gzip
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import pytest
import recover_gz


def _write_gz(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wb") as g:
        g.write(body)


def _make_source_with_lines(path: Path, n_lines: int) -> None:
    """Write a clean `.ndjson.gz` with `n_lines` lines. The line-count
    guard test uses these — `_recover_one` doesn't run integrity checks
    itself (those live in `main()` ahead of it), so a clean gzip is the
    correct fixture for exercising the guard logic in isolation."""
    body = b"".join(b'{"i":' + str(i).encode() + b"}\n" for i in range(n_lines))
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wb") as g:
        g.write(body)


def test_count_lines_gz_returns_correct_count(tmp_path: Path):
    p = tmp_path / "good.ndjson.gz"
    _write_gz(p, b'{"a":1}\n{"b":2}\n{"c":3}\n')
    assert recover_gz._count_lines_gz(p) == 3


def test_count_lines_gz_returns_none_for_unreadable(tmp_path: Path):
    p = tmp_path / "broken.ndjson.gz"
    p.write_bytes(b"not a gzip stream")
    assert recover_gz._count_lines_gz(p) is None


def test_count_lines_gz_returns_none_for_missing(tmp_path: Path):
    assert recover_gz._count_lines_gz(tmp_path / "absent.ndjson.gz") is None


def test_recovery_keeps_existing_when_new_has_fewer_lines(
    tmp_path: Path, capsys: pytest.CaptureFixture
):
    """Simulate: prior run captured 100 lines into .recovered.ndjson.gz.
    A re-run only manages to recover 50 (e.g. source corruption worsened
    between runs). The guard must keep the 100-line file and emit a
    stderr warning. PY-128."""
    src = tmp_path / "nifty50_underlying_ticks.ndjson.gz"
    out = tmp_path / "nifty50_underlying_ticks.recovered.ndjson.gz"

    # Existing recovered file = high-water mark of 100 lines.
    _make_source_with_lines(out, 100)
    # New "source" only carries 50 lines.
    _make_source_with_lines(src, 50)
    # Bump src mtime so the up-to-date skip doesn't short-circuit.
    import os
    import time

    os.utime(src, (time.time(), time.time() + 10))

    result = recover_gz._recover_one(src, force=False)

    assert result["status"] == "kept_existing"
    assert result["existing_lines"] == 100
    assert result["lines"] == 50
    # Existing file must be untouched.
    assert recover_gz._count_lines_gz(out) == 100

    err = capsys.readouterr().err
    assert "WARN" in err
    assert "keeping existing" in err


def test_recovery_overwrites_when_new_has_more_lines(tmp_path: Path):
    """Inverse case: re-running recovery captured *more* data than before
    (e.g. recovery logic improved, or earlier run was the one that hit
    the corruption). The guard must NOT block the write."""
    src = tmp_path / "nifty50_option_ticks.ndjson.gz"
    out = tmp_path / "nifty50_option_ticks.recovered.ndjson.gz"

    _make_source_with_lines(out, 10)  # existing low-water file
    _make_source_with_lines(src, 100)  # new run captures more
    import os
    import time

    os.utime(src, (time.time(), time.time() + 10))

    result = recover_gz._recover_one(src, force=False)

    assert result["status"] == "recovered"
    assert result["lines"] == 100
    assert recover_gz._count_lines_gz(out) == 100


def test_recovery_writes_when_no_existing_recovered(tmp_path: Path):
    """First-time recovery: no existing .recovered.ndjson.gz, so the
    guard has nothing to compare against — write the new file."""
    src = tmp_path / "nifty50_chain_snapshots.ndjson.gz"
    out = tmp_path / "nifty50_chain_snapshots.recovered.ndjson.gz"

    _make_source_with_lines(src, 20)

    assert not out.exists()
    result = recover_gz._recover_one(src, force=False)
    assert result["status"] == "recovered"
    assert out.exists()
    assert recover_gz._count_lines_gz(out) == 20
