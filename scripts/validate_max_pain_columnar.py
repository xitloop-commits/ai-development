"""
scripts/validate_max_pain_columnar.py — T50 B.3a real-data equivalence gate.

Loads a real recorded chain_snapshots stream and verifies that
``compute_max_pain_features_batch`` (Polars) produces values
mathematically identical to the per-snapshot
``compute_max_pain_features`` (scalar) for every snapshot in the file.

This is the harness the design doc calls out as Phase 2 of the
equivalence strategy — synthetic tests gate the algorithm, this gates
correctness against actual broker data shape and edge cases the
synthetic tests can't reach (NaN OIs, partial chains during pre-market
warmup, rapid strike additions, etc.).

Usage::

    py -3 scripts/validate_max_pain_columnar.py
    py -3 scripts/validate_max_pain_columnar.py --date 2026-05-21
    py -3 scripts/validate_max_pain_columnar.py --instrument banknifty --max-snapshots 500

Exit code 0 = byte-equivalent (within float epsilon). Exit code 1 = any
divergence detected. Use this in CI gates around B.3a merges.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import sys
import time
from pathlib import Path

import polars as pl

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent
_PY_MODULES = _REPO_ROOT / "python_modules"
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

from tick_feature_agent.features.levels import compute_max_pain_features
from tick_feature_agent.features.levels_columnar import (
    compute_max_pain_features_batch,
)


# Match the design doc's tolerance for "byte-equivalent": 1e-12 absolute
# OR 1e-9 relative. Tighter than typical numerical-noise comparisons —
# we're checking that the same arithmetic produces the same float.
_ABS_TOL = 1e-12
_REL_TOL = 1e-9


def _load_snapshots(path: Path, max_snapshots: int | None) -> list[dict]:
    out: list[dict] = []
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            out.append(rec)
            if max_snapshots is not None and len(out) >= max_snapshots:
                break
    return out


def _scalar_one(snap: dict) -> dict:
    spot = snap.get("spotPrice")
    rows = snap.get("rows", [])
    return compute_max_pain_features(spot, rows)


def _normalize_for_polars(snap: dict) -> dict:
    """Coerce numeric fields to float so Polars' from_dicts doesn't trip
    over mixed Int/Float schemas across snapshots in the batch.

    The recorder writes whatever the broker JSON contains — sometimes
    callOI=0 (int), sometimes callOI=50000.0 (float). Polars infers
    schema from the first non-null value and then strict-rejects later
    values of a "wider" type. Forcing all numerics to float up front
    avoids the schema-inference cliff without compromising correctness.
    """
    spot = snap.get("spotPrice")
    rows = []
    for r in snap.get("rows", []):
        if not isinstance(r, dict):
            continue
        strike = r.get("strike")
        c_oi = r.get("callOI")
        p_oi = r.get("putOI")
        rows.append({
            "strike": float(strike) if strike is not None else None,
            "callOI": float(c_oi) if c_oi is not None else None,
            "putOI": float(p_oi) if p_oi is not None else None,
        })
    return {
        "spotPrice": float(spot) if spot is not None else None,
        "rows": rows,
    }


def _close(s: float, c, *, abs_tol: float = _ABS_TOL, rel_tol: float = _REL_TOL) -> bool:
    s_missing = isinstance(s, float) and math.isnan(s)
    c_missing = c is None or (isinstance(c, float) and math.isnan(c))
    if s_missing and c_missing:
        return True
    if s_missing != c_missing:
        return False
    return abs(s - c) <= abs_tol + rel_tol * abs(s)


def _compare(scalar_rows: list[dict], columnar_df: pl.DataFrame) -> tuple[int, dict]:
    """Returns (mismatch_count, by_key_summary).

    by_key_summary maps the 3 feature names to (max_abs_diff, mismatch_count).
    """
    mismatches = 0
    per_key = {
        "max_pain_strike": [0.0, 0],
        "distance_to_max_pain_pct": [0.0, 0],
        "max_pain_gravity_strength": [0.0, 0],
    }
    # The columnar output may omit rows whose snapshot was filtered out
    # (empty/null rows list). Build a snapshot_id -> row dict for lookup.
    col_by_id = {row["snapshot_id"]: row for row in columnar_df.iter_rows(named=True)}
    for i, s_out in enumerate(scalar_rows):
        c_out = col_by_id.get(i)
        if c_out is None:
            # Snapshot was dropped by columnar (empty/null rows). Scalar
            # would have returned all-NaN for the same input. Verify:
            for key in per_key:
                s_val = s_out[key]
                if not (isinstance(s_val, float) and math.isnan(s_val)):
                    mismatches += 1
                    per_key[key][1] += 1
            continue
        for key in per_key:
            s_val = s_out[key]
            c_val = c_out[key]
            if not _close(s_val, c_val):
                mismatches += 1
                per_key[key][1] += 1
                # Track magnitude only for non-NaN diffs
                if not (isinstance(s_val, float) and math.isnan(s_val)):
                    if c_val is not None and not (
                        isinstance(c_val, float) and math.isnan(c_val)
                    ):
                        d = abs(s_val - c_val)
                        if d > per_key[key][0]:
                            per_key[key][0] = d
    summary = {k: (v[0], v[1]) for k, v in per_key.items()}
    return mismatches, summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--instrument", default="nifty50")
    parser.add_argument("--date", default="2026-05-22")
    parser.add_argument("--raw-root", default=str(_REPO_ROOT / "data" / "raw"))
    parser.add_argument(
        "--max-snapshots", type=int, default=None,
        help="Limit number of snapshots loaded (default: all).",
    )
    args = parser.parse_args()

    path = (
        Path(args.raw_root)
        / args.date
        / f"{args.instrument}_chain_snapshots.ndjson.gz"
    )
    if not path.exists():
        print(f"ERROR: chain snapshot file not found: {path}", file=sys.stderr)
        return 1

    print(f"Loading {path} ...")
    t0 = time.perf_counter()
    snapshots = _load_snapshots(path, args.max_snapshots)
    t_load = time.perf_counter() - t0
    print(f"  loaded {len(snapshots):,} snapshots in {t_load:.2f}s")

    print("Running SCALAR per-snapshot ...")
    t0 = time.perf_counter()
    scalar_results = [_scalar_one(s) for s in snapshots]
    t_scalar = time.perf_counter() - t0
    print(f"  scalar: {t_scalar:.3f}s ({len(snapshots) / max(t_scalar, 1e-9):.0f} snap/s)")

    print("Running COLUMNAR batched ...")
    # Build the input shape the function expects: one row per snapshot
    # with a spotPrice column + nested rows List[Struct]. Pre-normalise
    # numeric fields to float (see _normalize_for_polars docstring).
    df_input = pl.from_dicts(
        [_normalize_for_polars(s) for s in snapshots],
        infer_schema_length=None,
    )
    t0 = time.perf_counter()
    columnar_df = compute_max_pain_features_batch(
        df_input, spot_col="spotPrice",
    )
    t_columnar = time.perf_counter() - t0
    print(f"  columnar: {t_columnar:.3f}s ({len(snapshots) / max(t_columnar, 1e-9):.0f} snap/s)")
    print()

    speedup = t_scalar / max(t_columnar, 1e-9)
    print(f"Per-function speedup: {speedup:.1f}x")
    print()

    print("Comparing ...")
    mismatches, summary = _compare(scalar_results, columnar_df)
    print(f"  total mismatches: {mismatches}")
    for key, (max_diff, count) in summary.items():
        print(f"  {key:<32} mismatches={count}  max_abs_diff={max_diff:.2e}")
    print()

    if mismatches == 0:
        print("PASS - byte-equivalent within float epsilon.")
        return 0
    print("FAIL - divergences detected. See per-key counts above; do NOT")
    print("       wire columnar into the adapter until resolved.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
