"""
tests/test_validator.py — Unit tests for validation/feature_validator.py (Phase 15).

Run: python -m pytest python_modules/tick_feature_agent/tests/test_validator.py -v
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG  = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.output.emitter import (
    COLUMN_NAMES,
    Emitter,
    assemble_flat_vector,
)
from tick_feature_agent.validation.feature_validator import (
    validate,
    _layer1_structural,
    _layer2_null_rates,
    _layer3_statistical,
    _null_rate,
)


# ── Helpers ────────────────────────────────────────────────────────────────────

_NAN = float("nan")


def _make_parquet(tmp_path: Path, rows: list[dict], filename="nifty50_features.parquet") -> Path:
    """Write a minimal Parquet file with the given rows."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    path = tmp_path / filename
    if rows:
        table = pa.Table.from_pylist(rows)
    else:
        table = pa.table({col: pa.array([], type=pa.float32()) for col in COLUMN_NAMES})
    pq.write_table(table, path)
    return path


def _minimal_row(ts: float = 1_000_000.0) -> dict:
    """Build a minimal 370-column row with all NaN floats."""
    row = {}
    for col in COLUMN_NAMES:
        row[col] = _NAN
    row["timestamp"] = ts
    row["underlying_security_id"] = "13"
    row["trading_state"] = "TRADING"
    row["regime"] = "NEUTRAL"
    row["stale_reason"] = None
    row["underlying_trade_direction"] = 1
    row["trading_allowed"] = 1
    row["chain_available"] = 1
    row["data_quality_flag"] = 1
    row["is_market_open"] = 1
    return row


def _rows_with_increasing_ts(n: int) -> list[dict]:
    return [_minimal_row(ts=float(i * 1000)) for i in range(1, n + 1)]


# ══════════════════════════════════════════════════════════════════════════════
# TestNullRate
# ══════════════════════════════════════════════════════════════════════════════

class TestNullRate:

    def test_all_null(self):
        assert _null_rate([None, float("nan"), None]) == pytest.approx(1.0)

    def test_no_null(self):
        assert _null_rate([1.0, 2.0, 3.0]) == pytest.approx(0.0)

    def test_half_null(self):
        assert _null_rate([1.0, None, 2.0, float("nan")]) == pytest.approx(0.5)

    def test_empty(self):
        assert _null_rate([]) == 0.0


# ══════════════════════════════════════════════════════════════════════════════
# TestLayer1Structural
# ══════════════════════════════════════════════════════════════════════════════

class TestLayer1Structural:

    def test_pass_on_valid(self):
        result = _layer1_structural(
            df_cols=list(COLUMN_NAMES),
            n_rows=100,
            ts_col=[float(i) for i in range(100)],
            security_ids=["13"] * 100,
            expected_cols=COLUMN_NAMES,
        )
        assert result["verdict"] == "PASS"

    def test_fail_wrong_column_count(self):
        result = _layer1_structural(
            df_cols=list(COLUMN_NAMES[:369]),  # one missing
            n_rows=100,
            ts_col=[float(i) for i in range(100)],
            security_ids=["13"] * 100,
            expected_cols=COLUMN_NAMES,
        )
        assert result["verdict"] == "FAIL"
        assert "column_count" in result["checks"]

    def test_fail_zero_rows(self):
        result = _layer1_structural(
            df_cols=list(COLUMN_NAMES),
            n_rows=0,
            ts_col=[],
            security_ids=[],
            expected_cols=COLUMN_NAMES,
        )
        assert result["verdict"] == "FAIL"
        assert "row_count" in result["checks"]

    def test_fail_out_of_order_timestamps(self):
        result = _layer1_structural(
            df_cols=list(COLUMN_NAMES),
            n_rows=5,
            ts_col=[1.0, 2.0, 0.5, 4.0, 5.0],  # t=0.5 is out of order
            security_ids=["13"] * 5,
            expected_cols=COLUMN_NAMES,
        )
        assert result["verdict"] == "FAIL"
        assert "timestamp_ordering" in result["checks"]

    def test_fail_duplicate_rows(self):
        result = _layer1_structural(
            df_cols=list(COLUMN_NAMES),
            n_rows=3,
            ts_col=[1.0, 1.0, 2.0],           # duplicate timestamp
            security_ids=["13", "13", "13"],   # + same security_id → duplicate pair
            expected_cols=COLUMN_NAMES,
        )
        assert result["verdict"] == "FAIL"

    def test_duplicate_pair_different_security_id_is_ok(self):
        """Same timestamp, different security_id → NOT a duplicate."""
        result = _layer1_structural(
            df_cols=list(COLUMN_NAMES),
            n_rows=2,
            ts_col=[1.0, 1.0],
            security_ids=["13", "14"],  # different IDs
            expected_cols=COLUMN_NAMES,
        )
        # Should not fail for duplicates (though may fail for ordering)
        assert "no_duplicates" not in result["checks"] or \
               result["checks"].get("no_duplicates", "PASS").startswith("PASS")


