"""
tests/test_outcome_backfiller.py — T41 backfiller correctness.

Drives the backfiller against synthetic predictions + synthetic
underlying-tick streams. The math being tested:

  - spot_at_t0 = nearest tick at-or-before t0
  - window = (t0, t0 + lookahead_seconds * 1e9] ticks
  - end_spot, max_spot, min_spot computed on the window
  - outcome_direction = sign(end_spot - spot_at_t0) bucketed to {-1, 0, +1}
  - outcome_magnitude = end_spot - spot_at_t0
  - outcome_max_excursion = max_spot - spot_at_t0
  - outcome_max_drawdown = spot_at_t0 - min_spot
  - rows whose lookahead extends past end-of-stream stay NaN
"""

from __future__ import annotations

import gzip
import json
import math
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

from signal_engine_agent.outcome_backfiller import backfill
from signal_engine_agent.prediction_logger import PredictionLogger


# ── Test-data builders ──────────────────────────────────────────────────────


def _write_synthetic_ticks(
    raw_root: Path, instrument: str, date_str: str,
    ts_offsets_ns: list[int], spots: list[float],
    base_ts_ns: int = 1_700_000_000_000_000_000,
) -> None:
    """Write a synthetic underlying_ticks.ndjson.gz the backfiller can read.

    ``ts_offsets_ns`` are nanosecond offsets from ``base_ts_ns``.
    The recorded ``recv_ts`` is an ISO-format string at second-precision
    + an explicit microsecond suffix so the parser's
    ``datetime.fromisoformat`` round-trip is lossless to the offset.
    """
    date_folder = raw_root / date_str
    date_folder.mkdir(parents=True, exist_ok=True)
    path = date_folder / f"{instrument}_underlying_ticks.ndjson.gz"
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for offset, ltp in zip(ts_offsets_ns, spots):
            ts_ns = base_ts_ns + offset
            # Convert ts_ns -> ISO string the recorder's format.
            # `datetime.fromtimestamp(ts/1e9, tz)` then isoformat is the
            # reverse of the backfiller's parser.
            from datetime import datetime, timezone
            dt = datetime.fromtimestamp(ts_ns / 1e9, tz=timezone.utc)
            recv_ts = dt.isoformat(timespec="microseconds")
            f.write(json.dumps({"recv_ts": recv_ts, "ltp": ltp}) + "\n")


def _log_predictions(
    predictions_root: Path, instrument: str, date_str: str,
    ts_ns_list: list[int], head_names: list[str],
) -> Path:
    """Log one prediction per (ts, head_name) pair via PredictionLogger
    and finalise. Returns the final parquet path."""
    logger = PredictionLogger(
        instrument=instrument, date_str=date_str,
        predictions_root=predictions_root,
    )
    feat = np.array([1.0, 2.0, 3.0])
    for ts in ts_ns_list:
        # Build a dict with as many heads as requested.
        preds = {h: 0.5 for h in head_names}
        logger.log_eval(
            ts_ns=ts, feature_vec=feat,
            raw_preds=preds, calibrated_preds=preds,
            gate_decision="WAIT", regime_tag=None,
        )
    p = logger.finalise()
    assert p is not None
    return p


# ── Tests ───────────────────────────────────────────────────────────────────


_BASE_NS = 1_700_000_000_000_000_000  # 2023-11-14 22:13:20 UTC


