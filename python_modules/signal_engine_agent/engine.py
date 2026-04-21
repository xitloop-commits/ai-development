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
from signal_engine_agent.trade_filter import TradeFilter, TickDecision

_IST = timezone(timedelta(hours=5, minutes=30))

# ── Default thresholds (CLI can override) ─────────────────────────────────
DIRECTION_PROB_CALL = 0.55
DIRECTION_PROB_PUT  = 0.45
NEUTRAL_HIGH_PROB   = 0.72   # NEUTRAL regime → only LONG if prob very high


def _decide(dir_prob: float, up_pred: float, dn_pred: float,
            regime: str | None, ce_ltp: float | None, pe_ltp: float | None,
            call_thresh: float, put_thresh: float,
            up_pred_swing: float = float('nan'),
            dn_pred_swing: float = float('nan')) -> dict:
    """
    Route to LONG_CE / LONG_PE / SHORT_CE / SHORT_PE / WAIT.

    Regime is the primary router:
      TREND    → LONG (directional, movement-driven)
      RANGE    → SHORT (premium selling, decay-driven)
      DEAD     → SHORT (if there's an edge) or WAIT
      NEUTRAL  → LONG only if prob very high (>0.72), else WAIT

    TP/SL uses swing predictions (5min/15min) if available, falls back to 30s.

    Returns dict with: action, entry, tp, sl, rr
    """
    result = {"action": "WAIT", "entry": 0.0, "tp": 0.0, "sl": 0.0, "rr": 0.0}

    if np.isnan(dir_prob):
        return result

    # Use swing predictions for TP/SL if available, else fall back to 30s
    tp_up = up_pred_swing if not np.isnan(up_pred_swing) else up_pred
    tp_dn = dn_pred_swing if not np.isnan(dn_pred_swing) else dn_pred

    regime = (regime or "").upper()
    is_bullish = dir_prob >= call_thresh
    is_bearish = dir_prob <= put_thresh

    # ── TREND regime → LONG (go with the move) ──
    if regime == "TREND":
        if is_bullish and ce_ltp:
            result["action"] = "LONG_CE"
            result["entry"] = ce_ltp
            result["tp"] = ce_ltp + abs(tp_up)
            result["sl"] = ce_ltp - abs(tp_dn)
        elif is_bearish and pe_ltp:
            result["action"] = "LONG_PE"
            result["entry"] = pe_ltp
            result["tp"] = pe_ltp + abs(tp_up)
            result["sl"] = pe_ltp - abs(tp_dn)

    # ── RANGE / DEAD → SHORT (sell premium, collect decay) ──
    elif regime in ("RANGE", "DEAD"):
        if is_bearish and ce_ltp:
            result["action"] = "SHORT_CE"
            result["entry"] = ce_ltp
            result["sl"] = ce_ltp + abs(tp_up)
            result["tp"] = ce_ltp - abs(tp_dn)
        elif is_bullish and pe_ltp:
            result["action"] = "SHORT_PE"
            result["entry"] = pe_ltp
            result["sl"] = pe_ltp + abs(tp_up)
            result["tp"] = pe_ltp - abs(tp_dn)

    # ── NEUTRAL → only LONG if prob very high ──
    elif regime == "NEUTRAL" or not regime:
        if dir_prob >= NEUTRAL_HIGH_PROB and ce_ltp:
            result["action"] = "LONG_CE"
            result["entry"] = ce_ltp
            result["tp"] = ce_ltp + abs(tp_up)
            result["sl"] = ce_ltp - abs(tp_dn)
        elif dir_prob <= (1 - NEUTRAL_HIGH_PROB) and pe_ltp:
            result["action"] = "LONG_PE"
            result["entry"] = pe_ltp
            result["tp"] = pe_ltp + abs(tp_up)
            result["sl"] = pe_ltp - abs(tp_dn)

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
        put_thresh: float  = DIRECTION_PROB_PUT,
        sustained_n: int = 5,
        avg_prob_thresh: float = 0.65,
        filter_cooldown_sec: float = 60.0) -> None:
    live_path = features_root / f"{instrument}_live.ndjson"

    print()
    print(f"  SEA -- {instrument}")
    print(f"  Tail: {live_path}")
    models = load_models(instrument)
    print(f"  Model version: {models.version}")
    print(f"  Features: {len(models.feature_names)}")
    print(f"  Thresholds: GO_CALL >= {call_thresh}, GO_PUT <= {put_thresh}")
    print(f"  Filter: sustained={sustained_n}, avg_prob>={avg_prob_thresh}, cooldown={filter_cooldown_sec}s")
    print()

    raw_logger = SignalLogger(instrument)
    filtered_logger = SignalLogger(instrument, root=Path("logs/signals"), suffix="_filtered")
    trade_filter = TradeFilter(
        sustained_n=sustained_n,
        avg_prob_threshold=avg_prob_thresh,
        cooldown_sec=filter_cooldown_sec,
    )
    processed = 0
    raw_signals = 0
    filtered_signals = 0
    started = time.time()

    # ── Raw signal cooldown (existing behavior, kept for UI feed) ──
    COOLDOWN_SEC = 30
    _last_action: str = ""
    _last_emit_ts: float = 0.0

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

            # Run all available models
            def _pred(name: str) -> float:
                m = models.models.get(name)
                return float(m.predict(X)[0]) if m else float('nan')

            dir_prob = _pred("direction_30s")
            up_pred  = _pred("max_upside_30s")
            dn_pred  = _pred("max_drawdown_30s")
            rr_pred  = _pred("risk_reward_ratio_30s")
            mag_pred = _pred("direction_30s_magnitude")

            # Swing predictions for TP/SL (prefer 15min, fallback to 5min, then 30s)
            up_swing = _pred("max_upside_900s")
            dn_swing = _pred("max_drawdown_900s")
            if np.isnan(up_swing):
                up_swing = _pred("max_upside_300s")
            if np.isnan(dn_swing):
                dn_swing = _pred("max_drawdown_300s")

            # Extract context from raw row (before preprocessing strips them)
            regime  = row.get("regime")
            ce_ltp  = row.get("opt_0_ce_ltp")
            pe_ltp  = row.get("opt_0_pe_ltp")

            result = _decide(
                dir_prob, up_pred, dn_pred,
                regime, ce_ltp, pe_ltp,
                call_thresh, put_thresh,
                up_pred_swing=up_swing,
                dn_pred_swing=dn_swing,
            )
            action = result["action"]
            processed += 1

            # ── Raw signal emission (existing, for UI signal feed) ──
            now_ts = time.time()
            should_emit_raw = (
                action != "WAIT"
                and (action != _last_action or now_ts - _last_emit_ts >= COOLDOWN_SEC)
            )

            if should_emit_raw:
                _last_action = action
                _last_emit_ts = now_ts
                raw_signals += 1
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
                    "atm_ce_security_id": row.get("atm_ce_security_id"),
                    "atm_pe_security_id": row.get("atm_pe_security_id"),
                    "spot_price": row.get("spot_price"),
                    "momentum":   row.get("underlying_momentum"),
                    "breakout":   row.get("breakout_readiness"),
                    "model_version": models.version,
                    "direction": "GO_CALL" if "CE" in action else "GO_PUT",
                }
                raw_logger.log(signal)

            # ── Filtered trade recommendation (3-stage filter) ──
            tick_decision = TickDecision(
                timestamp=row.get("timestamp") or now_ts,
                action=action,
                direction_prob=dir_prob,
                max_upside_pred=up_pred,
                max_drawdown_pred=dn_pred,
                risk_reward_pred=rr_pred,
                magnitude_pred=mag_pred,
                regime=regime,
                entry=result["entry"],
                tp=result["tp"],
                sl=result["sl"],
                rr=result["rr"],
            )

            rec = trade_filter.evaluate(tick_decision)
            if rec is not None:
                filtered_signals += 1
                ts_short = datetime.now(_IST).strftime("%H:%M:%S")
                print(f"  [{ts_short}] [TRADE] {rec.action:<10}  "
                      f"{rec.confidence}  score={rec.score}/6  "
                      f"sustained={rec.sustained_ticks}  "
                      f"avg_prob={rec.avg_prob:.3f}  "
                      f"entry={rec.entry:.1f}  "
                      f"TP={rec.tp:.1f}  SL={rec.sl:.1f}  "
                      f"RR={rec.rr:.1f}")
                filtered_logger.log({
                    "timestamp": rec.timestamp,
                    "timestamp_ist": datetime.now(_IST).isoformat(timespec="milliseconds"),
                    "instrument": instrument.upper(),
                    "action": rec.action,
                    "confidence": rec.confidence,
                    "score": rec.score,
                    "sustained_ticks": rec.sustained_ticks,
                    "avg_prob": rec.avg_prob,
                    "min_prob": rec.min_prob,
                    "entry": round(rec.entry, 2),
                    "tp": round(rec.tp, 2),
                    "sl": round(rec.sl, 2),
                    "atm_strike": row.get("atm_strike"),
                    "atm_ce_ltp": ce_ltp,
                    "atm_pe_ltp": pe_ltp,
                    "atm_ce_security_id": row.get("atm_ce_security_id"),
                    "atm_pe_security_id": row.get("atm_pe_security_id"),
                    "spot_price": row.get("spot_price"),
                    "rr": rec.rr,
                    "reasoning": rec.reasoning,
                    "regime": regime,
                    "model_version": models.version,
                    "direction": "GO_CALL" if "CE" in rec.action else "GO_PUT",
                })

            # Periodic heartbeat
            if processed % 500 == 0:
                elapsed = time.time() - started
                rate = processed / max(elapsed, 0.001)
                fstats = trade_filter.stats()
                sys.stdout.write(
                    f"\r  [stats] ticks={processed:,}  "
                    f"raw={raw_signals}  filtered={filtered_signals}  "
                    f"rate={rate:.1f}/s"
                )
                sys.stdout.flush()
    except KeyboardInterrupt:
        print("\n  Stopping SEA...")
    finally:
        raw_logger.close()
        filtered_logger.close()
        fstats = trade_filter.stats()
        print(f"\n  Filter stats: {fstats}")