# ══════════════════════════════════════════════════════════════════════════════
# TestLayer2NullRates
# ══════════════════════════════════════════════════════════════════════════════

class TestLayer2NullRates:

    def test_pass_when_no_nulls(self):
        columns = {
            "underlying_ltp": [24100.0] * 100,
            "chain_pcr_global": [1.2] * 100,
            "regime": ["NEUTRAL"] * 100,
        }
        result = _layer2_null_rates(columns, 100)
        assert result["verdict"] == "PASS"

    def test_warn_on_moderate_null_rate(self):
        # 5% nulls — between 2% and 10% thresholds
        vals = [None] * 5 + [24100.0] * 95
        result = _layer2_null_rates({"underlying_ltp": vals}, 100)
        assert result["verdict"] in ("WARN", "FAIL")  # above 2% warn threshold

    def test_fail_on_high_null_rate(self):
        # 15% nulls
        vals = [None] * 15 + [24100.0] * 85
        result = _layer2_null_rates({"underlying_ltp": vals}, 100)
        assert result["verdict"] == "FAIL"

    def test_zero_rows_pass(self):
        result = _layer2_null_rates({}, 0)
        assert result["verdict"] == "PASS"


# ══════════════════════════════════════════════════════════════════════════════
# TestLayer3Statistical
# ══════════════════════════════════════════════════════════════════════════════

class TestLayer3Statistical:

    def test_pcr_always_1_fail(self):
        result = _layer3_statistical({"chain_pcr_global": [1.0] * 100}, 100)
        assert result["verdict"] == "FAIL"
        assert "chain_pcr_global" in result["checks"]
        assert result["checks"]["chain_pcr_global"].startswith("FAIL")

    def test_regime_always_same_warn(self):
        result = _layer3_statistical({"regime": ["NEUTRAL"] * 100}, 100)
        assert result["verdict"] in ("WARN", "FAIL")

    def test_data_quality_flag_mostly_zero_fail(self):
        result = _layer3_statistical(
            {"data_quality_flag": [0] * 70 + [1] * 30}, 100
        )
        assert result["verdict"] == "FAIL"

    def test_breakout_readiness_out_of_range_fail(self):
        result = _layer3_statistical(
            {"breakout_readiness": [1.5] * 10 + [0.5] * 90}, 100
        )
        assert result["verdict"] == "FAIL"

    def test_underlying_trade_direction_always_zero_fail(self):
        result = _layer3_statistical(
            {"underlying_trade_direction": [0] * 100}, 100
        )
        assert result["verdict"] == "FAIL"

    def test_pass_for_clean_data(self):
        result = _layer3_statistical(
            {
                "chain_pcr_global": [0.8 + 0.01 * i for i in range(100)],  # varies
                "regime": (["TREND"] * 40 + ["RANGE"] * 40 + ["DEAD"] * 20),
                "data_quality_flag": [1] * 100,
                "underlying_trade_direction": [1 if i % 3 else -1 for i in range(100)],
                "breakout_readiness": [0.1 * (i % 10) for i in range(100)],
            },
            100,
        )
        assert result["verdict"] == "PASS"


# ══════════════════════════════════════════════════════════════════════════════
# TestEmitterReplayMode
# ══════════════════════════════════════════════════════════════════════════════