def test_smooth_uptrend_outcomes_match_manual_math(tmp_path: Path):
    """1-pt-per-second ramp from 25000 -> 25200 over 200s. Predict at
    t0=10s (spot=25010); 30s lookahead window is (10, 40] -> end_spot
    = 25040, max=25040, min=25011."""
    raw_root = tmp_path / "raw"
    pred_root = tmp_path / "predictions"
    instrument = "nifty50"
    date_str = "2026-05-28"

    offsets = [i * 1_000_000_000 for i in range(0, 201)]   # 0..200 sec
    spots = [25_000.0 + float(i) for i in range(0, 201)]
    _write_synthetic_ticks(raw_root, instrument, date_str, offsets, spots)

    _log_predictions(
        pred_root, instrument, date_str,
        ts_ns_list=[_BASE_NS + 10 * 1_000_000_000],
        head_names=["direction_30s"],
    )
    pred_path = pred_root / date_str / f"{instrument}_predictions.parquet"

    n = backfill(pred_path, raw_root, instrument, date_str)
    assert n == 1
    tbl = pq.read_table(pred_path)
    row = tbl.to_pylist()[0]
    # spot_at_t0 = nearest tick at-or-before t0 = exactly 25010 (t=10s).
    # window (t0, t0+30] -> spots 25011..25040, end=25040.
    assert math.isclose(row["outcome_magnitude"], 30.0, abs_tol=1e-9)
    assert math.isclose(row["outcome_max_excursion"], 30.0, abs_tol=1e-9)
    # drawdown = spot_at_t0 - min_spot = 25010 - 25011 = -1 (smooth uptrend)
    assert math.isclose(row["outcome_max_drawdown"], -1.0, abs_tol=1e-9)
    assert row["outcome_direction"] == 1
    assert row["outcome_filled_ts_ns"] is not None


def test_downtrend_outcome_direction_negative(tmp_path: Path):
    raw_root = tmp_path / "raw"
    pred_root = tmp_path / "predictions"
    instrument = "nifty50"
    date_str = "2026-05-28"

    offsets = [i * 1_000_000_000 for i in range(0, 201)]
    spots = [12_000.0 - float(i) for i in range(0, 201)]
    _write_synthetic_ticks(raw_root, instrument, date_str, offsets, spots)
    _log_predictions(
        pred_root, instrument, date_str,
        ts_ns_list=[_BASE_NS + 10 * 1_000_000_000],
        head_names=["direction_30s"],
    )
    pred_path = pred_root / date_str / f"{instrument}_predictions.parquet"

    n = backfill(pred_path, raw_root, instrument, date_str)
    assert n == 1
    row = pq.read_table(pred_path).to_pylist()[0]
    # magnitude = -30, direction = -1
    assert math.isclose(row["outcome_magnitude"], -30.0, abs_tol=1e-9)
    assert row["outcome_direction"] == -1


def test_lookahead_past_end_of_stream_leaves_nan(tmp_path: Path):
    """If the recording ends before t0 + lookahead, outcomes stay NaN."""
    raw_root = tmp_path / "raw"
    pred_root = tmp_path / "predictions"
    instrument = "nifty50"
    date_str = "2026-05-28"

    # 100s of ticks; predict at t=95s with 30s lookahead -> window
    # extends to t=125s, past end-of-stream.
    offsets = [i * 1_000_000_000 for i in range(0, 100)]
    spots = [25_000.0 + float(i) for i in range(0, 100)]
    _write_synthetic_ticks(raw_root, instrument, date_str, offsets, spots)

    _log_predictions(
        pred_root, instrument, date_str,
        ts_ns_list=[_BASE_NS + 95 * 1_000_000_000],
        head_names=["direction_30s"],
    )
    pred_path = pred_root / date_str / f"{instrument}_predictions.parquet"

    n = backfill(pred_path, raw_root, instrument, date_str)
    assert n == 0   # nothing filled
    row = pq.read_table(pred_path).to_pylist()[0]
    assert row["outcome_filled_ts_ns"] is None
    assert math.isnan(row["outcome_magnitude"])