def main() -> int:
    p = argparse.ArgumentParser(prog="sea")
    p.add_argument("--instrument", required=True,
                   choices=("nifty50", "banknifty", "crudeoil", "naturalgas"))
    p.add_argument("--features-root", default="data/features")
    p.add_argument("--call-thresh", type=float, default=DIRECTION_PROB_CALL,
                   help=f"GO_CALL fires when direction_prob >= this (default {DIRECTION_PROB_CALL})")
    p.add_argument("--put-thresh", type=float, default=DIRECTION_PROB_PUT,
                   help=f"GO_PUT fires when direction_prob <= this (default {DIRECTION_PROB_PUT})")
    p.add_argument("--sustained-n", type=int, default=5,
                   help="Consecutive ticks for sustained direction (default 5)")
    p.add_argument("--avg-prob-thresh", type=float, default=0.65,
                   help="Avg conviction probability threshold (default 0.65)")
    p.add_argument("--filter-cooldown", type=float, default=60.0,
                   help="Min seconds between filtered trade recommendations (default 60)")
    args = p.parse_args()
    run(args.instrument, Path(args.features_root),
        call_thresh=args.call_thresh, put_thresh=args.put_thresh,
        sustained_n=args.sustained_n,
        avg_prob_thresh=args.avg_prob_thresh,
        filter_cooldown_sec=args.filter_cooldown)
    return 0


if __name__ == "__main__":
    sys.exit(main())
