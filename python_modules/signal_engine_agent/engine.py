"""
engine.py — SEA MVP inference loop.

Tails data/features/{instrument}_live.ndjson (the per-instrument live feature
stream written by TFA), runs inference on each new row, and writes
GO_CALL / GO_PUT signals to logs/signals/{instrument}/ as one NDJSON
line per signal.

Phase E5 — canonical filter is the **3-condition gate** in
`thresholds.decide_action`:

    prob ≥ 0.65  AND  RR ≥ 1.5  AND  upside_percentile ≥ 60

Per-instrument thresholds live in `config/sea_thresholds/<inst>.json`
(falling back to `default.json`); see `thresholds.load_thresholds`.

The legacy 4-stage filter (regime-aware action router + TradeFilter
sustained/confidence/consensus pipeline) is retained behind
`--filter=legacy` for one A/B cycle and lives in `legacy_filter.py`.
It will be removed after the new gate is validated on a full backtest
cycle.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Path bootstrap
_HERE = Path(__file__).resolve().parent
_PYTHON_MODULES = _HERE.parent
if str(_PYTHON_MODULES) not in sys.path:
    sys.path.insert(0, str(_PYTHON_MODULES))

import numpy as np

from model_training_agent.preprocessor import LiveTickPreprocessor
from signal_engine_agent import legacy_filter
from signal_engine_agent.model_loader import load_models
from signal_engine_agent.signal_logger import SignalLogger
from signal_engine_agent.thresholds import (
    SignalAction,
    Thresholds,
    decide_action,
    load_thresholds,
)

_IST = timezone(timedelta(hours=5, minutes=30))


def _decide_via_gate(
    predictions: dict, thresholds: Thresholds, ce_ltp: float | None, pe_ltp: float | None
) -> SignalAction:
    """Thin wrapper: forward to the canonical 3-condition gate. Kept as
    its own function so the main loop reads the same way for both the
    gate and legacy paths."""
    return decide_action(predictions, thresholds, ce_ltp=ce_ltp, pe_ltp=pe_ltp)


def _pred(models, X, name: str) -> float:
    """Run one model if loaded, else return NaN. Hoisted out of `run()`
    so legacy_filter callers can share it."""
    m = models.models.get(name)
    return float(m.predict(X)[0]) if m else float("nan")


def _gather_predictions(models, X) -> dict[str, float]:
    """Pull the predictions the gate cares about into one dict.
    Used for both the new gate and the legacy router (which only reads
    a subset, but the cost of computing the rest is negligible)."""
    return {
        "direction_prob_30s": _pred(models, X, "direction_30s"),
        "risk_reward_ratio_30s": _pred(models, X, "risk_reward_ratio_30s"),
        "max_upside_30s": _pred(models, X, "max_upside_30s"),
        "max_drawdown_30s": _pred(models, X, "max_drawdown_30s"),
        "max_upside_300s": _pred(models, X, "max_upside_300s"),
        "max_drawdown_300s": _pred(models, X, "max_drawdown_300s"),
        "max_upside_900s": _pred(models, X, "max_upside_900s"),
        "max_drawdown_900s": _pred(models, X, "max_drawdown_900s"),
        "direction_30s_magnitude": _pred(models, X, "direction_30s_magnitude"),
    }


def _tail(path: Path, poll_sec: float = 0.2):
    """Generator: yield each new line appended to `path`. Handles file
    rotation (truncate / recreate → reopen from position 0)."""
    pos = 0
    while True:
        if not path.exists():
            time.sleep(poll_sec)
            continue
        size = path.stat().st_size
        if size < pos:
            pos = 0
        with open(path, encoding="utf-8") as f:
            f.seek(pos)
            while True:
                line = f.readline()
                if not line:
                    pos = f.tell()
                    break
                yield line.rstrip("\n")
            pos = f.tell()
        time.sleep(poll_sec)


def run(
    instrument: str,
    features_root: Path = Path("data/features"),
    config_dir: Path = Path("config/sea_thresholds"),
    filter_mode: str = "gate",
    # Legacy-only knobs (ignored when filter_mode == "gate")
    sustained_n: int = 5,
    avg_prob_thresh: float = 0.65,
    filter_cooldown_sec: float = 60.0,
) -> None:
    live_path = features_root / f"{instrument}_live.ndjson"

    print()
    print(f"  SEA -- {instrument}")
    print(f"  Tail: {live_path}")
    models = load_models(instrument)
    print(f"  Model version: {models.version}")
    print(f"  Features: {len(models.feature_names)}")

    if filter_mode == "gate":
        thresholds = load_thresholds(instrument, config_dir)
        print(
            f"  Filter: 3-condition gate  "
            f"(prob>={thresholds.prob_min}, "
            f"RR>={thresholds.rr_min}, "
            f"pctile>={thresholds.upside_percentile_min})"
        )
        trade_filter = None
    elif filter_mode == "legacy":
        thresholds = None
        trade_filter = legacy_filter.TradeFilter(
            sustained_n=sustained_n,
            avg_prob_threshold=avg_prob_thresh,
            cooldown_sec=filter_cooldown_sec,
        )
        print(
            f"  Filter: LEGACY 4-stage  "
            f"(sustained={sustained_n}, avg_prob>={avg_prob_thresh}, "
            f"cooldown={filter_cooldown_sec}s) -- DEPRECATED"
        )
    else:
        raise ValueError(f"filter_mode must be 'gate' or 'legacy', got {filter_mode!r}")
    print()

    raw_logger = SignalLogger(instrument)
    filtered_logger = SignalLogger(instrument, root=Path("logs/signals"), suffix="_filtered")
    # F4 hot-path optimisation: pre-allocate the feature vector buffer
    # once per SEA instance and reuse it on every tick. The returned
    # array is the same buffer each call — `vec` must be consumed before
    # the next `process()` call. SEA reshapes-and-predicts immediately,
    # which is safe (LightGBM copies inputs internally for prediction).
    live_preprocessor = LiveTickPreprocessor(models.feature_config)
    processed = 0
    raw_signals = 0
    filtered_signals = 0
    started = time.time()

    # Cooldown for raw signal feed (existing UI behavior, both modes)
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

            vec = live_preprocessor.process(row)
            if vec is None:
                continue
            X = vec.reshape(1, -1)

            preds = _gather_predictions(models, X)
            # The session-rank `upside_percentile_30s` is a TFA-emitted
            # live feature column on the parquet row, not a model target
            # (per Phase E9). Pull it from the row directly.
            preds["upside_percentile_30s"] = float(row.get("upside_percentile_30s", float("nan")))

            regime = row.get("regime")
            ce_ltp = row.get("opt_0_ce_ltp")
            pe_ltp = row.get("opt_0_pe_ltp")

            if filter_mode == "gate":
                sig = _decide_via_gate(preds, thresholds, ce_ltp, pe_ltp)
                action = sig.action
                entry, tp, sl, rr = sig.entry, sig.tp, sig.sl, sig.rr
                gate_reasons = sig.gate_reasons
            else:
                # Legacy path — regime router + 4-stage filter
                up_swing = preds["max_upside_900s"]
                dn_swing = preds["max_drawdown_900s"]
                if np.isnan(up_swing):
                    up_swing = preds["max_upside_300s"]
                if np.isnan(dn_swing):
                    dn_swing = preds["max_drawdown_300s"]

                legacy = legacy_filter.legacy_decide(
                    preds["direction_prob_30s"],
                    preds["max_upside_30s"],
                    preds["max_drawdown_30s"],
                    regime,
                    ce_ltp,
                    pe_ltp,
                    up_pred_swing=up_swing,
                    dn_pred_swing=dn_swing,
                )
                action = legacy.action
                entry, tp, sl, rr = legacy.entry, legacy.tp, legacy.sl, legacy.rr
                gate_reasons = []

            processed += 1

            # ── Raw signal emission (cooldown, UI feed) ──
            now_ts = time.time()
            should_emit_raw = action != "WAIT" and (
                action != _last_action or now_ts - _last_emit_ts >= COOLDOWN_SEC
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
                    "direction_prob_30s": round(preds["direction_prob_30s"], 4),
                    "risk_reward_ratio_30s": round(preds["risk_reward_ratio_30s"], 4),
                    "upside_percentile_30s": round(preds["upside_percentile_30s"], 2),
                    "max_upside_pred_30s": round(preds["max_upside_30s"], 2),
                    "max_drawdown_pred_30s": round(preds["max_drawdown_30s"], 2),
                    "regime": regime,
                    "entry": round(entry, 2),
                    "tp": round(tp, 2),
                    "sl": round(sl, 2),
                    "rr": rr,
                    "atm_strike": row.get("atm_strike"),
                    "atm_ce_ltp": ce_ltp,
                    "atm_pe_ltp": pe_ltp,
                    "atm_ce_security_id": row.get("atm_ce_security_id"),
                    "atm_pe_security_id": row.get("atm_pe_security_id"),
                    "spot_price": row.get("spot_price"),
                    "momentum": row.get("underlying_momentum"),
                    "breakout": row.get("breakout_readiness"),
                    "model_version": models.version,
                    "filter_mode": filter_mode,
                    "direction": "GO_CALL" if "CE" in action else "GO_PUT",
                }
                raw_logger.log(signal)

            # ── Filtered output ──
            if filter_mode == "gate":
                # New path: log the failed-gate diagnostic line per spec §3
                # (filtered_signals.log). Only emit when prediction was
                # evaluable (i.e. we have a direction_prob_30s) — pure
                # noise rows are skipped.
                if not np.isnan(preds["direction_prob_30s"]) and gate_reasons:
                    filtered_signals += 1
                    would_be = "GO_CALL" if preds["direction_prob_30s"] > 0.5 else "GO_PUT"
                    filtered_logger.log(
                        {
                            "timestamp": row.get("timestamp"),
                            "timestamp_ist": datetime.now(_IST).isoformat(timespec="milliseconds"),
                            "instrument": instrument.upper(),
                            "would_be_direction": would_be,
                            "fail_reasons": gate_reasons,
                            "direction_prob_30s": round(preds["direction_prob_30s"], 4),
                            "risk_reward_ratio_30s": round(preds["risk_reward_ratio_30s"], 4),
                            "upside_percentile_30s": round(preds["upside_percentile_30s"], 2),
                            "model_version": models.version,
                        }
                    )
            else:
                # Legacy path: 4-stage filter → trade recommendation
                tick_decision = legacy_filter.TickDecision(
                    timestamp=row.get("timestamp") or now_ts,
                    action=action,
                    direction_prob=preds["direction_prob_30s"],
                    max_upside_pred=preds["max_upside_30s"],
                    max_drawdown_pred=preds["max_drawdown_30s"],
                    risk_reward_pred=preds["risk_reward_ratio_30s"],
                    magnitude_pred=preds["direction_30s_magnitude"],
                    regime=regime,
                    entry=entry,
                    tp=tp,
                    sl=sl,
                    rr=rr,
                )
                rec = trade_filter.evaluate(tick_decision)
                if rec is not None:
                    filtered_signals += 1
                    ts_short = datetime.now(_IST).strftime("%H:%M:%S")
                    print(
                        f"  [{ts_short}] [TRADE-LEGACY] {rec.action:<10}  "
                        f"{rec.confidence}  score={rec.score}/6  "
                        f"sustained={rec.sustained_ticks}  "
                        f"avg_prob={rec.avg_prob:.3f}  "
                        f"entry={rec.entry:.1f}  "
                        f"TP={rec.tp:.1f}  SL={rec.sl:.1f}  "
                        f"RR={rec.rr:.1f}"
                    )
                    filtered_logger.log(
                        {
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
                            "filter_mode": "legacy",
                            "direction": "GO_CALL" if "CE" in rec.action else "GO_PUT",
                        }
                    )

            # Periodic heartbeat
            if processed % 500 == 0:
                elapsed = time.time() - started
                rate = processed / max(elapsed, 0.001)
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
        if filter_mode == "legacy" and trade_filter is not None:
            print(f"\n  Legacy filter stats: {trade_filter.stats()}")


def main() -> int:
    p = argparse.ArgumentParser(prog="sea")
    p.add_argument(
        "--instrument", required=True, choices=("nifty50", "banknifty", "crudeoil", "naturalgas")
    )
    p.add_argument("--features-root", default="data/features")
    p.add_argument(
        "--config-dir",
        default="config/sea_thresholds",
        help="Per-instrument JSON thresholds dir (default config/sea_thresholds)",
    )
    p.add_argument(
        "--filter",
        choices=("gate", "legacy"),
        default="gate",
        help="'gate' = canonical 3-condition gate (Phase D4); "
        "'legacy' = pre-E5 4-stage filter (DEPRECATED, removed next phase)",
    )
    # Legacy-only knobs (silently ignored in gate mode, kept to not break
    # existing launcher scripts during the one-cycle transition).
    p.add_argument(
        "--sustained-n",
        type=int,
        default=5,
        help="(legacy only) Consecutive ticks for sustained direction",
    )
    p.add_argument(
        "--avg-prob-thresh",
        type=float,
        default=0.65,
        help="(legacy only) Avg conviction probability threshold",
    )
    p.add_argument(
        "--filter-cooldown",
        type=float,
        default=60.0,
        help="(legacy only) Min seconds between filtered recommendations",
    )
    args = p.parse_args()

    run(
        args.instrument,
        features_root=Path(args.features_root),
        config_dir=Path(args.config_dir),
        filter_mode=args.filter,
        sustained_n=args.sustained_n,
        avg_prob_thresh=args.avg_prob_thresh,
        filter_cooldown_sec=args.filter_cooldown,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
