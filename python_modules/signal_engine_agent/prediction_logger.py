"""
signal_engine_agent/prediction_logger.py — T41 write-side.

Persists every per-head prediction to a daily per-instrument parquet so
the (prediction, outcome) feedback loop has source data to consume.
Hooked into ``engine.run()`` after the gate decision; one call emits
one ``PredictionRow`` per head present in the eval (~30–40 rows per
signal eval).

Storage layout::

    data/predictions/<YYYY-MM-DD>/<inst>_predictions.parquet
                                                 ^ outcome columns
                                                   filled by backfiller
                                                   post-session.

Write strategy:

  - Buffer rows in memory; flush to a numbered chunk file every
    ``chunk_rows`` rows or ``chunk_seconds`` seconds (whichever first).
  - Atomic write per chunk via ``.tmp`` + rename — matches the TFA
    replay chunk pattern, survives Ctrl+C / power loss.
  - At session-end / shutdown, ``finalise()`` merges all chunks into the
    canonical ``<inst>_predictions.parquet`` and deletes the chunks.
  - The outcome_backfiller runs post-finalise to fill the outcome cols.

Per-eval performance:

  - Predictions arrive ~1 per second (or whatever TFA's underlying tick
    cadence). Each eval pushes ~38 rows; an in-memory list append is
    < 1 µs each. Parquet flushes happen at chunk-boundary, not per-eval.
"""

from __future__ import annotations

import sys
import time
from collections import deque
from pathlib import Path
from typing import Iterable

import numpy as np
import pyarrow.parquet as pq

_HERE = Path(__file__).resolve().parent
_PYTHON_MODULES = _HERE.parent
if str(_PYTHON_MODULES) not in sys.path:
    sys.path.insert(0, str(_PYTHON_MODULES))

from _shared.prediction_schema import (
    PredictionRow,
    build_arrow_table,
    feature_snapshot_hash,
    parse_lookahead_seconds,
)


