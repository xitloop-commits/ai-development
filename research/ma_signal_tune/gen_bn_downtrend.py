"""
Build today's BankNifty underlying view: 1-min candles + 20-EMA MA line (with its
UP/DOWN/FLAT state) + ONLY the downtrend (PE) legs' entry/exit, using the REAL
production detector and the live banknifty.json thresholds. Emits JSON for the chart.
"""
from __future__ import annotations
import glob, json, os, sys
import pandas as pd

sys.path.insert(0, os.path.abspath("python_modules"))
from signal_engine_agent.ma_signal import MASignalDetector
from signal_engine_agent.thresholds import load_thresholds_ma_signal

DATE = "2026-07-15"
F = f"data/features/{DATE}/banknifty_features.parquet"

cfg = load_thresholds_ma_signal("config/sea_thresholds/banknifty.json")
print(f"cfg: ema={cfg.ema_period} look={cfg.slope_lookback} thr_hi={cfg.thr_hi} thr_lo={cfg.thr_lo}",
      file=sys.stderr)

df = pd.read_parquet(F, columns=["timestamp", "underlying_ltp"]).dropna()
ticks = list(zip(df["timestamp"].tolist(), df["underlying_ltp"].tolist()))

# 1-min OHLC candles from ticks
candles = {}
for ts, spot in ticks:
    m = int(ts // 60)
    c = candles.get(m)
    if c is None:
        candles[m] = [spot, spot, spot, spot]  # o,h,l,c
    else:
        c[1] = max(c[1], spot); c[2] = min(c[2], spot); c[3] = spot
mins = sorted(candles)
closes = {m: candles[m][3] for m in mins}

# 20-EMA of 1-min closes + slope-state (mirror the detector's math, for line colour)
a = 2.0 / (cfg.ema_period + 1)
ema_by_min, ema_prev, ema_list = {}, None, []
for m in mins:
    ema_prev = closes[m] if ema_prev is None else a * closes[m] + (1 - a) * ema_prev
    ema_by_min[m] = ema_prev
    ema_list.append(ema_prev)
state_by_min, st = {}, "FLAT"
for i, m in enumerate(mins):
    if i >= cfg.slope_lookback:
        base = ema_list[i - cfg.slope_lookback]
        sl = (ema_list[i] - base) / base * 100 if base else 0.0
        if st == "FLAT":
            st = "UP" if sl > cfg.thr_hi else "DOWN" if sl < -cfg.thr_hi else "FLAT"
        elif st == "UP":
            st = "DOWN" if sl < -cfg.thr_hi else "FLAT" if sl < cfg.thr_lo else "UP"
        else:
            st = "UP" if sl > cfg.thr_hi else "FLAT" if sl > -cfg.thr_lo else "DOWN"
    state_by_min[m] = st

# Replay detector -> DOWN legs only (LONG_PE entry -> its exit)
det = MASignalDetector(cfg)
open_pe = None
down_legs = []
last = None
for ts, spot in ticks:
    last = (ts, spot)
    for ev in det.on_tick(ts, spot):
        if ev == "LONG_PE":
            open_pe = (ts, spot)
        elif ev in ("EXIT_PE", "LONG_CE") and open_pe is not None:
            # a PE leg ends on its own EXIT_PE, or when an up-leg starts
            down_legs.append({"entry_t": open_pe[0], "entry_spot": open_pe[1],
                              "exit_t": ts, "exit_spot": spot})
            open_pe = None
if open_pe is not None:  # still open at EOD
    down_legs.append({"entry_t": open_pe[0], "entry_spot": open_pe[1],
                      "exit_t": last[0], "exit_spot": last[1], "open": True})

out = {
    "date": DATE, "instrument": "BANKNIFTY",
    "cfg": {"ema": cfg.ema_period, "look": cfg.slope_lookback,
            "thr_hi": cfg.thr_hi, "thr_lo": cfg.thr_lo},
    "candles": [{"t": m * 60, "o": candles[m][0], "h": candles[m][1],
                 "l": candles[m][2], "c": candles[m][3],
                 "ema": round(ema_by_min[m], 2), "st": state_by_min[m]} for m in mins],
    "down_legs": down_legs,
}
path = os.path.join(os.environ.get("OUT", "."), "bn_downtrend.json")
with open(path, "w") as fh:
    json.dump(out, fh)
print(f"wrote {path}: {len(out['candles'])} candles, {len(down_legs)} down legs", file=sys.stderr)
for lg in down_legs:
    def hm(t):
        import time
        return time.strftime("%H:%M", time.gmtime(t + 330 * 60))
    won = lg["entry_spot"] - lg["exit_spot"]
    print(f"  PE {hm(lg['entry_t'])}->{hm(lg['exit_t'])}  {lg['entry_spot']:.0f}->{lg['exit_spot']:.0f}  "
          f"spot {'FELL' if won>0 else 'ROSE'} {abs(won):.0f}", file=sys.stderr)
