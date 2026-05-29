"""
tests/test_prediction_logger.py — T41 schema + logger contract tests.

Covers the on-disk shape and round-trip behaviour the
outcome_backfiller + T34 weekly report rely on:

  - parse_lookahead_seconds across the head-name shapes the engine emits
  - feature_snapshot_hash determinism + NaN-stability
  - build_arrow_table column order + nullability
  - PredictionLogger queue + chunk flush + finalise merge
  - Resume across process restart picks up the next prediction_id
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

from _shared.prediction_schema import (
    ARROW_SCHEMA,
    COLUMNS,
    PredictionRow,
    build_arrow_table,
    feature_snapshot_hash,
    parse_lookahead_seconds,
)
from signal_engine_agent.prediction_logger import PredictionLogger


# ── Schema helpers ──────────────────────────────────────────────────────────


def test_parse_lookahead_seconds_trailing_window():
    assert parse_lookahead_seconds("direction_30s") == 30
    assert parse_lookahead_seconds("max_drawdown_pe_120s") == 120
    assert parse_lookahead_seconds("breakout_in_300s") == 300
    assert parse_lookahead_seconds("direction_persists_240s") == 240


def test_parse_lookahead_seconds_embedded_window():
    # direction_30s_magnitude has the window in the middle, not at the end.
    assert parse_lookahead_seconds("direction_30s_magnitude") == 30


def test_parse_lookahead_seconds_no_window_returns_minus_one():
    # The session-rank column has no model-target window — outcome
    # backfiller treats -1 as "no outcome row needed".
    assert parse_lookahead_seconds("upside_percentile_30s") == 30
    assert parse_lookahead_seconds("not_a_target") == -1


def test_feature_snapshot_hash_deterministic_across_calls():
    vec = np.array([1.0, 2.0, 3.0, 4.0, 5.0], dtype=np.float64)
    h1 = feature_snapshot_hash(vec)
    h2 = feature_snapshot_hash(vec)
    assert h1 == h2
    assert len(h1) == 16  # 8-byte digest -> 16 hex chars


def test_feature_snapshot_hash_nan_stable():
    """NaN != NaN under IEEE; the hash must coerce NaN to a fixed
    sentinel so two NaN-equal vectors hash the same."""
    a = np.array([1.0, float("nan"), 3.0], dtype=np.float64)
    b = np.array([1.0, float("nan"), 3.0], dtype=np.float64)
    assert feature_snapshot_hash(a) == feature_snapshot_hash(b)


def test_feature_snapshot_hash_differs_on_value_change():
    a = np.array([1.0, 2.0, 3.0], dtype=np.float64)
    b = np.array([1.0, 2.0, 3.5], dtype=np.float64)
    assert feature_snapshot_hash(a) != feature_snapshot_hash(b)


def test_build_arrow_table_column_order_matches_schema():
    rows = [PredictionRow(
        prediction_id=1, ts_ns=1_700_000_000_000_000_000,
        instrument="nifty50", head_name="direction_30s",
        head_type=None,
        raw_prob=0.55, calibrated_prob=0.58,
        gate_decision="WAIT", regime_tag=None,
        feature_snapshot_hash="deadbeef12345678",
        lookahead_seconds=30,
    )]
    tbl = build_arrow_table(rows)
    assert tbl.column_names == list(COLUMNS)
    assert tbl.schema.equals(ARROW_SCHEMA)
    assert len(tbl) == 1


def test_build_arrow_table_outcome_cols_null_at_log_time():
    rows = [PredictionRow(
        prediction_id=1, ts_ns=1, instrument="i", head_name="h",
        head_type=None, raw_prob=0.0, calibrated_prob=0.0,
        gate_decision="WAIT", regime_tag=None,
        feature_snapshot_hash="0" * 16, lookahead_seconds=30,
    )]
    tbl = build_arrow_table(rows)
    # outcome_direction is nullable int8, outcome_magnitude is f64 NaN
    direction_col = tbl.column("outcome_direction").to_pylist()
    magnitude_col = tbl.column("outcome_magnitude").to_pylist()
    assert direction_col == [None]
    assert math.isnan(magnitude_col[0])


def test_build_arrow_table_empty_input_returns_empty_table():
    tbl = build_arrow_table([])
    assert len(tbl) == 0
    assert tbl.schema.equals(ARROW_SCHEMA)


# ── PredictionLogger ────────────────────────────────────────────────────────


def _make_logger(tmp_path: Path, **kwargs) -> PredictionLogger:
    return PredictionLogger(
        instrument="nifty50",
        date_str="2026-05-28",
        predictions_root=tmp_path / "predictions",
        **kwargs,
    )


def test_logger_log_eval_queues_one_row_per_head(tmp_path: Path):
    logger = _make_logger(tmp_path)
    n = logger.log_eval(
        ts_ns=1_700_000_000_000_000_000,
        feature_vec=np.array([1.0, 2.0, 3.0]),
        raw_preds={"direction_30s": 0.55, "max_upside_30s": 12.0},
        calibrated_preds={"direction_30s": 0.58, "max_upside_30s": 12.0},
        gate_decision="WAIT",
        regime_tag=None,
    )
    assert n == 2


def test_logger_chunk_flush_writes_atomic_parquet(tmp_path: Path):
    """Log enough rows to trigger a flush, verify parquet written."""
    logger = _make_logger(tmp_path, chunk_rows=3)
    for i in range(5):
        logger.log_eval(
            ts_ns=1_700_000_000_000_000_000 + i,
            feature_vec=np.array([float(i)]),
            raw_preds={"direction_30s": 0.5 + i * 0.01},
            calibrated_preds={"direction_30s": 0.5 + i * 0.01},
            gate_decision="WAIT",
            regime_tag=None,
        )
    out_dir = tmp_path / "predictions" / "2026-05-28"
    chunks = sorted(out_dir.glob("nifty50_predictions_part*.parquet"))
    # 5 rows / 3-row chunks -> at least 1 chunk written
    assert len(chunks) >= 1
    # Atomic write: no leftover .tmp files
    tmps = list(out_dir.glob("*.tmp"))
    assert tmps == []


def test_logger_finalise_merges_chunks(tmp_path: Path):
    logger = _make_logger(tmp_path, chunk_rows=2)
    for i in range(5):
        logger.log_eval(
            ts_ns=1_700_000_000_000_000_000 + i,
            feature_vec=np.array([float(i)]),
            raw_preds={"direction_30s": float(i)},
            calibrated_preds={"direction_30s": float(i)},
            gate_decision="WAIT",
            regime_tag=None,
        )
    final_path = logger.finalise()
    assert final_path is not None
    assert final_path.exists()
    # Chunks deleted
    out_dir = tmp_path / "predictions" / "2026-05-28"
    chunks = list(out_dir.glob("nifty50_predictions_part*.parquet"))
    assert chunks == []
    # Final has all 5 rows
    tbl = pq.read_table(final_path)
    assert len(tbl) == 5
    # prediction_ids should be 1..5 in order
    ids = tbl.column("prediction_id").to_pylist()
    assert ids == [1, 2, 3, 4, 5]


def test_logger_resume_picks_up_next_prediction_id(tmp_path: Path):
    """If a prior process left chunks on disk, a new logger instance
    must continue the prediction_id sequence (not restart at 1)."""
    logger1 = _make_logger(tmp_path, chunk_rows=2)
    for i in range(3):
        logger1.log_eval(
            ts_ns=1_700_000_000_000_000_000 + i,
            feature_vec=np.array([float(i)]),
            raw_preds={"direction_30s": float(i)},
            calibrated_preds={"direction_30s": float(i)},
            gate_decision="WAIT",
            regime_tag=None,
        )
    logger1.flush()
    # Simulate a fresh process: instantiate a new logger pointed at the
    # same output dir.
    logger2 = _make_logger(tmp_path, chunk_rows=2)
    n = logger2.log_eval(
        ts_ns=1_800_000_000_000_000_000,
        feature_vec=np.array([99.0]),
        raw_preds={"direction_30s": 0.7},
        calibrated_preds={"direction_30s": 0.7},
        gate_decision="LONG_CE",
        regime_tag=None,
    )
    assert n == 1
    final_path = logger2.finalise()
    assert final_path is not None
    tbl = pq.read_table(final_path)
    ids = tbl.column("prediction_id").to_pylist()
    # logger1 wrote ids 1, 2, 3; logger2 must continue at 4
    assert ids[-1] == 4


def test_logger_finalise_no_rows_is_noop(tmp_path: Path):
    logger = _make_logger(tmp_path)
    assert logger.finalise() is None