def test_no_lookahead_seconds_leaves_nan(tmp_path: Path):
    """A row with lookahead_seconds <= 0 (e.g. a non-target column
    slipped in) must be skipped."""
    raw_root = tmp_path / "raw"
    pred_root = tmp_path / "predictions"
    instrument = "nifty50"
    date_str = "2026-05-28"
    offsets = [i * 1_000_000_000 for i in range(0, 200)]
    spots = [25_000.0 + float(i) for i in range(0, 200)]
    _write_synthetic_ticks(raw_root, instrument, date_str, offsets, spots)

    # Log via a fake head name that doesn't match the _NNNs pattern.
    _log_predictions(
        pred_root, instrument, date_str,
        ts_ns_list=[_BASE_NS + 10 * 1_000_000_000],
        head_names=["not_a_target"],
    )
    pred_path = pred_root / date_str / f"{instrument}_predictions.parquet"
    n = backfill(pred_path, raw_root, instrument, date_str)
    assert n == 0


def test_idempotent_rerun_is_noop(tmp_path: Path):
    """Re-running backfill on a fully-filled parquet must skip every row
    (filled rows already have outcome_filled_ts_ns set)."""
    raw_root = tmp_path / "raw"
    pred_root = tmp_path / "predictions"
    instrument = "nifty50"
    date_str = "2026-05-28"
    offsets = [i * 1_000_000_000 for i in range(0, 200)]
    spots = [25_000.0 + float(i) for i in range(0, 200)]
    _write_synthetic_ticks(raw_root, instrument, date_str, offsets, spots)
    _log_predictions(
        pred_root, instrument, date_str,
        ts_ns_list=[_BASE_NS + 10 * 1_000_000_000],
        head_names=["direction_30s"],
    )
    pred_path = pred_root / date_str / f"{instrument}_predictions.parquet"

    n1 = backfill(pred_path, raw_root, instrument, date_str)
    n2 = backfill(pred_path, raw_root, instrument, date_str)
    assert n1 == 1
    assert n2 == 0  # already filled — second pass is a no-op


def test_force_rerun_refills_filled_rows(tmp_path: Path):
    raw_root = tmp_path / "raw"
    pred_root = tmp_path / "predictions"
    instrument = "nifty50"
    date_str = "2026-05-28"
    offsets = [i * 1_000_000_000 for i in range(0, 200)]
    spots = [25_000.0 + float(i) for i in range(0, 200)]
    _write_synthetic_ticks(raw_root, instrument, date_str, offsets, spots)
    _log_predictions(
        pred_root, instrument, date_str,
        ts_ns_list=[_BASE_NS + 10 * 1_000_000_000],
        head_names=["direction_30s"],
    )
    pred_path = pred_root / date_str / f"{instrument}_predictions.parquet"

    backfill(pred_path, raw_root, instrument, date_str)
    n2 = backfill(pred_path, raw_root, instrument, date_str, force=True)
    assert n2 == 1


def test_multiple_predictions_multiple_heads(tmp_path: Path):
    """3 prediction-times × 2 heads each = 6 rows; backfiller must fill
    all rows whose window closes."""
    raw_root = tmp_path / "raw"
    pred_root = tmp_path / "predictions"
    instrument = "nifty50"
    date_str = "2026-05-28"
    offsets = [i * 1_000_000_000 for i in range(0, 400)]
    spots = [25_000.0 + float(i) for i in range(0, 400)]
    _write_synthetic_ticks(raw_root, instrument, date_str, offsets, spots)

    ts_list = [
        _BASE_NS + 10 * 1_000_000_000,
        _BASE_NS + 50 * 1_000_000_000,
        _BASE_NS + 100 * 1_000_000_000,
    ]
    _log_predictions(
        pred_root, instrument, date_str,
        ts_ns_list=ts_list,
        head_names=["direction_30s", "direction_60s"],
    )
    pred_path = pred_root / date_str / f"{instrument}_predictions.parquet"
    n = backfill(pred_path, raw_root, instrument, date_str)
    assert n == 6
    tbl = pq.read_table(pred_path)
    # Every row got direction = 1 (uptrend) + magnitude in {30, 60}
    rows = tbl.to_pylist()
    assert all(r["outcome_direction"] == 1 for r in rows)
    mags = {round(r["outcome_magnitude"], 1) for r in rows}
    assert mags == {30.0, 60.0}