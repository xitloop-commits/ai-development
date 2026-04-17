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
NEUTRAL_HIGH_PROB   = 0.72   # NEUTRAL regime → only LONG if prob very high


def _decide(dir_prob: float, up_pred: float, dn_pred: float,
            regime: str | None, ce_ltp: float | None, pe_ltp: float | None,
            call_thresh: float, put_thresh: float) -> dict:
    """
    Route to LONG_CE / LONG_PE / SHORT_CE / SHORT_PE / WAIT.

    Regime is the primary router:
      TREND    → LONG (directional, movement-driven)
      RANGE    → SHORT (premium selling, decay-driven)
      DEAD     → SHORT (if there's an edge) or WAIT
      NEUTRAL  → LONG only if prob very high (>0.72), else WAIT

    Returns dict with: action, entry, tp, sl, rr
    """
    result = {"action": "WAIT", "entry": 0.0, "tp": 0.0, "sl": 0.0, "rr": 0.0}

    if np.isnan(dir_prob):
        return result

    regime = (regime or "").upper()
    is_bullish = dir_prob >= call_thresh
    is_bearish = dir_prob <= put_thresh

    # ── TREND regime → LONG (go with the move) ──
    if regime == "TREND":
        if is_bullish and ce_ltp:
            result["action"] = "LONG_CE"
            result["entry"] = ce_ltp
            result["tp"] = ce_ltp + abs(up_pred)
            result["sl"] = ce_ltp - abs(dn_pred)
        elif is_bearish and pe_ltp:
            result["action"] = "LONG_PE"
            result["entry"] = pe_ltp
            result["tp"] = pe_ltp + abs(up_pred)
            result["sl"] = pe_ltp - abs(dn_pred)

    # ── RANGE / DEAD → SHORT (sell premium, collect decay) ──
    elif regime in ("RANGE", "DEAD"):
        if is_bearish and ce_ltp:
            # No upward move expected → sell CE
            result["action"] = "SHORT_CE"
            result["entry"] = ce_ltp
            result["sl"] = ce_ltp + abs(up_pred)     # risk: price goes up
            result["tp"] = ce_ltp - abs(dn_pred)     # profit: CE decays
        elif is_bullish and pe_ltp:
            # No downward move expected → sell PE
            result["action"] = "SHORT_PE"
            result["entry"] = pe_ltp
            result["sl"] = pe_ltp + abs(up_pred)     # risk: price goes down
            result["tp"] = pe_ltp - abs(dn_pred)     # profit: PE decays

    # ── NEUTRAL → only LONG if prob very high ──
    elif regime == "NEUTRAL" or not regime:
        if dir_prob >= NEUTRAL_HIGH_PROB and ce_ltp:
            result["action"] = "LONG_CE"
            result["entry"] = ce_ltp
            result["tp"] = ce_ltp + abs(up_pred)
            result["sl"] = ce_ltp - abs(dn_pred)
        elif dir_prob <= (1 - NEUTRAL_HIGH_PROB) and pe_ltp:
            result["action"] = "LONG_PE"
            result["entry"] = pe_ltp
            result["tp"] = pe_ltp + abs(up_pred)
            result["sl"] = pe_ltp - abs(dn_pred)

    # ── Compute RR ──
    if result["action"] != "WAIT" and result["entry"] > 0:
        tp_dist = abs(result["tp"] - result["entry"])
        sl_dist = abs(result["sl"] - result["entry"])
        result["rr"] = round(tp_dist / sl_dist, 2) if sl_dist > 0 else 0.0

    return result


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
    emitted_long = 0
    emitted_short = 0
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

            # Extract context from raw row (before preprocessing strips them)
            regime  = row.get("regime")
            ce_ltp  = row.get("opt_0_ce_ltp")
            pe_ltp  = row.get("opt_0_pe_ltp")

            result = _decide(
                dir_prob, up_pred, dn_pred,
                regime, ce_ltp, pe_ltp,
                call_thresh, put_thresh,
            )
            action = result["action"]
            processed += 1

            if "LONG" in action:
                emitted_long += 1
            elif "SHORT" in action:
                emitted_short += 1

            if action != "WAIT":
                signal = {
                    "timestamp": row.get("timestamp"),
                    "timestamp_ist": datetime.now(_IST).isoformat(timespec="milliseconds"),
                    "instrument": instrument.upper(),
                    "action": action,
                    "direction_prob_30s": round(dir_prob, 4),
                    "max_upside_pred_30s": round(up_pred, 2),
                    "max_drawdown_pred_30s": round(dn_pred, 2),
                    "regime": regime,
                    "entry": round(result["entry"], 2),
                    "tp": round(result["tp"], 2),
                    "sl": round(result["sl"], 2),
                    "rr": result["rr"],
                    "atm_strike": row.get("atm_strike"),
                    "atm_ce_ltp": ce_ltp,
                    "atm_pe_ltp": pe_ltp,
                    "spot_price": row.get("spot_price"),
                    "momentum":   row.get("underlying_momentum"),
                    "breakout":   row.get("breakout_readiness"),
                    "model_version": models.version,
                    # Backward compat: map action to old direction field
                    "direction": "GO_CALL" if "CE" in action else "GO_PUT",
                }
                logger.log(signal)
                ts_short = datetime.now(_IST).strftime("%H:%M:%S")
                print(f"  [{ts_short}] {action:<10}  "
                      f"prob={dir_prob:.3f}  regime={regime or '-':<7}  "
                      f"entry={result['entry']:.1f}  "
                      f"TP={result['tp']:.1f}  SL={result['sl']:.1f}  "
                      f"RR={result['rr']:.1f}")

            # Periodic heartbeat
            if processed % 500 == 0:
                elapsed = time.time() - started
                rate = processed / max(elapsed, 0.001)
                sys.stdout.write(
                    f"\r  [stats] processed={processed:,}  "
                    f"LONG={emitted_long}  SHORT={emitted_short}  "
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
