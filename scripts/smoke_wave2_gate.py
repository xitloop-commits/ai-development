"""
scripts/smoke_wave2_gate.py — one-off pre-flight smoke for the Wave 2 gate.

Loads the LATEST nifty50 (or whichever) Wave 2 models, replays the last N
rows of `data/features/{instrument}_live.ndjson` through the same per-tick
pipeline `engine.run()` uses for `gate_mode="wave2"`, and prints the
action / fail-reason distribution.

No file I/O side-effects, no signal logging. Just `print()`.

Run:
    py scripts/smoke_wave2_gate.py --instrument nifty50 --n 500
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent
_PYMOD = _REPO / "python_modules"
if str(_PYMOD) not in sys.path:
    sys.path.insert(0, str(_PYMOD))

from model_training_agent.preprocessor import LiveTickPreprocessor
from signal_engine_agent.engine import _gather_predictions
from signal_engine_agent.model_loader import load_models
from signal_engine_agent.thresholds import (
    Thresholds,
    Wave2Thresholds,
    decide_action_wave2,
    load_thresholds_full,
)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--instrument", default="nifty50")
    ap.add_argument("--n", type=int, default=500, help="rows to replay")
    ap.add_argument("--offset", type=int, default=None, help="row offset (default: tail)")
    ap.add_argument(
        "--features-root", type=Path, default=Path("data/features"),
    )
    args = ap.parse_args()

    live_path = args.features_root / f"{args.instrument}_live.ndjson"
    if not live_path.exists():
        print(f"  ERROR: {live_path} missing")
        sys.exit(2)

    print(f"\n  Loading models for {args.instrument} ...")
    models = load_models(args.instrument)
    print(f"  Version: {models.version}")
    print(f"  Model count: {len(models.models)}")
    print(f"  Features: {len(models.feature_names)}")

    # Load per-instrument thresholds from config/sea_thresholds/<inst>.json
    # so the smoke reflects what production SEA will use.
    config_dir = _REPO / "config" / "sea_thresholds"
    thresholds, _v2, wave2_thresholds, gate_mode = load_thresholds_full(
        args.instrument, config_dir
    )
    print(f"  Gate mode: {gate_mode}")
    print(f"  Base:  prob_min={thresholds.prob_min}  rr_min={thresholds.rr_min}  "
          f"pctile_min={thresholds.upside_percentile_min}")
    print(f"  Wave2: persists_60s_min={wave2_thresholds.persists_60s_min}  "
          f"persists_300s_min={wave2_thresholds.persists_300s_min}  "
          f"exit_60s_max={wave2_thresholds.exit_signal_60s_max}  "
          f"breakout_60s_min={wave2_thresholds.breakout_in_60s_min}")
    preprocessor = LiveTickPreprocessor(models.feature_config)

    with open(live_path, encoding="utf-8") as f:
        lines = f.readlines()
    if args.offset is not None:
        tail = lines[args.offset:args.offset + args.n]
        print(f"  Replaying rows [{args.offset}:{args.offset + args.n}] from {live_path.name}\n")
    else:
        tail = lines[-args.n:]
        print(f"  Replaying last {len(tail)} rows from {live_path.name}\n")

    actions: Counter[str] = Counter()
    fail_reasons: Counter[str] = Counter()
    parse_errors = 0
    null_vec = 0
    decisions: list[dict] = []

    for line in tail:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            parse_errors += 1
            continue

        vec = preprocessor.process(row)
        if vec is None:
            null_vec += 1
            continue
        X = vec.reshape(1, -1)

        preds = _gather_predictions(models, X)
        # Mirror engine.py: pull session-rank pctile from the row
        _pct60 = row.get("upside_percentile_60s")
        preds["upside_percentile_60s"] = float(_pct60) if _pct60 is not None else float("nan")
        _pct30 = row.get("upside_percentile_30s")
        preds["upside_percentile_30s"] = float(_pct30) if _pct30 is not None else float("nan")

        ce_ltp = row.get("opt_0_ce_ltp")
        pe_ltp = row.get("opt_0_pe_ltp")

        sig = decide_action_wave2(
            preds, thresholds, wave2_thresholds,
            ce_ltp=ce_ltp, pe_ltp=pe_ltp,
        )
        actions[sig.action] += 1
        for r in sig.gate_reasons:
            fail_reasons[r] += 1

        if sig.action != "WAIT":
            decisions.append({
                "ts": row.get("timestamp_ist"),
                "action": sig.action,
                "direction": sig.direction,
                "entry": round(sig.entry, 2),
                "tp": round(sig.tp, 2),
                "sl": round(sig.sl, 2),
                "rr": round(sig.rr, 2),
                "prob60": round(preds.get("direction_prob_60s", float("nan")), 3),
                "persists60": round(preds.get("direction_persists_60s", float("nan")), 3),
                "exit60": round(preds.get("exit_signal_60s", float("nan")), 3),
            })

    print("  -- Action distribution --")
    total = sum(actions.values())
    for a, c in actions.most_common():
        pct = 100.0 * c / total if total else 0.0
        print(f"    {a:10s} {c:6d}  ({pct:5.1f}%)")
    print(f"    parse_errors: {parse_errors}, preproc_null: {null_vec}")

    print("\n  -- Top gate fail reasons --")
    for r, c in fail_reasons.most_common(15):
        print(f"    {r:25s} {c}")

    print(f"\n  -- First 10 LONG_* decisions (total: {len(decisions)}) --")
    for d in decisions[:10]:
        print(f"    {d}")


if __name__ == "__main__":
    main()
