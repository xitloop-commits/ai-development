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
from signal_engine_agent.sustain import SustainFilter
from signal_engine_agent.thresholds import (
    SignalAction,
    Thresholds,
    V2Thresholds,
    Wave2Thresholds,
    decide_action,
    decide_action_v2,
    decide_action_wave2,
    load_thresholds_full,
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
    so legacy_filter callers can share it.

    T25 — applies per-head isotonic calibration (V2_MASTER_SPEC D72)
    when a `.calibration.json` sidecar was loaded for this head.
    Regression heads and binary heads without a calibration map fall
    through unchanged (LoadedModels.apply_calibration is a no-op when
    no map exists)."""
    m = models.models.get(name)
    if m is None:
        return float("nan")
    raw = float(m.predict(X)[0])
    return float(models.apply_calibration(name, raw))


def _gather_predictions(models, X) -> dict[str, float]:
    """Pull the predictions the gate cares about into one dict.
    Used by all gate modes — entries returning NaN cost nothing and
    let the gates fail-open on missing models (e.g., Wave 1 models
    without Wave 2 targets).

    Wave 2 added 5 new target types per window (5 windows): direction_persists,
    breakout_in, exit_signal, max_upside_pe, max_drawdown_pe. Plus the
    base 3-cond moved from 30s → 60s window. Keys here cover both old
    and new shapes so any gate path runs without code branching.
    """
    return {
        # Base 3-cond targets (legacy 30s)
        "direction_prob_30s": _pred(models, X, "direction_30s"),
        "risk_reward_ratio_30s": _pred(models, X, "risk_reward_ratio_30s"),
        "max_upside_30s": _pred(models, X, "max_upside_30s"),
        "max_drawdown_30s": _pred(models, X, "max_drawdown_30s"),
        "max_upside_300s": _pred(models, X, "max_upside_300s"),
        "max_drawdown_300s": _pred(models, X, "max_drawdown_300s"),
        "max_upside_900s": _pred(models, X, "max_upside_900s"),
        "max_drawdown_900s": _pred(models, X, "max_drawdown_900s"),
        "direction_30s_magnitude": _pred(models, X, "direction_30s_magnitude"),
        # Wave 2 base 3-cond on 60s window
        "direction_prob_60s": _pred(models, X, "direction_60s"),
        "risk_reward_ratio_60s": _pred(models, X, "risk_reward_ratio_60s"),
        # Wave 2 direction_persists across windows
        "direction_persists_60s": _pred(models, X, "direction_persists_60s"),
        "direction_persists_120s": _pred(models, X, "direction_persists_120s"),
        "direction_persists_180s": _pred(models, X, "direction_persists_180s"),
        "direction_persists_240s": _pred(models, X, "direction_persists_240s"),
        "direction_persists_300s": _pred(models, X, "direction_persists_300s"),
        # Wave 2 breakout_in
        "breakout_in_60s": _pred(models, X, "breakout_in_60s"),
        "breakout_in_300s": _pred(models, X, "breakout_in_300s"),
        # Wave 2 exit_signal
        "exit_signal_60s": _pred(models, X, "exit_signal_60s"),
        "exit_signal_300s": _pred(models, X, "exit_signal_300s"),
        # Wave 2 PE-leg targets (replace first-order swap for LONG_PE)
        "max_upside_pe_60s": _pred(models, X, "max_upside_pe_60s"),
        "max_upside_pe_120s": _pred(models, X, "max_upside_pe_120s"),
        "max_upside_pe_180s": _pred(models, X, "max_upside_pe_180s"),
        "max_upside_pe_240s": _pred(models, X, "max_upside_pe_240s"),
        "max_upside_pe_300s": _pred(models, X, "max_upside_pe_300s"),
        "max_drawdown_pe_60s": _pred(models, X, "max_drawdown_pe_60s"),
        "max_drawdown_pe_120s": _pred(models, X, "max_drawdown_pe_120s"),
        "max_drawdown_pe_180s": _pred(models, X, "max_drawdown_pe_180s"),
        "max_drawdown_pe_240s": _pred(models, X, "max_drawdown_pe_240s"),
        "max_drawdown_pe_300s": _pred(models, X, "max_drawdown_pe_300s"),
        # Wave 2 CE-leg 60s/120s/180s/240s (300s already in legacy list)
        "max_upside_60s": _pred(models, X, "max_upside_60s"),
        "max_upside_120s": _pred(models, X, "max_upside_120s"),
        "max_upside_180s": _pred(models, X, "max_upside_180s"),
        "max_upside_240s": _pred(models, X, "max_upside_240s"),
        "max_drawdown_60s": _pred(models, X, "max_drawdown_60s"),
        "max_drawdown_120s": _pred(models, X, "max_drawdown_120s"),
        "max_drawdown_180s": _pred(models, X, "max_drawdown_180s"),
        "max_drawdown_240s": _pred(models, X, "max_drawdown_240s"),
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
        thresholds, v2_thresholds, wave2_thresholds, gate_mode = load_thresholds_full(
            instrument, config_dir,
        )
        if gate_mode == "wave2":
            sustain_filter = None  # model handles persistence via direction_persists_*
            print(
                f"  Filter: Wave 2 model-driven gate  "
                f"(prob>={thresholds.prob_min}, RR>={thresholds.rr_min}, "
                f"pctile>={thresholds.upside_percentile_min}, "
                f"persists_60s>={wave2_thresholds.persists_60s_min}, "
                f"persists_300s>={wave2_thresholds.persists_300s_min}, "
                f"exit_signal_60s<{wave2_thresholds.exit_signal_60s_max})"
            )
        elif gate_mode == "wave1":
            sustain_filter = SustainFilter(window_n=10)
            print(
                f"  Filter: 3-cond gate + Wave 1 deterministic layer  "
                f"(prob>={thresholds.prob_min}, RR>={thresholds.rr_min}, "
                f"pctile>={thresholds.upside_percentile_min}, "
                f"momentum>={v2_thresholds.momentum_persistence_min}, "
                f"sr_clearance>={v2_thresholds.sr_clearance_pct}%, "
                f"sustain_n={sustain_filter.window_n})"
            )
        else:
            sustain_filter = None
            print(
                f"  Filter: 3-condition gate (current)  "
                f"(prob>={thresholds.prob_min}, "
                f"RR>={thresholds.rr_min}, "
                f"pctile>={thresholds.upside_percentile_min})"
            )
        trade_filter = None
    elif filter_mode == "legacy":
        thresholds = None
        v2_thresholds = None
        wave2_thresholds = None
        gate_mode = "current"
        sustain_filter = None
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
            # `.get(key, default)` only returns the default when the key is
            # MISSING. TFA may emit the column with an explicit null when the
            # session-rank window hasn't filled yet → coerce None → nan.
            _pct = row.get("upside_percentile_30s")
            preds["upside_percentile_30s"] = float(_pct) if _pct is not None else float("nan")
            # Wave 2 base gate uses 60s window — TFA emits upside_percentile_{min_window}s
            # where min_window is the profile's smallest target window. Post-Wave-2 that
            # smallest is 60s, so the column is upside_percentile_60s.
            _pct60 = row.get("upside_percentile_60s")
            preds["upside_percentile_60s"] = float(_pct60) if _pct60 is not None else float("nan")

            regime = row.get("regime")
            ce_ltp = row.get("opt_0_ce_ltp")
            pe_ltp = row.get("opt_0_pe_ltp")

            if filter_mode == "gate":
                if gate_mode == "wave2":
                    # Wave 2 model-driven gate: base 3-cond + direction_persists +
                    # exit_signal + per-leg PE targets. Model handles persistence
                    # so no sustained-tick filter needed.
                    sig = decide_action_wave2(
                        preds, thresholds, wave2_thresholds,
                        ce_ltp=ce_ltp, pe_ltp=pe_ltp,
                    )
                elif gate_mode == "wave1":
                    # Wave 1 deterministic gate: 3-condition + regime + momentum + S/R + sustained-N
                    raw_sig = decide_action_v2(
                        preds, thresholds, v2_thresholds,
                        ce_ltp=ce_ltp, pe_ltp=pe_ltp,
                        regime=regime if isinstance(regime, str) else None,
                        momentum_persistence_ticks=row.get("momentum_persistence_ticks"),
                        distance_to_day_high_pct=row.get("distance_to_day_high_pct"),
                        distance_to_day_low_pct=row.get("distance_to_day_low_pct"),
                    )
                    # Apply sustained-tick filter on the raw decision
                    confirmed = sustain_filter.observe(raw_sig.action)
                    if confirmed != "WAIT" and raw_sig.gate_passed:
                        sig = raw_sig
                    else:
                        sig = SignalAction(
                            action="WAIT", direction=raw_sig.direction,
                            entry=0.0, tp=0.0, sl=0.0, rr=0.0,
                            gate_passed=False,
                            gate_reasons=raw_sig.gate_reasons + (
                                ["C7_not_sustained"] if confirmed == "WAIT" and raw_sig.gate_passed else []
                            ),
                        )
                else:
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
                    "gate_mode": gate_mode,
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