class PredictionLogger:
    """One instance per running SEA process, scoped to one (date, instrument).

    Construct with the output dir + instrument; call ``log_eval`` after
    every gate decision; call ``finalise`` at session end. The class is
    not thread-safe — it's single-writer per process (live SEA is one
    process per instrument).
    """

    def __init__(
        self,
        *,
        instrument: str,
        date_str: str,
        predictions_root: Path | str = "data/predictions",
        chunk_rows: int = 50_000,
        chunk_seconds: float = 300.0,
    ) -> None:
        self._instrument = instrument
        self._date_str = date_str
        self._out_dir = Path(predictions_root) / date_str
        self._out_dir.mkdir(parents=True, exist_ok=True)
        self._chunk_rows = int(chunk_rows)
        self._chunk_seconds = float(chunk_seconds)
        self._buffer: deque[PredictionRow] = deque()
        self._next_chunk_num = 1
        self._last_flush_monotonic = time.monotonic()
        self._next_prediction_id = self._scan_existing_chunks_for_next_id()

    # ── Internal helpers ────────────────────────────────────────────────

    def _scan_existing_chunks_for_next_id(self) -> int:
        """If the process crashed mid-day and is being restarted, recover
        the next prediction_id by scanning the existing chunk files.
        Returns 1 when no chunks exist."""
        pattern = f"{self._instrument}_predictions_part*.parquet"
        max_id = 0
        chunks_found = 0
        for chunk_path in self._out_dir.glob(pattern):
            chunks_found += 1
            try:
                # Only read the prediction_id column — cheap.
                tbl = pq.read_table(chunk_path, columns=["prediction_id"])
                ids = tbl.column("prediction_id").to_pylist()
                if ids:
                    max_id = max(max_id, max(ids))
            except Exception:
                # Corrupt chunk — leave it, but don't crash startup.
                continue
        if chunks_found:
            self._next_chunk_num = chunks_found + 1
        return max_id + 1

    def _chunk_path(self, n: int) -> Path:
        return self._out_dir / (
            f"{self._instrument}_predictions_part{n:03d}.parquet"
        )

    def _flush_now(self) -> None:
        if not self._buffer:
            self._last_flush_monotonic = time.monotonic()
            return
        rows = list(self._buffer)
        self._buffer.clear()
        chunk_path = self._chunk_path(self._next_chunk_num)
        tmp_path = chunk_path.with_suffix(chunk_path.suffix + ".tmp")
        tbl = build_arrow_table(rows)
        pq.write_table(tbl, tmp_path)
        tmp_path.replace(chunk_path)
        self._next_chunk_num += 1
        self._last_flush_monotonic = time.monotonic()

    def _maybe_flush(self) -> None:
        if len(self._buffer) >= self._chunk_rows:
            self._flush_now()
            return
        if (time.monotonic() - self._last_flush_monotonic) >= self._chunk_seconds:
            self._flush_now()

    # ── Public API ──────────────────────────────────────────────────────

    def log_eval(
        self,
        *,
        ts_ns: int,
        feature_vec: np.ndarray,
        raw_preds: dict[str, float],
        calibrated_preds: dict[str, float],
        gate_decision: str,
        regime_tag: str | None,
        head_types: dict[str, str] | None = None,
    ) -> int:
        """Append one row per head in ``calibrated_preds`` and return the
        number of rows queued.

        Args:
            ts_ns: signal eval timestamp in epoch nanoseconds.
            feature_vec: the feature vector fed to the models, hashed
                once per eval (same hash on all heads in this batch).
            raw_preds: ``{head_name: pre-calibration float}``.
            calibrated_preds: ``{head_name: post-calibration float}`` —
                same keys as ``raw_preds``. The gate consumed this dict.
            gate_decision: final gate output as a string ("LONG_CE",
                "LONG_PE", "WAIT", ...).
            regime_tag: regime label from TFA's ``regime`` column, or
                None until T32 ships a proper L8 classifier.
            head_types: optional ``{head_name: "scalp"|"trend"|"swing"}``
                map from T33 cohort tagging; pass None until T33 ships.
        """
        if not calibrated_preds:
            return 0
        feat_hash = feature_snapshot_hash(feature_vec)
        head_types = head_types or {}
        n = 0
        for head_name, cal_val in calibrated_preds.items():
            raw_val = raw_preds.get(head_name, float("nan"))
            self._buffer.append(PredictionRow(
                prediction_id=self._next_prediction_id,
                ts_ns=ts_ns,
                instrument=self._instrument,
                head_name=head_name,
                head_type=head_types.get(head_name),
                raw_prob=float(raw_val),
                calibrated_prob=float(cal_val),
                gate_decision=gate_decision,
                regime_tag=regime_tag,
                feature_snapshot_hash=feat_hash,
                lookahead_seconds=parse_lookahead_seconds(head_name),
            ))
            self._next_prediction_id += 1
            n += 1
        self._maybe_flush()
        return n

    def flush(self) -> None:
        """Force a chunk flush. Called from the SEA process's shutdown
        hook so a clean exit doesn't lose buffered rows."""
        self._flush_now()

    def finalise(self) -> Path | None:
        """Flush the in-memory buffer + merge all chunks into the
        canonical ``<inst>_predictions.parquet`` file. Deletes the chunks
        after the merge. Returns the final parquet path, or None when
        no rows were ever logged.

        Idempotent — calling twice on an empty buffer is a no-op.
        """
        self._flush_now()
        chunks = sorted(self._out_dir.glob(
            f"{self._instrument}_predictions_part*.parquet"
        ))
        if not chunks:
            return None
        final_path = self._out_dir / f"{self._instrument}_predictions.parquet"
        tmp_path = final_path.with_suffix(final_path.suffix + ".tmp")
        tables = [pq.read_table(c) for c in chunks]
        merged = tables[0] if len(tables) == 1 else _concat(tables)
        pq.write_table(merged, tmp_path)
        tmp_path.replace(final_path)
        for c in chunks:
            try:
                c.unlink()
            except OSError:
                pass
        return final_path


def _concat(tables: Iterable):
    import pyarrow as pa
    return pa.concat_tables(list(tables))