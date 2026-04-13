"""
tests/test_recorder.py — Unit tests for recorder/ (Phase 13).

Run: python -m pytest python_modules/tick_feature_agent/tests/test_recorder.py -v
"""

from __future__ import annotations

import gzip
import json
import sys
import tempfile
import threading
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG  = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.recorder.writer import NdjsonGzWriter
from tick_feature_agent.recorder.metadata_writer import read_metadata, write_metadata
from tick_feature_agent.recorder.session_recorder import SessionRecorder
from tick_feature_agent.recorder.dashboard_writer import DashboardWriter


# ── Helpers ────────────────────────────────────────────────────────────────────

def _read_gz(path: Path) -> list[dict]:
    """Read all NDJSON records from a .ndjson.gz file."""
    records = []
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


# ══════════════════════════════════════════════════════════════════════════════
# TestNdjsonGzWriter
# ══════════════════════════════════════════════════════════════════════════════

class TestNdjsonGzWriter:

    def test_write_single_record(self, tmp_path):
        path = tmp_path / "test.ndjson.gz"
        writer = NdjsonGzWriter(path)
        writer.write({"a": 1, "b": 2.5})
        writer.close()
        records = _read_gz(path)
        assert len(records) == 1
        assert records[0] == {"a": 1, "b": 2.5}

    def test_write_multiple_records(self, tmp_path):
        path = tmp_path / "test.ndjson.gz"
        with NdjsonGzWriter(path) as writer:
            writer.write({"seq": 1})
            writer.write({"seq": 2})
            writer.write({"seq": 3})
        records = _read_gz(path)
        assert len(records) == 3
        assert [r["seq"] for r in records] == [1, 2, 3]

    def test_appends_on_reopen(self, tmp_path):
        """
        gzip 'at' mode appends — simulate a mid-session restart.
        """
        path = tmp_path / "ticks.ndjson.gz"
        with NdjsonGzWriter(path) as w:
            w.write({"seq": 1})
        with NdjsonGzWriter(path) as w:
            w.write({"seq": 2})
        records = _read_gz(path)
        assert len(records) == 2
        assert records[0]["seq"] == 1
        assert records[1]["seq"] == 2

    def test_roll_file(self, tmp_path):
        path1 = tmp_path / "file1.ndjson.gz"
        path2 = tmp_path / "file2.ndjson.gz"
        writer = NdjsonGzWriter(path1)
        writer.write({"day": 1})
        writer.roll(path2)
        writer.write({"day": 2})
        writer.close()

        assert _read_gz(path1) == [{"day": 1}]
        assert _read_gz(path2) == [{"day": 2}]

    def test_close_idempotent(self, tmp_path):
        path = tmp_path / "test.ndjson.gz"
        writer = NdjsonGzWriter(path)
        writer.write({"x": 1})
        writer.close()
        writer.close()  # should not raise

    def test_write_after_close_returns_false(self, tmp_path):
        path = tmp_path / "test.ndjson.gz"
        writer = NdjsonGzWriter(path)
        writer.close()
        result = writer.write({"x": 1})
        assert result is False

    def test_write_returns_true_on_success(self, tmp_path):
        path = tmp_path / "test.ndjson.gz"
        writer = NdjsonGzWriter(path)
        result = writer.write({"x": 1})
        writer.close()
        assert result is True

    def test_creates_parent_dirs(self, tmp_path):
        path = tmp_path / "sub" / "dir" / "test.ndjson.gz"
        writer = NdjsonGzWriter(path)
        writer.write({"x": 1})
        writer.close()
        assert path.exists()

    def test_path_property(self, tmp_path):
        path = tmp_path / "test.ndjson.gz"
        writer = NdjsonGzWriter(path)
        assert writer.path == path
        writer.close()

    def test_context_manager(self, tmp_path):
        path = tmp_path / "test.ndjson.gz"
        with NdjsonGzWriter(path) as writer:
            writer.write({"x": 99})
        assert _read_gz(path) == [{"x": 99}]

    def test_concurrent_writes_safe(self, tmp_path):
        """
        Multiple threads writing concurrently should not corrupt the file.
        """
        path = tmp_path / "concurrent.ndjson.gz"
        writer = NdjsonGzWriter(path)
        errors = []

        def _write_n(n):
            for i in range(n):
                try:
                    writer.write({"thread_i": i})
                except Exception as e:
                    errors.append(e)

        threads = [threading.Thread(target=_write_n, args=(20,)) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        writer.close()

        assert not errors
        records = _read_gz(path)
        assert len(records) == 100   # 5 threads × 20 records

    def test_non_serializable_uses_default_str(self, tmp_path):
        """Non-JSON-serializable values are converted to str via default=str."""
        path = tmp_path / "test.ndjson.gz"
        from datetime import datetime
        with NdjsonGzWriter(path) as w:
            w.write({"ts": datetime(2026, 4, 14, 9, 15)})
        records = _read_gz(path)
        assert isinstance(records[0]["ts"], str)

    def test_flush_does_not_raise_after_close(self, tmp_path):
        path = tmp_path / "test.ndjson.gz"
        writer = NdjsonGzWriter(path)
        writer.close()
        writer.flush()  # should not raise


# ══════════════════════════════════════════════════════════════════════════════
# TestMetadataWriter
# ══════════════════════════════════════════════════════════════════════════════

class TestMetadataWriter:

    def _instruments(self):
        return {
            "nifty50": {
                "underlying_symbol":      "NIFTY25MAYFUT",
                "underlying_security_id": "13",
                "expiry":                 "2026-04-17",
            }
        }

    def test_write_creates_file(self, tmp_path):
        path = write_metadata(tmp_path, "2026-04-14", self._instruments())
        assert path.exists()

    def test_write_content(self, tmp_path):
        write_metadata(tmp_path, "2026-04-14", self._instruments())
        meta = read_metadata(tmp_path)
        assert meta["date"] == "2026-04-14"
        assert "nifty50" in meta["instruments"]
        assert meta["instruments"]["nifty50"]["expiry"] == "2026-04-17"

    def test_overwrite_on_rollover(self, tmp_path):
        write_metadata(tmp_path, "2026-04-14", self._instruments())
        updated = {"nifty50": {
            "underlying_symbol":      "NIFTY25MAYFUT",
            "underlying_security_id": "13",
            "expiry":                 "2026-04-24",  # new expiry
        }}
        write_metadata(tmp_path, "2026-04-14", updated)
        meta = read_metadata(tmp_path)
        assert meta["instruments"]["nifty50"]["expiry"] == "2026-04-24"

    def test_read_missing_returns_none(self, tmp_path):
        result = read_metadata(tmp_path / "nonexistent")
        assert result is None

    def test_read_corrupt_returns_none(self, tmp_path):
        p = tmp_path / "metadata.json"
        p.write_text("{invalid json", encoding="utf-8")
        result = read_metadata(tmp_path)
        assert result is None

    def test_multi_instrument_metadata(self, tmp_path):
        instruments = {
            "nifty50":   {"underlying_symbol": "NIFTY25MAYFUT",     "underlying_security_id": "13",  "expiry": "2026-04-17"},
            "crudeoil":  {"underlying_symbol": "CRUDEOIL25MAYFUT",  "underlying_security_id": "486502", "expiry": "2026-04-16"},
        }
        write_metadata(tmp_path, "2026-04-14", instruments)
        meta = read_metadata(tmp_path)
        assert "nifty50" in meta["instruments"]
        assert "crudeoil" in meta["instruments"]


# ══════════════════════════════════════════════════════════════════════════════
# TestSessionRecorder
# ══════════════════════════════════════════════════════════════════════════════

_INSTRUMENT = "nifty50"

_UNDERLYING_TICK = {
    "security_id": "13",
    "ltp": 24100.0, "bid": 24099.5, "ask": 24100.5,
    "bid_qty": 120, "ask_qty": 85,
    "volume": 3, "cumulative_volume": 1245300,
    "oi": 0, "ltt": 1744342501,
}

_OPTION_TICK = {
    "security_id": "100123",
    "expiry": "2026-04-17",
    "strike": 24100, "opt_type": "CE",
    "ltp": 85.5, "bid": 85.0, "ask": 86.0,
    "bid_qty": 50, "ask_qty": 40,
    "volume": 2, "cumulative_volume": 48200,
    "oi": 12000, "ltt": 1744342501,
}

_CHAIN_SNAPSHOT = {
    "expiry": "2026-04-17",
    "spot": 24100.0,
    "strikes": [
        {"strike": 24100, "call_oi": 45000, "put_oi": 38000,
         "call_delta_oi": 200, "put_delta_oi": -150,
         "call_ltp": 85.5, "put_ltp": 78.0}
    ],
}


class TestSessionRecorder:

    def _make_recorder(self, tmp_path):
        return SessionRecorder(
            instrument=_INSTRUMENT,
            data_root=tmp_path / "data" / "raw",
            underlying_symbol="NIFTY25MAYFUT",
            underlying_security_id="13",
            expiry="2026-04-17",
        )

    def test_session_open_creates_files(self, tmp_path):
        rec = self._make_recorder(tmp_path)
        rec.on_session_open("2026-04-14")
        rec.on_session_close()
        date_dir = tmp_path / "data" / "raw" / "2026-04-14"
        assert (date_dir / "nifty50_underlying_ticks.ndjson.gz").exists()
        assert (date_dir / "nifty50_option_ticks.ndjson.gz").exists()
        assert (date_dir / "nifty50_chain_snapshots.ndjson.gz").exists()

    def test_metadata_written_on_open(self, tmp_path):
        rec = self._make_recorder(tmp_path)
        rec.on_session_open("2026-04-14")
        rec.on_session_close()
        meta = read_metadata(tmp_path / "data" / "raw" / "2026-04-14")
        assert meta is not None
        assert meta["instruments"][_INSTRUMENT]["expiry"] == "2026-04-17"

    def test_record_underlying_tick(self, tmp_path):
        rec = self._make_recorder(tmp_path)
        rec.on_session_open("2026-04-14")
        rec.record_underlying_tick(dict(_UNDERLYING_TICK))
        rec.on_session_close()
        path = tmp_path / "data" / "raw" / "2026-04-14" / "nifty50_underlying_ticks.ndjson.gz"
        records = _read_gz(path)
        assert len(records) == 1
        assert records[0]["ltp"] == 24100.0
        assert "recv_ts" in records[0]

    def test_record_option_tick(self, tmp_path):
        rec = self._make_recorder(tmp_path)
        rec.on_session_open("2026-04-14")
        rec.record_option_tick(dict(_OPTION_TICK))
        rec.on_session_close()
        path = tmp_path / "data" / "raw" / "2026-04-14" / "nifty50_option_ticks.ndjson.gz"
        records = _read_gz(path)
        assert len(records) == 1
        assert records[0]["strike"] == 24100

    def test_record_chain_snapshot(self, tmp_path):
        rec = self._make_recorder(tmp_path)
        rec.on_session_open("2026-04-14")
        rec.record_chain_snapshot(dict(_CHAIN_SNAPSHOT))
        rec.on_session_close()
        path = tmp_path / "data" / "raw" / "2026-04-14" / "nifty50_chain_snapshots.ndjson.gz"
        records = _read_gz(path)
        assert len(records) == 1
        assert records[0]["spot"] == 24100.0

    def test_counts_tracked(self, tmp_path):
        rec = self._make_recorder(tmp_path)
        rec.on_session_open("2026-04-14")
        rec.record_underlying_tick(dict(_UNDERLYING_TICK))
        rec.record_underlying_tick(dict(_UNDERLYING_TICK))
        rec.record_option_tick(dict(_OPTION_TICK))
        rec.record_chain_snapshot(dict(_CHAIN_SNAPSHOT))
        assert rec.counts["underlying_ticks"] == 2
        assert rec.counts["option_ticks"] == 1
        assert rec.counts["chain_snapshots"] == 1
        rec.on_session_close()

    def test_recv_ts_added_if_missing(self, tmp_path):
        rec = self._make_recorder(tmp_path)
        rec.on_session_open("2026-04-14")
        tick = {"ltp": 24100.0}  # no recv_ts
        rec.record_underlying_tick(tick)
        rec.on_session_close()
        path = tmp_path / "data" / "raw" / "2026-04-14" / "nifty50_underlying_ticks.ndjson.gz"
        records = _read_gz(path)
        assert "recv_ts" in records[0]

    def test_recv_ts_not_overwritten_if_present(self, tmp_path):
        rec = self._make_recorder(tmp_path)
        rec.on_session_open("2026-04-14")
        tick = {"recv_ts": "custom_ts", "ltp": 24100.0}
        rec.record_underlying_tick(tick)
        rec.on_session_close()
        path = tmp_path / "data" / "raw" / "2026-04-14" / "nifty50_underlying_ticks.ndjson.gz"
        records = _read_gz(path)
        assert records[0]["recv_ts"] == "custom_ts"

    def test_expiry_rollover_updates_metadata(self, tmp_path):
        rec = self._make_recorder(tmp_path)
        rec.on_session_open("2026-04-17")
        rec.on_expiry_rollover(new_expiry="2026-04-24")
        rec.on_session_close()
        meta = read_metadata(tmp_path / "data" / "raw" / "2026-04-17")
        assert meta["instruments"][_INSTRUMENT]["expiry"] == "2026-04-24"

    def test_restart_append(self, tmp_path):
        """Simulate mid-session restart — second recorder appends to existing files."""
        rec1 = self._make_recorder(tmp_path)
        rec1.on_session_open("2026-04-14")
        rec1.record_underlying_tick(dict(_UNDERLYING_TICK))
        rec1.on_session_close()

        rec2 = self._make_recorder(tmp_path)
        rec2.on_session_open("2026-04-14")
        rec2.record_underlying_tick(dict(_UNDERLYING_TICK))
        rec2.on_session_close()

        path = tmp_path / "data" / "raw" / "2026-04-14" / "nifty50_underlying_ticks.ndjson.gz"
        records = _read_gz(path)
        assert len(records) == 2

    def test_record_before_session_open_is_noop(self, tmp_path):
        """Recording before on_session_open should not raise."""
        rec = self._make_recorder(tmp_path)
        rec.record_underlying_tick(dict(_UNDERLYING_TICK))  # no-op
        assert rec.counts["underlying_ticks"] == 0


# ══════════════════════════════════════════════════════════════════════════════
# TestDashboardWriter
# ══════════════════════════════════════════════════════════════════════════════

class TestDashboardWriter:

    def test_write_creates_file(self, tmp_path):
        writer = DashboardWriter("nifty50", output_dir=tmp_path)
        writer.update({"spot": 24100.0, "strikes": []})
        # Allow daemon thread to finish
        time.sleep(0.2)
        assert (tmp_path / "option_chain_nifty50.json").exists()

    def test_write_overwrites(self, tmp_path):
        writer = DashboardWriter("nifty50", output_dir=tmp_path)
        writer.update({"spot": 24100.0})
        time.sleep(0.1)
        writer.update({"spot": 24200.0})
        time.sleep(0.2)
        content = json.loads((tmp_path / "option_chain_nifty50.json").read_text())
        assert content["spot"] == 24200.0

    def test_path_property(self, tmp_path):
        writer = DashboardWriter("crudeoil", output_dir=tmp_path)
        assert writer.path == tmp_path / "option_chain_crudeoil.json"