class TestEmitterReplayMode:

    def test_replay_mode_accumulates_rows(self):
        em = Emitter(mode="replay")
        for i in range(5):
            em.emit({"col": i})
        assert em.row_count == 5

    def test_live_mode_row_count_zero(self):
        em = Emitter(mode="live")
        assert em.row_count == 0
        em.close()

    def test_replay_mode_not_live(self, tmp_path):
        """Replay mode should NOT write to NDJSON file."""
        out_file = tmp_path / "test.ndjson"
        # When mode=replay, file_path arg is ignored
        em = Emitter(file_path=str(out_file), mode="replay")
        em.emit({"x": 1})
        # File should not exist in replay mode
        assert not out_file.exists()

    def test_write_parquet_creates_file(self, tmp_path):
        em = Emitter(mode="replay")
        row = _minimal_row()
        em.emit(row)
        path = tmp_path / "features.parquet"
        em.write_parquet(path)
        assert path.exists()

    def test_write_parquet_correct_row_count(self, tmp_path):
        import pyarrow.parquet as pq
        em = Emitter(mode="replay")
        for i in range(3):
            em.emit(_minimal_row(ts=float(i)))
        path = tmp_path / "features.parquet"
        em.write_parquet(path)
        table = pq.read_table(path)
        assert table.num_rows == 3

    def test_write_parquet_clears_buffer(self, tmp_path):
        em = Emitter(mode="replay")
        em.emit(_minimal_row())
        em.write_parquet(tmp_path / "f.parquet")
        assert em.row_count == 0

    def test_write_parquet_raises_in_live_mode(self, tmp_path):
        em = Emitter(mode="live")
        with pytest.raises(RuntimeError, match="replay mode"):
            em.write_parquet(tmp_path / "f.parquet")
        em.close()

    def test_write_parquet_empty_is_ok(self, tmp_path):
        import pyarrow.parquet as pq
        em = Emitter(mode="replay")
        path = tmp_path / "empty.parquet"
        em.write_parquet(path)
        assert path.exists()


# ══════════════════════════════════════════════════════════════════════════════
# TestValidateEndToEnd
# ══════════════════════════════════════════════════════════════════════════════

class TestValidateEndToEnd:

    def test_pass_on_good_data(self, tmp_path):
        import pyarrow as pa
        import pyarrow.parquet as pq

        rows = _rows_with_increasing_ts(100)
        for row in rows:
            row["underlying_ltp"] = 24100.0
            row["underlying_trade_direction"] = 1
            row["regime"] = "NEUTRAL"
            row["chain_pcr_global"] = 1.2
            row["data_quality_flag"] = 1
            row["breakout_readiness"] = 0.5

        path = _make_parquet(tmp_path, rows)
        result = validate(path, "nifty50", "2026-04-14", output_dir=tmp_path)
        assert result["total_rows"] == 100
        assert result["instrument"] == "nifty50"
        assert result["date"] == "2026-04-14"
        # Layer 1 should pass (correct column count etc.)
        assert result["layers"]["structural"]["verdict"] == "PASS"

    def test_writes_output_json(self, tmp_path):
        rows = _rows_with_increasing_ts(10)
        path = _make_parquet(tmp_path, rows)
        validate(path, "nifty50", "2026-04-14", output_dir=tmp_path)
        assert (tmp_path / "nifty50_validation.json").exists()

    def test_output_json_is_valid(self, tmp_path):
        rows = _rows_with_increasing_ts(10)
        path = _make_parquet(tmp_path, rows)
        validate(path, "nifty50", "2026-04-14", output_dir=tmp_path)
        data = json.loads((tmp_path / "nifty50_validation.json").read_text())
        assert "verdict" in data
        assert "layers" in data
        assert "daily_stats" in data

    def test_fail_on_missing_columns(self, tmp_path):
        import pyarrow as pa
        import pyarrow.parquet as pq
        # Write only 5 columns — clearly wrong schema
        table = pa.table({"col1": [1.0], "col2": [2.0]})
        path = tmp_path / "bad.parquet"
        pq.write_table(table, path)
        result = validate(path, "nifty50", "2026-04-14", output_dir=tmp_path)
        assert result["verdict"] == "FAIL"
        assert result["layers"]["structural"]["verdict"] == "FAIL"
