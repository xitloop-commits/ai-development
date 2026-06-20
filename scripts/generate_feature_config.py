"""
scripts/generate_feature_config.py — auto-rebuild model feature configs from
the live TFA schema (2026-06-20).

WHY: Every time TFA ships new feature columns (T37 order-book depth,
T14F premium acceleration, multi-TF momentum, etc.), the per-instrument
config/model_feature_config/{inst}_feature_config.json needs to know
about them or the trainer silently ignores them. That manual step kept
getting skipped — currently 112 useful feature columns are unused.

This script derives the feature list from the schema:

    features = schema_columns
             - MVP_TARGETS (the 84 heads the model predicts)
             - METADATA (timestamp, schema_version, etc.)
             - PER-INSTRUMENT exclusions (declared at the top of this file)

Run modes:
    --dry-run    (default)  Print summary + diff vs current; write nothing.
    --write                 Write `{inst}_feature_config_v11.json` (does NOT
                            overwrite the live one — operator inspects + copies).
    --adopt                 Write directly to the live `{inst}_feature_config.json`
                            after backing up the current one to .bak.

Usage::

    py scripts/generate_feature_config.py                  # dry-run
    py scripts/generate_feature_config.py --write          # write _v11
    py scripts/generate_feature_config.py --adopt          # overwrite live
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
if str(_REPO / "python_modules") not in sys.path:
    sys.path.insert(0, str(_REPO / "python_modules"))

import re

from _shared.targets import MVP_TARGETS  # noqa: E402

INSTRUMENTS = ("nifty50", "banknifty", "crudeoil", "naturalgas")

# Schema horizon-suffix pattern: trailing `_<digits>s` or
# `_<digits>s_magnitude` (e.g. "_30s", "_300s_magnitude").
_HORIZON_SUFFIX_RE = re.compile(r"_(\d+)s(_magnitude)?$")

# Columns that exist in the schema but are NOT features (they're either
# the target the model predicts, metadata for ops, or labels added by the
# replay pipeline that have no signal at inference time).
METADATA_COLUMNS: set[str] = {
    "timestamp",
    "underlying_security_id",
    "active_strikes",          # JSON array column — not a numeric feature
    "trading_state",           # categorical — handled specially
    "is_market_open",
    "schema_version",
    "event_idx",
    "event_id",
    "recv_ts",
    "date",
    "session_id",
}

# Per-instrument override list — features that exist in schema but the
# operator wants to keep out of training for THIS instrument specifically.
# (Currently empty; add here if e.g. a feature is known-broken on MCX.)
PER_INSTRUMENT_EXCLUDE: dict[str, set[str]] = {
    "nifty50": set(),
    "banknifty": set(),
    "crudeoil": set(),
    "naturalgas": set(),
}


def _load_schema_columns(schema_path: Path) -> list[str]:
    data = json.loads(schema_path.read_text(encoding="utf-8"))
    return list(data["columns"])


def _load_parquet_columns(parquet_path: Path) -> list[str]:
    """Read NUMERIC column names from a sample parquet — the GROUND TRUTH.

    The schema_registry/*.json files drift behind the actual parquet
    output (different horizon suffixes, sometimes missing freshly-added
    columns). Reading the parquet directly removes that risk.

    Non-numeric columns (`regime='TREND'`, `trading_state='TRADING'`,
    `instrument='nifty50'`, etc.) are filtered out here — the trainer's
    preprocessor casts everything to float32 and chokes on strings.

    `regime` is the one supported exception (2026-06-20): when the
    column is present, four binary one-hot expansions
    (`regime_TREND/RANGE/NEUTRAL/DEAD`) are emitted in its place so the
    classifier signal is visible to the model. The trainer mirrors this
    expansion at load time via ``_expand_regime_one_hot``.
    """
    import polars as pl
    schema = pl.scan_parquet(str(parquet_path)).collect_schema()
    string_like = {"String", "Utf8", "Categorical", "Boolean", "Date", "Datetime"}
    cols: list[str] = []
    for c, dt in schema.items():
        if any(s in str(dt) for s in string_like):
            if c == "regime":
                # Drop the string col; emit 4 one-hot variants instead so
                # the trainer side picks them up automatically. Keep
                # alphabetic order of the categories so feature_config
                # diffs are stable run-to-run.
                cols.extend([f"regime_{cat}" for cat in
                             ("DEAD", "NEUTRAL", "RANGE", "TREND")])
            continue
        cols.append(c)
    return cols


def _target_names() -> set[str]:
    return {t.name for t in MVP_TARGETS}


def _target_prefixes() -> set[str]:
    """Strip the `_<digits>s` suffix from each MVP target to get prefixes.

    Schema has more horizons than the trainer uses (e.g. `direction_30s`
    and `direction_900s` both exist; trainer may only fit `direction_120s`).
    Any column matching `{known_prefix}_<digits>s` is still a target —
    written by the replay pipeline as a label, not a feature.
    """
    prefixes: set[str] = set()
    for t in MVP_TARGETS:
        # `direction_30s` → strip `_30s` → `direction`
        # `direction_30s_magnitude` → strip `_30s_magnitude` → `direction`
        # `swing_continues_3600s` → strip `_3600s` → `swing_continues`
        m = _HORIZON_SUFFIX_RE.search(t.name)
        if m:
            prefixes.add(t.name[:m.start()])
        # If a target has no horizon suffix (rare), include it whole.
    return prefixes


def _is_target_column(col: str, prefixes: set[str]) -> bool:
    m = _HORIZON_SUFFIX_RE.search(col)
    if not m:
        return False
    prefix = col[:m.start()]
    return prefix in prefixes


def build_feature_list(
    schema_columns: list[str],
    instrument: str,
) -> list[str]:
    """Pure function: schema − targets − metadata − per-inst excludes."""
    prefixes = _target_prefixes()
    excludes_explicit = (
        _target_names()
        | METADATA_COLUMNS
        | PER_INSTRUMENT_EXCLUDE.get(instrument, set())
    )
    return [
        c for c in schema_columns
        if c not in excludes_explicit
        and not _is_target_column(c, prefixes)
    ]


def diff_summary(current: list[str], new: list[str]) -> dict:
    cs = set(current)
    ns = set(new)
    return {
        "current_count": len(cs),
        "new_count": len(ns),
        "added": sorted(ns - cs),
        "removed": sorted(cs - ns),
    }


def _print_per_instrument_summary(
    inst: str,
    schema_columns: list[str],
    config_dir: Path,
) -> tuple[list[str], dict]:
    new_features = build_feature_list(schema_columns, inst)
    current_path = config_dir / f"{inst}_feature_config.json"
    if current_path.exists():
        current = json.loads(current_path.read_text(encoding="utf-8"))[
            "final_features"
        ]
    else:
        current = []
    diff = diff_summary(current, new_features)
    print(f"\n  === {inst} ===")
    print(f"    current: {diff['current_count']} features")
    print(f"    new:     {diff['new_count']} features  "
          f"(+{len(diff['added'])} added, -{len(diff['removed'])} removed)")
    if diff["added"]:
        print(f"    added ({len(diff['added'])}):")
        for c in diff["added"][:20]:
            print(f"      + {c}")
        if len(diff["added"]) > 20:
            print(f"      ... and {len(diff['added']) - 20} more")
    if diff["removed"]:
        print(f"    REMOVED ({len(diff['removed'])}):")
        for c in diff["removed"][:20]:
            print(f"      - {c}")
        if len(diff["removed"]) > 20:
            print(f"      ... and {len(diff['removed']) - 20} more")
    return new_features, diff


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    p.add_argument(
        "--schema",
        default=str(_REPO / "config" / "schema_registry" / "v10.json"),
        help="Path to schema registry JSON. NOT the default any more — "
        "drifts behind reality. Prefer --sample-parquet for ground truth.",
    )
    p.add_argument(
        "--sample-parquet",
        default=str(_REPO / "data" / "features" / "2026-06-19" / "nifty50_features.parquet"),
        help="Sample parquet to read column names from. Ground truth — "
        "reflects whatever TFA is ACTUALLY writing today, not what the "
        "schema registry claims. Default: Jun 19 nifty50.",
    )
    p.add_argument(
        "--config-dir",
        default=str(_REPO / "config" / "model_feature_config"),
        help="Where the live per-instrument configs live.",
    )
    p.add_argument(
        "--instruments",
        nargs="+",
        default=list(INSTRUMENTS),
        help="Which instruments to rebuild (default: all).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        default=True,
        help="(default) Print summary + diff; write nothing.",
    )
    p.add_argument(
        "--write",
        action="store_true",
        help="Write to {inst}_feature_config_v11.json (does NOT overwrite "
        "the live config — operator inspects + copies).",
    )
    p.add_argument(
        "--adopt",
        action="store_true",
        help="Overwrite the live {inst}_feature_config.json directly. "
        "Backs up the original to .bak first.",
    )
    args = p.parse_args()

    config_dir = Path(args.config_dir)
    if not config_dir.exists():
        print(f"ERROR: config dir not found: {config_dir}")
        return 1

    # Prefer sample parquet (ground truth). Fall back to schema JSON only
    # if the parquet doesn't exist.
    sample_path = Path(args.sample_parquet)
    if sample_path.exists():
        schema_columns = _load_parquet_columns(sample_path)
        source_label = f"parquet  {sample_path.name}"
    else:
        schema_path = Path(args.schema)
        if not schema_path.exists():
            print(f"ERROR: neither sample parquet {sample_path} nor schema "
                  f"{schema_path} exists.")
            return 1
        schema_columns = _load_schema_columns(schema_path)
        source_label = f"schema   {schema_path.name}"
        print(f"WARN: sample parquet missing — falling back to schema JSON "
              f"(may drift behind reality).")
    print(f"\n  Source: {source_label}  ({len(schema_columns)} columns)")
    print(f"  Targets (heads): {len(_target_names())}")
    print(f"  Metadata cols:   {len(METADATA_COLUMNS)}")

    for inst in args.instruments:
        new_features, _ = _print_per_instrument_summary(
            inst, schema_columns, config_dir,
        )

        if args.adopt:
            live_path = config_dir / f"{inst}_feature_config.json"
            if live_path.exists():
                bak = live_path.with_suffix(".json.bak")
                shutil.copy2(live_path, bak)
                print(f"    backed up: {bak.name}")
            payload = {"final_features": new_features}
            live_path.write_text(
                json.dumps(payload, indent=2) + "\n", encoding="utf-8",
            )
            print(f"    ADOPTED: {live_path.name}")
        elif args.write:
            out_path = config_dir / f"{inst}_feature_config_v11.json"
            payload = {"final_features": new_features}
            out_path.write_text(
                json.dumps(payload, indent=2) + "\n", encoding="utf-8",
            )
            print(f"    written: {out_path.name}")
        # else dry-run: do nothing

    print()
    if not args.adopt and not args.write:
        print("  (dry-run — no files written.)")
        print("  Next: ``--write`` to inspect _v11 files, then ``--adopt`` to roll in.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
