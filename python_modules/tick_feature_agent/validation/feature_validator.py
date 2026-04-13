"""
validation/feature_validator.py — Three-layer feature quality validation (§17).

Runs on replay Parquet output and reports data quality before the file is
added to the ML training set.

Three validation layers:
  Layer 1 — Structural checks (hard failures)
  Layer 2 — Null/NaN rate checks
  Layer 3 — Statistical sanity checks

CLI:
    python -m tick_feature_agent.validation.feature_validator \\
        --instrument nifty50 --date 2026-04-14

Output: ``data/validation/{date}/{instrument}_validation.json``

Verdict rules:
  PASS — all Layer 1 pass, no Layer 2/3 FAILs
  WARN — at least one WARN (usable, investigate)
  FAIL — any Layer 1 failure OR any Layer 2/3 FAIL → do not use for training
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any


# ── Spec constants ─────────────────────────────────────────────────────────────

_EXPECTED_COLUMNS = 370

# Null rate thresholds (outside warm-up)
_NULL_WARN_THRESHOLD = 0.02   # 2%
_NULL_FAIL_THRESHOLD = 0.10   # 10%

# Statistical sanity ranges
_STAT_RANGES: dict[str, tuple[float | None, float | None]] = {
    "bid_ask_imbalance":      (-1.0, 1.0),
    "chain_pcr_global":       (0.0, 15.0),
    "breakout_readiness":     (0.0, 1.0),
    "call_put_strength_diff": (-1.0, 1.0),
    "return_5ticks":          (-0.05, 0.05),
}


# ── Layer 1: Structural checks ────────────────────────────────────────────────

def _layer1_structural(df_cols: list[str], n_rows: int,
                       ts_col: list, security_ids: list,
                       expected_cols: tuple[str, ...]) -> dict[str, Any]:
    """Return layer 1 result dict."""
    checks: dict[str, str] = {}
    verdict = "PASS"

    # Column count
    if len(df_cols) != _EXPECTED_COLUMNS:
        checks["column_count"] = f"FAIL — {len(df_cols)} columns (expected {_EXPECTED_COLUMNS})"
        verdict = "FAIL"
    else:
        checks["column_count"] = "PASS"

    # Column names match
    missing = set(expected_cols) - set(df_cols)
    extra   = set(df_cols) - set(expected_cols)
    if missing or extra:
        checks["column_names"] = (
            f"FAIL — missing: {sorted(missing)[:5]}, extra: {sorted(extra)[:5]}"
        )
        verdict = "FAIL"
    else:
        checks["column_names"] = "PASS"

    # Row count
    if n_rows == 0:
        checks["row_count"] = "FAIL — 0 rows"
        verdict = "FAIL"
    else:
        checks["row_count"] = f"PASS — {n_rows} rows"

    # Timestamp ordering (strictly increasing)
    if ts_col and len(ts_col) > 1:
        out_of_order = sum(1 for i in range(1, len(ts_col)) if ts_col[i] <= ts_col[i-1])
        if out_of_order:
            checks["timestamp_ordering"] = f"FAIL — {out_of_order} out-of-order timestamps"
            verdict = "FAIL"
        else:
            checks["timestamp_ordering"] = "PASS"

    # No duplicate rows
    if ts_col and security_ids:
        pairs = list(zip(ts_col, security_ids))
        if len(pairs) != len(set(pairs)):
            checks["no_duplicates"] = "FAIL — duplicate (recv_ts, security_id) rows found"
            verdict = "FAIL"
        else:
            checks["no_duplicates"] = "PASS"

    return {"verdict": verdict, "checks": checks}


# ── Layer 2: Null rate checks ─────────────────────────────────────────────────

def _null_rate(col_values: list) -> float:
    """Fraction of NaN or None values in a list."""
    if not col_values:
        return 0.0
    n_null = sum(
        1 for v in col_values
        if v is None or (isinstance(v, float) and math.isnan(v))
    )
    return n_null / len(col_values)


def _layer2_null_rates(
    columns: dict[str, list],
    n_rows: int,
) -> dict[str, Any]:
    """Return layer 2 result dict."""
    if n_rows == 0:
        return {"verdict": "PASS", "checks": {}}

    checks: dict[str, str] = {}
    layer_verdict = "PASS"

    # Key feature columns to check
    check_cols = [
        "underlying_ltp", "underlying_momentum", "underlying_ofi_5",
        "chain_pcr_global", "chain_pcr_atm", "regime", "breakout_readiness",
        "zone_activity_score", "data_quality_flag",
    ]

    for col in check_cols:
        if col not in columns:
            continue
        rate = _null_rate(columns[col])
        if rate > _NULL_FAIL_THRESHOLD:
            checks[col] = f"FAIL — {rate*100:.1f}% null post warm-up"
            layer_verdict = "FAIL"
        elif rate > _NULL_WARN_THRESHOLD:
            checks[col] = f"WARN — {rate*100:.1f}% null post warm-up"
            if layer_verdict == "PASS":
                layer_verdict = "WARN"
        # No entry for PASS columns (spec says only report WARNs/FAILs)

    return {"verdict": layer_verdict, "checks": checks}


# ── Layer 3: Statistical sanity checks ────────────────────────────────────────

def _stat_check(
    col: str,
    values: list,
    lo: float | None,
    hi: float | None,
    pct_threshold: float = 0.05,
) -> str:
    """Return PASS/WARN/FAIL string for a range check."""
    valid = [v for v in values if v is not None and not (isinstance(v, float) and math.isnan(v))]
    if not valid:
        return f"WARN — all NaN ('{col}' not populated)"
    out_of_range = sum(
        1 for v in valid
        if (lo is not None and v < lo) or (hi is not None and v > hi)
    )
    pct = out_of_range / len(valid)
    if pct > pct_threshold:
        return f"FAIL — {pct*100:.1f}% of rows outside [{lo}, {hi}]"
    return "PASS"


def _unique_values(values: list) -> set:
    return {v for v in values if v is not None and not (isinstance(v, float) and math.isnan(v))}


def _layer3_statistical(columns: dict[str, list], n_rows: int) -> dict[str, Any]:
    """Return layer 3 result dict."""
    if n_rows == 0:
        return {"verdict": "PASS", "checks": {}}

    checks: dict[str, str] = {}
    layer_verdict = "PASS"

    def _record(col: str, result: str):
        nonlocal layer_verdict
        checks[col] = result
        if result.startswith("FAIL") and layer_verdict != "FAIL":
            layer_verdict = "FAIL"
        elif result.startswith("WARN") and layer_verdict == "PASS":
            layer_verdict = "WARN"

    # Bid-ask imbalance (any ATM strike — use opt_0_ce_bid_ask_imbalance)
    for check_col in ("opt_0_ce_bid_ask_imbalance", "opt_m1_ce_bid_ask_imbalance"):
        if check_col in columns:
            _record(check_col, _stat_check(check_col, columns[check_col], -1.0, 1.0))
            break

    # chain_pcr_global
    if "chain_pcr_global" in columns:
        vals = columns["chain_pcr_global"]
        unique = _unique_values(vals)
        if len(unique) == 1 and unique == {1.0}:
            _record("chain_pcr_global", "FAIL — always exactly 1.0 (OI not updating)")
        else:
            _record("chain_pcr_global", _stat_check("chain_pcr_global", vals, 0.0, 15.0))

    # regime — always same value
    if "regime" in columns:
        unique = _unique_values(columns["regime"])
        if len(unique) == 1:
            _record("regime", f"WARN — always '{next(iter(unique))}' (threshold misconfiguration?)")
        else:
            checks["regime"] = "PASS"

    # data_quality_flag — should not be 0 > 60% of rows
    if "data_quality_flag" in columns:
        vals = columns["data_quality_flag"]
        n_zero = sum(1 for v in vals if v == 0)
        if n_zero / len(vals) > 0.60:
            _record("data_quality_flag", f"FAIL — flag=0 for {n_zero/len(vals)*100:.1f}% of rows")
        else:
            checks["data_quality_flag"] = "PASS"

    # underlying_trade_direction — always 0
    if "underlying_trade_direction" in columns:
        unique = _unique_values(columns["underlying_trade_direction"])
        if unique == {0} or unique == {0.0}:
            _record("underlying_trade_direction", "FAIL — always 0 (bid/ask parser not applied)")
        else:
            checks["underlying_trade_direction"] = "PASS"

    # direction_30s — always same value
    if "direction_30s" in columns:
        unique = _unique_values(columns["direction_30s"])
        if len(unique) == 1:
            _record("direction_30s", f"WARN — always '{next(iter(unique))}' (target leakage?)")

    # breakout_readiness range [0, 1]
    if "breakout_readiness" in columns:
        _record("breakout_readiness",
                _stat_check("breakout_readiness", columns["breakout_readiness"], 0.0, 1.0))

    # call_put_strength_diff range [-1, 1]
    if "call_put_strength_diff" in columns:
        _record("call_put_strength_diff",
                _stat_check("call_put_strength_diff",
                            columns["call_put_strength_diff"], -1.0, 1.0))

    # return_5ticks — typical range
    if "underlying_return_5ticks" in columns:
        _record("underlying_return_5ticks",
                _stat_check("underlying_return_5ticks",
                            columns["underlying_return_5ticks"], -0.05, 0.05))

    return {"verdict": layer_verdict, "checks": checks}


# ── Daily stats ────────────────────────────────────────────────────────────────

def _daily_stats(columns: dict[str, list], stat_cols: list[str]) -> dict[str, Any]:
    """Compute mean, std, null_pct for key columns."""
    result = {}
    for col in stat_cols:
        if col not in columns:
            continue
        vals = [v for v in columns[col]
                if v is not None and not (isinstance(v, float) and math.isnan(v))]
        all_vals = columns[col]
        null_pct = 1 - (len(vals) / len(all_vals)) if all_vals else 0.0
        if vals:
            mean = sum(vals) / len(vals)
            std  = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5
        else:
            mean, std = float("nan"), float("nan")
        result[col] = {"mean": round(mean, 6), "std": round(std, 6),
                       "null_pct": round(null_pct * 100, 2)}
    return result


# ── Overall verdict ────────────────────────────────────────────────────────────

def _overall_verdict(layers: dict[str, dict]) -> str:
    verdicts = {v["verdict"] for v in layers.values()}
    if "FAIL" in verdicts:
        return "FAIL"
    if "WARN" in verdicts:
        return "WARN"
    return "PASS"


# ── Main validation entry point ────────────────────────────────────────────────

def validate(
    parquet_path: str | Path,
    instrument: str,
    date: str,
    output_dir: str | Path | None = None,
) -> dict[str, Any]:
    """
    Run three-layer validation on a feature Parquet file.

    Args:
        parquet_path:  Path to the Parquet file.
        instrument:    Instrument key (e.g. ``"nifty50"``).
        date:          ISO date string ``YYYY-MM-DD``.
        output_dir:    Where to write the validation JSON. Default:
                       ``data/validation/{date}/``.

    Returns:
        Validation result dict (also written to disk).

    Raises:
        ImportError: if pyarrow is not installed.
    """
    try:
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise ImportError("pyarrow required for validation") from exc

    from tick_feature_agent.output.emitter import COLUMN_NAMES

    parquet_path = Path(parquet_path)
    table = pq.read_table(parquet_path)
    n_rows = table.num_rows
    df_cols = table.schema.names

    # Extract column data as Python lists for validation
    def _col(name: str) -> list:
        if name not in df_cols:
            return []
        col_arr = table.column(name)
        return col_arr.to_pylist()

    ts_col = _col("timestamp")
    security_id_col = _col("underlying_security_id")

    # Build column dict for Layer 2 / Layer 3
    columns: dict[str, list] = {c: _col(c) for c in df_cols}

    layer1 = _layer1_structural(df_cols, n_rows, ts_col, security_id_col, COLUMN_NAMES)
    layer2 = _layer2_null_rates(columns, n_rows)
    layer3 = _layer3_statistical(columns, n_rows)

    layers = {"structural": layer1, "null_rates": layer2, "statistical": layer3}
    verdict = _overall_verdict(layers)

    daily_stats_cols = [
        "underlying_return_5ticks", "chain_pcr_global", "underlying_realized_vol_5",
        "zone_activity_score", "breakout_readiness",
    ]

    result: dict[str, Any] = {
        "instrument": instrument,
        "date": date,
        "verdict": verdict,
        "total_rows": n_rows,
        "layers": layers,
        "daily_stats": _daily_stats(columns, daily_stats_cols),
    }

    # Write output JSON
    if output_dir is None:
        output_dir = Path("data") / "validation" / date
    else:
        output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / f"{instrument}_validation.json"
    out_path.write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")

    return result


# ── CLI entry ─────────────────────────────────────────────────────────────────

def _cli():
    import argparse
    parser = argparse.ArgumentParser(
        description="TFA Feature Quality Validator — §17"
    )
    parser.add_argument("--instrument", required=True, help="Instrument key, e.g. nifty50")
    parser.add_argument("--date", required=True, help="ISO date YYYY-MM-DD")
    parser.add_argument("--features-dir", default="data/features",
                        help="Root directory for feature Parquet files")
    parser.add_argument("--output-dir", default=None,
                        help="Directory for validation JSON output")
    args = parser.parse_args()

    parquet_path = Path(args.features_dir) / args.date / f"{args.instrument}_features.parquet"
    if not parquet_path.exists():
        print(f"ERROR: Parquet file not found: {parquet_path}", file=sys.stderr)
        sys.exit(1)

    result = validate(
        parquet_path=parquet_path,
        instrument=args.instrument,
        date=args.date,
        output_dir=args.output_dir,
    )

    verdict = result["verdict"]
    print(f"{args.instrument} {args.date}: {verdict}")
    if verdict != "PASS":
        for layer, lr in result["layers"].items():
            for check, status in lr.get("checks", {}).items():
                if not status.startswith("PASS"):
                    print(f"  [{layer}] {check}: {status}")

    sys.exit(0 if verdict in ("PASS", "WARN") else 1)


if __name__ == "__main__":
    _cli()
