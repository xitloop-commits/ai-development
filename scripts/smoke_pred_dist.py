import json
import sys
from pathlib import Path

sys.path.insert(0, "python_modules")

import numpy as np

from model_training_agent.preprocessor import LiveTickPreprocessor
from signal_engine_agent.engine import _gather_predictions
from signal_engine_agent.model_loader import load_models

models = load_models("nifty50")
pp = LiveTickPreprocessor(models.feature_config)

with open("data/features/nifty50_live.ndjson") as f:
    lines = f.readlines()
sl = lines[10000:10500]

vals = {k: [] for k in [
    "direction_prob_60s",
    "risk_reward_ratio_60s",
    "direction_persists_60s",
    "direction_persists_300s",
    "exit_signal_60s",
    "max_upside_60s",
    "max_drawdown_60s",
]}
pct60_row = []

for ln in sl:
    row = json.loads(ln)
    vec = pp.process(row)
    if vec is None:
        continue
    preds = _gather_predictions(models, vec.reshape(1, -1))
    for k in vals:
        v = preds.get(k, float("nan"))
        if not np.isnan(v):
            vals[k].append(v)
    p = row.get("upside_percentile_60s")
    if p is not None:
        pct60_row.append(p)

print(f"  rows processed: {len(vals['direction_prob_60s'])}")
print()
print(f"  {'target':30s} min     max     mean    std")
for k, arr in vals.items():
    a = np.asarray(arr)
    if len(a) == 0:
        print(f"  {k:30s} EMPTY")
        continue
    print(f"  {k:30s} {a.min():.4f}  {a.max():.4f}  {a.mean():.4f}  {a.std():.4f}")
a = np.asarray(pct60_row)
print(f"  {'upside_percentile_60s (row)':30s} {a.min():.2f}    {a.max():.2f}   {a.mean():.2f}   {a.std():.2f}")
