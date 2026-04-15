"""
engine.py — SEA MVP inference loop.

Tails data/features/{instrument}_live.ndjson (the per-instrument live feature
stream written by TFA), runs inference on each new row, and writes
GO_CALL/GO_PUT signals to logs/signals/{instrument}/ — one NDJSON line per signal.

MVP thresholds (hardcoded, tune later):
  GO_CALL    direction_prob >= 0.62
             AND max_upside_pred >= 2.0  (₹)
             AND max_upside_pred > |max_drawdown_pred|
  GO_PUT     direction_prob <= 0.38
             AND max_drawdown_pred <= -2.0
             AND |max_drawdown_pred| > max_upside_pred
  WAIT       otherwise
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Path bootstrap
_HERE           = Path(__file__).resolve().parent
_PYTHON_MODULES = _HERE.parent
if str(_PYTHON_MODULES) not in sys.path:
    sys.path.insert(0, str(_PYTHON_MODULES))

import numpy as np

from model_training_agent.preprocessor import preprocess_live_tick
from signal_engine_agent.model_loader import load_models
from signal_engine_agent.signal_logger import SignalLogger

_IST = timezone(timedelta(hours=5, minutes=30))

# ── Default thresholds (CLI can override) ─────────────────────────────────
DIRECTION_PROB_CALL = 0.55
DIRECTION_PROB_PUT  = 0.45


def _decide(dir_prob: float, up_pred: float, dn_pred: float,
            call_thresh: float, put_thresh: float) -> str:
    """
    Return 'GO_CALL', 'GO_PUT', or 'WAIT'.

    MVP rule: use direction_prob only. The upside/drawdown predictions are
    stored alongside for context but aren't used for the decision yet — these
    regression models need more training data to be reliable. Once real data
    is collected the full spec rule (prob + RR + percentile) can be re-enabled.
    """
    if np.isnan(dir_prob):
        return "WAIT"
    if dir_prob >= call_thresh:
        return "GO_CALL"
    if dir_prob <= put_thresh:
        return "GO_PUT"
    return "WAIT"


def _tail(path: Path, poll_sec: float = 0.2):
    """
    Generator: yield each new line appended to `path`. Handles file rotation
    (if the file is truncated or recreated, we reopen from position 0).
    """
    pos = 0
    while True:
        if not path.exists():
            time.sleep(poll_sec)
            continue
        size = path.stat().st_size
        if size < pos:
            pos = 0   # file truncated / rotated
        with open(path, "r", encoding="utf-8") as f:
            f.seek(pos)
            while True:
                line = f.readline()
                if not line:
                    pos = f.tell()
                    break
                yield line.rstrip("\n")
            pos = f.tell()
        time.sleep(poll_sec)


def run(instrument: str,
        features_root: Path = Path("data/features"),
        call_thresh: float = DIRECTION_PROB_CALL,
        put_thresh: float  = DIRECTION_PROB_PUT) -> None:
    live_path = features_root / f"{instrument}_live.ndjson"

    print()
    print(f"  SEA -- {instrument}")
    print(f"  Tail: {live_path}")
    models = load_models(instrument)
    print(f"  Model version: {models.version}")
    print(f"  Features: {len(models.feature_names)}")
    print(f"  Thresholds: GO_CALL >= {call_thresh}, GO_PUT <= {put_thresh}")
    print()

    logger = SignalLogger(instrument)
    processed = 0
    emitted_call = 0
    emitted_put = 0
    started = time.time()

    try:
        for line in _tail(live_path):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue

            vec = preprocess_live_tick(row, models.feature_config)
            if vec is None:
                continue
            X = vec.reshape(1, -1)

            # direction_30s booster trained as binary classifier — predict() returns
            # probability of class 1 (up) directly for binary objective
            dir_prob = float(models.models["direction_30s"].predict(X)[0])
            up_pred  = float(models.models["max_upside_30s"].predict(X)[0])
            dn_pred  = float(models.models["max_drawdown_30s"].predict(X)[0])

            direction = _decide(dir_prob, up_pred, dn_pred, call_thresh, put_thresh)
            processed += 1

            if direction == "GO_CALL":
                emitted_call += 1
            elif direction == "GO_PUT":
                emitted_put += 1

            if direction != "WAIT":
                signal = {
                    "timestamp": row.get("timestamp"),
                    "timestamp_ist": datetime.now(_IST).isoformat(timespec="milliseconds"),
                    "instrument": instrument.upper(),
                    "direction": direction,
                    "direction_prob_30s": round(dir_prob, 4),
                    "max_upside_pred_30s": round(up_pred, 2),
                    "max_drawdown_pred_30s": round(dn_pred, 2),
                    "atm_strike": row.get("atm_strike"),
                    "atm_ce_ltp": row.get("opt_0_ce_ltp"),
                    "atm_pe_ltp": row.get("opt_0_pe_ltp"),
                    "spot_price": row.get("spot_price"),
                    "momentum":   row.get("underlying_momentum"),
                    "breakout":   row.get("breakout_readiness"),
                    "model_version": models.version,
                }
                logger.log(signal)
                # Also print to terminal for visibility
                ts_short = datetime.now(_IST).strftime("%H:%M:%S")
                print(f"  [{ts_short}] {direction:<8}  "
                      f"prob={dir_prob:.3f}  "
                      f"up={up_pred:+.2f}  dn={dn_pred:+.2f}  "
                      f"atm={row.get('atm_strike')}")

            # Periodic heartbeat
            if processed % 500 == 0:
                elapsed = time.time() - started
                rate = processed / max(elapsed, 0.001)
                sys.stdout.write(
                    f"\r  [stats] processed={processed:,}  "
                    f"CALL={emitted_call}  PUT={emitted_put}  "
                    f"rate={rate:.1f}/s"
                )
                sys.stdout.flush()
    except KeyboardInterrupt:
        print("\n  Stopping SEA...")
    finally:
        logger.close()


def main() -> int:
    p = argparse.ArgumentParser(prog="sea")
    p.add_argument("--instrument", required=True,
                   choices=("nifty50", "banknifty", "crudeoil", "naturalgas"))
    p.add_argument("--features-root", default="data/features")
    p.add_argument("--call-thresh", type=float, default=DIRECTION_PROB_CALL,
                   help=f"GO_CALL fires when direction_prob >= this (default {DIRECTION_PROB_CALL})")
    p.add_argument("--put-thresh", type=float, default=DIRECTION_PROB_PUT,
                   help=f"GO_PUT fires when direction_prob <= this (default {DIRECTION_PROB_PUT})")
    args = p.parse_args()
    run(args.instrument, Path(args.features_root),
        call_thresh=args.call_thresh, put_thresh=args.put_thresh)
    return 0


if __name__ == "__main__":
    sys.exit(main())
