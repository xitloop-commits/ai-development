"""
_shared/prediction_schema.py — T41 frozen schema for (prediction, outcome).

The single source of truth for what every per-head prediction row looks
like on disk. Used by:

  * ``signal_engine_agent.prediction_logger``       — write side, populates
    everything except the ``outcome_*`` and ``outcome_filled_ts_ns`` columns
    (those are NaN at write time).
  * ``signal_engine_agent.outcome_backfiller``      — backfills the outcome
    columns N seconds after each row's lookahead window elapses, by
    replaying the recorded tick stream.
  * ``model_training_agent`` / ``scripts/trade_quality_report_weekly.py``
    (T34) — reads the finalised parquet for per-head reliability,
    calibration drift, regime-conditional analysis, etc.

Schema rationale (V2_MASTER_SPEC D75 feedback-loop foundation):

  - Every head emits one row per signal eval — both heads that fire AND
    heads that don't. T34 calibration uses the unfired ones too.
  - ``raw_prob`` + ``calibrated_prob`` lets calibration drift be tracked
    over the live data without re-running calibration offline.
  - ``feature_snapshot_hash`` makes a row replay-able when investigating
    why the model said what it did. Cheap stable hash, no need to
    persist the full feature vector.
  - ``head_type`` + ``regime_tag`` are dependencies on T33 / T32 that
    aren't shipped yet — they're allowed to be NULL until those tasks
    land. Schema stays the same; the columns just get populated later.

Schema version: 1.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

import numpy as np
import pyarrow as pa

SCHEMA_VERSION = 1

# Column order matches the V2_MASTER_SPEC T41 spec exactly so downstream
# consumers (T34 report, future RL trainer) can rely on it.
COLUMNS: tuple[str, ...] = (
    "prediction_id",            # uint64, monotonic per (date, instrument)
    "ts_ns",                    # int64, signal-eval timestamp (epoch ns)
    "instrument",               # string, "nifty50" / "banknifty" / ...
    "head_name",                # string, e.g. "direction_30s"
    "head_type",                # string, "scalp"/"trend"/"swing" — NULL until T33
    "raw_prob",                 # float64, pre-calibration model output (NaN if no model)
    "calibrated_prob",          # float64, post-isotonic (== raw if no cal map)
    "gate_decision",            # string, "LONG_CE"/"LONG_PE"/"WAIT"
    "regime_tag",               # string, regime label — NULL until T32
    "feature_snapshot_hash",    # string, blake2b(8-byte) hex of feature vector
    "lookahead_seconds",        # int32, parsed from head_name (e.g. 30 from "direction_30s")
    "outcome_direction",        # int8 (-1/0/+1), backfilled
    "outcome_magnitude",        # float64, backfilled — spot move over lookahead
    "outcome_max_excursion",    # float64, backfilled — max favourable in window
    "outcome_max_drawdown",     # float64, backfilled — max adverse in window
    "outcome_filled_ts_ns",     # int64, when the backfiller finalised this row
)

# Pyarrow schema with explicit types so writes are stable across pyarrow
# versions and Polars / pandas reads agree on dtypes.
ARROW_SCHEMA: pa.Schema = pa.schema([
    pa.field("prediction_id",            pa.uint64()),
    pa.field("ts_ns",                    pa.int64()),
    pa.field("instrument",               pa.string()),
    pa.field("head_name",                pa.string()),
    pa.field("head_type",                pa.string()),
    pa.field("raw_prob",                 pa.float64()),
    pa.field("calibrated_prob",          pa.float64()),
    pa.field("gate_decision",            pa.string()),
    pa.field("regime_tag",               pa.string()),
    pa.field("feature_snapshot_hash",    pa.string()),
    pa.field("lookahead_seconds",        pa.int32()),
    pa.field("outcome_direction",        pa.int8()),
    pa.field("outcome_magnitude",        pa.float64()),
    pa.field("outcome_max_excursion",    pa.float64()),
    pa.field("outcome_max_drawdown",     pa.float64()),
    pa.field("outcome_filled_ts_ns",     pa.int64()),
])


@dataclass
class PredictionRow:
    """One row of the prediction parquet — values at log time.

    The 5 outcome_* columns are populated by the backfiller post-session.
    head_type + regime_tag may be None until T32 / T33 ship.
    """
    prediction_id: int
    ts_ns: int
    instrument: str
    head_name: str
    head_type: str | None
    raw_prob: float
    calibrated_prob: float
    gate_decision: str
    regime_tag: str | None
    feature_snapshot_hash: str
    lookahead_seconds: int


# ── Helpers ────────────────────────────────────────────────────────────────


_LOOKAHEAD_RE = re.compile(r"_(\d+)s$")


def parse_lookahead_seconds(head_name: str) -> int:
    """Extract the trailing ``_NNNs`` window from a head name.

    Examples::

        parse_lookahead_seconds("direction_30s")        -> 30
        parse_lookahead_seconds("max_drawdown_pe_120s") -> 120
        parse_lookahead_seconds("direction_30s_magnitude") -> 30
                                  ^ also picks up the embedded 30
        parse_lookahead_seconds("upside_percentile_60s") -> 60

    Returns -1 when no window suffix is present (e.g. a non-target
    column slipped in). The backfiller treats -1 as "no outcome backfill
    needed for this row" — outcome columns stay NaN.
    """
    # Try strict trailing match first (covers most cases).
    m = _LOOKAHEAD_RE.search(head_name)
    if m:
        return int(m.group(1))
    # Fall back to any _NNNs anywhere in the name (catches the
    # direction_30s_magnitude shape).
    for part in head_name.split("_"):
        if part.endswith("s") and part[:-1].isdigit():
            return int(part[:-1])
    return -1


def feature_snapshot_hash(feature_vec: np.ndarray) -> str:
    """Stable 16-hex-char hash of the feature vector.

    Uses blake2b with an 8-byte digest — cheap (~1us for 500-element
    vector), short enough that storing one per row is negligible.
    Treats NaN as a fixed sentinel so two NaN-equal vectors hash the same.
    """
    arr = np.asarray(feature_vec, dtype=np.float64).copy()
    # Replace NaN with a fixed sentinel so float-NaN doesn't randomise
    # the hash (NaN != NaN in IEEE; we want determinism).
    arr[np.isnan(arr)] = -1.7976931348623157e308
    return hashlib.blake2b(arr.tobytes(), digest_size=8).hexdigest()


def empty_outcome_columns() -> dict[str, object]:
    """The 5 outcome columns at log time — all NaN/null.

    Returned as Python values that match the Arrow schema dtypes; the
    writer converts via pyarrow. The backfiller overwrites these later.
    """
    return {
        "outcome_direction":   None,         # int8 nullable
        "outcome_magnitude":   float("nan"),
        "outcome_max_excursion": float("nan"),
        "outcome_max_drawdown":  float("nan"),
        "outcome_filled_ts_ns":  None,       # int64 nullable
    }


def build_arrow_table(rows: list[PredictionRow]) -> pa.Table:
    """Convert a list of PredictionRow into an Arrow Table that matches
    ``ARROW_SCHEMA``. Outcome columns are NaN/null because the backfiller
    fills them later."""
    if not rows:
        return ARROW_SCHEMA.empty_table()

    cols: dict[str, list] = {name: [] for name in COLUMNS}
    for r in rows:
        cols["prediction_id"].append(r.prediction_id)
        cols["ts_ns"].append(r.ts_ns)
        cols["instrument"].append(r.instrument)
        cols["head_name"].append(r.head_name)
        cols["head_type"].append(r.head_type)
        cols["raw_prob"].append(r.raw_prob)
        cols["calibrated_prob"].append(r.calibrated_prob)
        cols["gate_decision"].append(r.gate_decision)
        cols["regime_tag"].append(r.regime_tag)
        cols["feature_snapshot_hash"].append(r.feature_snapshot_hash)
        cols["lookahead_seconds"].append(r.lookahead_seconds)
        cols["outcome_direction"].append(None)
        cols["outcome_magnitude"].append(float("nan"))
        cols["outcome_max_excursion"].append(float("nan"))
        cols["outcome_max_drawdown"].append(float("nan"))
        cols["outcome_filled_ts_ns"].append(None)
    return pa.Table.from_pydict(cols, schema=ARROW_SCHEMA)