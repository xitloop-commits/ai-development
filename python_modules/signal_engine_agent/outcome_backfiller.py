"""
signal_engine_agent/outcome_backfiller.py — T41 read-side.

Post-session pass that joins each prediction row's lookahead window
against the recorded underlying-tick stream and fills the 5 outcome
columns in-place on ``data/predictions/<date>/<inst>_predictions.parquet``.

Algorithm:

  1. Load the predictions parquet (read-only).
  2. Load the underlying-tick stream as two sorted numpy arrays
     (``ts_ns`` + ``spot``).
  3. For every row:
       - Look up ``spot_at_t0`` = nearest tick at-or-before ``ts_ns``.
       - Window = ticks with ``t0 < ts <= t0 + lookahead_seconds * 1e9``.
       - If window is empty or the recording ended before ``t0 + w``,
         leave outcome columns NaN (incomplete window).
       - Otherwise compute end / max / min spot in the window and the
         four derived outcome features.
  4. Write the merged table back atomically (``.tmp`` + rename).

Usage::

    py -3 -m signal_engine_agent.outcome_backfiller \\
        --instrument nifty50 --date 2026-05-28

Idempotent — re-running on an already-backfilled parquet is a no-op
because rows with non-null ``outcome_filled_ts_ns`` are skipped unless
``--force`` is set.
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

_HERE = Path(__file__).resolve().parent
_PYTHON_MODULES = _HERE.parent
if str(_PYTHON_MODULES) not in sys.path:
    sys.path.insert(0, str(_PYTHON_MODULES))

from _shared.prediction_schema import ARROW_SCHEMA


def _parse_recv_ts_to_ns(recv_ts: str) -> int | None:
    """Convert TFA's ISO ``recv_ts`` to integer epoch nanoseconds.

    The recorder writes timestamps with millisecond precision (and a
    timezone suffix), so the round-trip via ``datetime.fromisoformat``
    is lossless within that resolution.
    """
    if not isinstance(recv_ts, str):
        return None
    try:
        dt = datetime.fromisoformat(recv_ts)
    except (ValueError, TypeError):
        return None
    return int(dt.timestamp() * 1e9)


def load_underlying_ticks(
    date_folder: Path, instrument: str,
) -> tuple[np.ndarray, np.ndarray]:
    """Load the date's underlying-tick stream into sorted ``(ts_ns, spot)``
    numpy arrays. Returns two empty arrays if the file is missing or
    every line is malformed."""
    path = date_folder / f"{instrument}_underlying_ticks.ndjson.gz"
    if not path.exists():
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.float64)
    ts_list: list[int] = []
    spot_list: list[float] = []
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts_ns = _parse_recv_ts_to_ns(rec.get("recv_ts"))
            ltp = rec.get("ltp")
            if ts_ns is None or ltp is None:
                continue
            try:
                ts_list.append(ts_ns)
                spot_list.append(float(ltp))
            except (TypeError, ValueError):
                continue
    ts_arr = np.asarray(ts_list, dtype=np.int64)
    spot_arr = np.asarray(spot_list, dtype=np.float64)
    # Defensive sort — recorder writes in order but a sort guarantees
    # binary search correctness even if a fault interleaves entries.
    order = np.argsort(ts_arr, kind="stable")
    return ts_arr[order], spot_arr[order]


def backfill(
    predictions_path: Path,
    raw_root: Path,
    instrument: str,
    date_str: str,
    *,
    force: bool = False,
) -> int:
    """Fill outcome columns in-place on ``predictions_path``.

    Returns the number of rows updated. 0 when the file is absent, the
    tick stream is empty, or every row is already filled (and
    ``force=False``).
    """
    if not predictions_path.exists():
        return 0
    tick_ts, tick_spot = load_underlying_ticks(
        raw_root / date_str, instrument,
    )
    if tick_ts.size == 0:
        return 0
    end_of_stream_ts = int(tick_ts[-1])

    tbl = pq.read_table(predictions_path)
    n = len(tbl)
    if n == 0:
        return 0

    ts_ns = np.asarray(tbl.column("ts_ns").to_pylist(), dtype=np.int64)
    lookahead = np.asarray(
        tbl.column("lookahead_seconds").to_pylist(), dtype=np.int32,
    )
    existing_filled = tbl.column("outcome_filled_ts_ns").to_pylist()

    # Allocate output column arrays — start from the existing values so
    # idempotent reruns don't re-write rows we've already filled.
    direction_out: list[int | None] = list(
        tbl.column("outcome_direction").to_pylist()
    )
    magnitude_out = np.asarray(
        tbl.column("outcome_magnitude").to_pylist(), dtype=np.float64
    )
    excursion_out = np.asarray(
        tbl.column("outcome_max_excursion").to_pylist(), dtype=np.float64
    )
    drawdown_out = np.asarray(
        tbl.column("outcome_max_drawdown").to_pylist(), dtype=np.float64
    )
    filled_ts_out: list[int | None] = list(existing_filled)

    fill_ts_ns = time.time_ns()
    n_filled = 0
    for i in range(n):
        if not force and existing_filled[i] is not None:
            continue
        w_sec = int(lookahead[i])
        if w_sec <= 0:
            continue
        t0 = int(ts_ns[i])
        t1 = t0 + w_sec * 1_000_000_000
        if t1 > end_of_stream_ts:
            # Recording ended before the lookahead window closes —
            # outcome incomplete; leave NaN.
            continue
        # spot_at_t0 = nearest tick at-or-before t0.
        idx_at_t0 = int(np.searchsorted(tick_ts, t0, side="right")) - 1
        if idx_at_t0 < 0:
            continue
        spot_at_t0 = float(tick_spot[idx_at_t0])
        idx_start = int(np.searchsorted(tick_ts, t0, side="right"))
        idx_end = int(np.searchsorted(tick_ts, t1, side="right"))
        if idx_start >= idx_end:
            continue
        window_spots = tick_spot[idx_start:idx_end]
        end_spot = float(window_spots[-1])
        max_spot = float(window_spots.max())
        min_spot = float(window_spots.min())

        magnitude = end_spot - spot_at_t0
        direction_out[i] = (
            1 if magnitude > 0 else (-1 if magnitude < 0 else 0)
        )
        magnitude_out[i] = magnitude
        excursion_out[i] = max_spot - spot_at_t0
        drawdown_out[i] = spot_at_t0 - min_spot
        filled_ts_out[i] = fill_ts_ns
        n_filled += 1

    if n_filled == 0 and not force:
        return 0

    # Rebuild the table with the updated outcome columns, preserving
    # every other column verbatim.
    new_cols: dict[str, pa.Array] = {}
    for name in tbl.column_names:
        if name == "outcome_direction":
            new_cols[name] = pa.array(direction_out, type=pa.int8())
        elif name == "outcome_magnitude":
            new_cols[name] = pa.array(magnitude_out, type=pa.float64())
        elif name == "outcome_max_excursion":
            new_cols[name] = pa.array(excursion_out, type=pa.float64())
        elif name == "outcome_max_drawdown":
            new_cols[name] = pa.array(drawdown_out, type=pa.float64())
        elif name == "outcome_filled_ts_ns":
            new_cols[name] = pa.array(filled_ts_out, type=pa.int64())
        else:
            new_cols[name] = tbl.column(name)

    new_tbl = pa.Table.from_pydict(new_cols, schema=ARROW_SCHEMA)
    tmp = predictions_path.with_suffix(predictions_path.suffix + ".tmp")
    pq.write_table(new_tbl, tmp)
    tmp.replace(predictions_path)
    return n_filled


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--instrument", required=True)
    parser.add_argument("--date", required=True, help="YYYY-MM-DD")
    parser.add_argument(
        "--predictions-root", default="data/predictions",
    )
    parser.add_argument(
        "--raw-root", default="data/raw",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Re-fill rows whose outcome_filled_ts_ns is already set.",
    )
    args = parser.parse_args()

    pred_path = (
        Path(args.predictions_root)
        / args.date
        / f"{args.instrument}_predictions.parquet"
    )
    if not pred_path.exists():
        print(f"No predictions parquet at {pred_path}", file=sys.stderr)
        return 1
    n = backfill(
        pred_path, Path(args.raw_root), args.instrument, args.date,
        force=args.force,
    )
    print(f"Filled {n} outcome row(s) -> {pred_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())