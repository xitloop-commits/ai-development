"""For ticks that passed `current` gate, count why multi_horizon would reject them.

Three extra conditions on top of `current`:
  C0a — any of direction_prob_30s/300s/900s is NaN (missing horizon model)
  C0b — direction sides disagree across 30s/300s/900s
  C4  — max(d900, 1-d900) < 0.70

Per (day, instrument), count how often each kills a current-gate-passed tick.
"""
from __future__ import annotations

import math, sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent
sys.path.insert(0, str(_REPO / "python_modules"))
import os
os.chdir(_REPO)

import pyarrow.parquet as pq

from model_training_agent.preprocessor import preprocess_live_tick
from signal_engine_agent.model_loader import load_models
from signal_engine_agent.thresholds import decide_action, load_thresholds

_IST = timezone(timedelta(hours=5, minutes=30))
DAYS = ["2026-04-22", "2026-04-29"]
INSTRUMENTS = ["nifty50", "banknifty", "crudeoil", "naturalgas"]
PROB_900_MIN = 0.70
SESSION_HOURS = {
    "nifty50":(9,15,15,30), "banknifty":(9,15,15,30),
    "crudeoil":(9,0,23,30), "naturalgas":(9,0,23,30),
}

def in_session(ts, inst):
    sh,sm,eh,em = SESSION_HOURS[inst]
    dt = datetime.fromtimestamp(ts, tz=_IST)
    return dt.replace(hour=sh,minute=sm,second=0,microsecond=0) <= dt <= dt.replace(hour=eh,minute=em,second=0,microsecond=0)

def gather(models, X):
    def p(n):
        m = models.models.get(n)
        return float(m.predict(X)[0]) if m else float("nan")
    return {
        "direction_prob_30s":  p("direction_30s"),
        "direction_prob_300s": p("direction_300s"),
        "direction_prob_900s": p("direction_900s"),
        "risk_reward_ratio_30s": p("risk_reward_ratio_30s"),
        "max_upside_30s": p("max_upside_30s"),
        "max_drawdown_30s": p("max_drawdown_30s"),
    }

for day in DAYS:
    print(f"\n=========== {day} ===========")
    for inst in INSTRUMENTS:
        path = Path(f"data/features/{day}/{inst}_features.parquet")
        if not path.exists():
            print(f"  [SKIP] {inst}: no parquet")
            continue
        models = load_models(inst)
        thr = load_thresholds(inst, Path("config/sea_thresholds"))
        table = pq.read_table(path)
        col = {c: table.column(c).to_pylist() for c in table.schema.names}
        n = table.num_rows

        current_passed = 0
        only_C0_missing = 0
        only_C0_mismatch = 0
        only_C4 = 0
        both_mismatch_C4 = 0
        d900_bins = Counter()  # quantize d900 conviction
        side_pairs = Counter()  # (side30, side300, side900)

        for i in range(n):
            row = {c: col[c][i] for c in col}
            ts = row.get("timestamp")
            if ts is None or not in_session(ts, inst): continue
            if row.get("trading_state") != "TRADING": continue
            if row.get("data_quality_flag") == 0: continue

            vec = preprocess_live_tick(row, models.feature_config)
            if vec is None: continue
            X = vec.reshape(1,-1)
            preds = gather(models, X)
            try:
                preds["upside_percentile_30s"] = float(row.get("upside_percentile_30s") or float("nan"))
            except: preds["upside_percentile_30s"] = float("nan")

            ce = row.get("opt_0_ce_ltp"); pe = row.get("opt_0_pe_ltp")
            sig = decide_action(preds, thr, ce_ltp=ce, pe_ltp=pe)
            if not sig.gate_passed: continue
            current_passed += 1

            d30 = preds["direction_prob_30s"]
            d300 = preds["direction_prob_300s"]
            d900 = preds["direction_prob_900s"]

            missing = any(v is None or (isinstance(v, float) and math.isnan(v)) for v in (d30, d300, d900))
            mismatch = (not missing) and not ((d30 > 0.5) == (d300 > 0.5) == (d900 > 0.5))
            prob900 = (max(d900, 1-d900)) if not missing else 0.0
            c4_fail = (not missing) and prob900 < PROB_900_MIN

            if not missing:
                d900_bins[round(prob900, 1)] += 1
                s30 = "B" if d30 > 0.5 else "b"
                s300 = "B" if d300 > 0.5 else "b"
                s900 = "B" if d900 > 0.5 else "b"
                side_pairs[s30+s300+s900] += 1

            if missing: only_C0_missing += 1
            elif mismatch and c4_fail: both_mismatch_C4 += 1
            elif mismatch: only_C0_mismatch += 1
            elif c4_fail: only_C4 += 1

        survived = current_passed - only_C0_missing - only_C0_mismatch - only_C4 - both_mismatch_C4
        print(f"  {inst:11} current={current_passed:5} | C0_miss={only_C0_missing:4}  C0_mismatch={only_C0_mismatch:4}  C4={only_C4:4}  both={both_mismatch_C4:4}  → multi_horizon={survived}")
        if d900_bins:
            top = sorted(d900_bins.items())
            print(f"     d900 conviction bins: {dict(top)}")
        if side_pairs:
            print(f"     side patterns (30/300/900): {dict(side_pairs.most_common())}")