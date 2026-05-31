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
from signal_engine_agent.cohort import build_head_type_map
from signal_engine_agent.model_loader import load_models
from signal_engine_agent.prediction_logger import PredictionLogger
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
    """Run one model if loaded, else return NaN.

    T25 — applies per-head isotonic calibration (V2_MASTER_SPEC D72)
    when a `.calibration.json` sidecar was loaded for this head.
    Regression heads and binary heads without a calibration map fall
    through unchanged (LoadedModels.apply_calibration is a no-op when
    no map exists)."""
    raw, cal = _pred_raw_cal(models, X, name)
    return cal


def _pred_raw_cal(models, X, name: str) -> tuple[float, float]:
    """T41 internal — returns ``(raw, calibrated)``. Same model call,
    captures both pre- and post-calibration values so
    ``prediction_logger`` can persist the pair for downstream
    calibration-drift / champion-challenger analyses (T34, T27 future).
    A single ``predict()`` call powers both values; cheap.
    """
    m = models.models.get(name)
    if m is None:
        return float("nan"), float("nan")
    raw = float(m.predict(X)[0])
    cal = float(models.apply_calibration(name, raw))
    return raw, cal


# Single source of truth for "which heads does the gate read + what dict
# key does it use." Each tuple is ``(dict_key_used_by_gate, model_name)``;
# they differ in two cases (``direction_prob_*`` vs ``direction_*``) and
# match for everything else. ``_gather_predictions`` and
# ``_gather_predictions_raw_cal`` (T41) both iterate this list so the
# head set never drifts between them.
_HEAD_PREDS: tuple[tuple[str, str], ...] = (
    # Base 3-cond targets (legacy 30s)
    ("direction_prob_30s",       "direction_30s"),
    ("risk_reward_ratio_30s",    "risk_reward_ratio_30s"),
    ("max_upside_30s",           "max_upside_30s"),
    ("max_drawdown_30s",         "max_drawdown_30s"),
    ("max_upside_300s",          "max_upside_300s"),
    ("max_drawdown_300s",        "max_drawdown_300s"),
    ("max_upside_900s",          "max_upside_900s"),
    ("max_drawdown_900s",        "max_drawdown_900s"),
    ("direction_30s_magnitude",  "direction_30s_magnitude"),
    # Wave 2 base 3-cond on 60s window
    ("direction_prob_60s",       "direction_60s"),
    ("risk_reward_ratio_60s",    "risk_reward_ratio_60s"),
    # Wave 2 direction_persists across windows
    ("direction_persists_60s",   "direction_persists_60s"),
    ("direction_persists_120s",  "direction_persists_120s"),
    ("direction_persists_180s",  "direction_persists_180s"),
    ("direction_persists_240s",  "direction_persists_240s"),
    ("direction_persists_300s",  "direction_persists_300s"),
    # Wave 2 breakout_in
    ("breakout_in_60s",          "breakout_in_60s"),
    ("breakout_in_300s",         "breakout_in_300s"),
    # Wave 2 exit_signal
    ("exit_signal_60s",          "exit_signal_60s"),
    ("exit_signal_300s",         "exit_signal_300s"),
    # Wave 2 PE-leg targets (replace first-order swap for LONG_PE)
    ("max_upside_pe_60s",        "max_upside_pe_60s"),
    ("max_upside_pe_120s",       "max_upside_pe_120s"),
    ("max_upside_pe_180s",       "max_upside_pe_180s"),
    ("max_upside_pe_240s",       "max_upside_pe_240s"),
    ("max_upside_pe_300s",       "max_upside_pe_300s"),
    ("max_drawdown_pe_60s",      "max_drawdown_pe_60s"),
    ("max_drawdown_pe_120s",     "max_drawdown_pe_120s"),
    ("max_drawdown_pe_180s",     "max_drawdown_pe_180s"),
    ("max_drawdown_pe_240s",     "max_drawdown_pe_240s"),
    ("max_drawdown_pe_300s",     "max_drawdown_pe_300s"),
    # Wave 2 CE-leg 60s/120s/180s/240s (300s already in legacy list)
    ("max_upside_60s",           "max_upside_60s"),
    ("max_upside_120s",          "max_upside_120s"),
    ("max_upside_180s",          "max_upside_180s"),
    ("max_upside_240s",          "max_upside_240s"),
    ("max_drawdown_60s",         "max_drawdown_60s"),
    ("max_drawdown_120s",        "max_drawdown_120s"),
    ("max_drawdown_180s",        "max_drawdown_180s"),
    ("max_drawdown_240s",        "max_drawdown_240s"),
)


def _gather_predictions(models, X) -> dict[str, float]:
    """Pull the predictions the gate cares about into one dict.
    Used by all gate modes — entries returning NaN cost nothing and
    let the gates fail-open on missing models (e.g., Wave 1 models
    without Wave 2 targets).

    Wave 2 added 5 new target types per window (5 windows): direction_persists,
    breakout_in, exit_signal, max_upside_pe, max_drawdown_pe. Plus the
    base 3-cond moved from 30s → 60s window. Keys here cover both old
    and new shapes so any gate path runs without code branching.

    Returns the calibrated predictions only (what the gate consumes).
    Use ``_gather_predictions_raw_cal`` when both raw and calibrated
    values are needed (e.g. T41 prediction_logger).
    """
    return {gate_key: _pred(models, X, model_name)
            for gate_key, model_name in _HEAD_PREDS}


def _gather_predictions_raw_cal(
    models, X,
) -> tuple[dict[str, float], dict[str, float]]:
    """T41 variant — returns ``(raw_dict, cal_dict)`` with the SAME keys
    as ``_gather_predictions``. One ``predict()`` call per head powers
    both values (see ``_pred_raw_cal``); ~0% perf hit vs the calibrated-
    only path.

    Used by ``engine.run()`` when emitting the per-eval prediction log.
    The gate continues to consume only the calibrated dict, identical to
    the pre-T41 behaviour.
    """
    raw: dict[str, float] = {}
    cal: dict[str, float] = {}
    for gate_key, model_name in _HEAD_PREDS:
        r, c = _pred_raw_cal(models, X, model_name)
        raw[gate_key] = r
        cal[gate_key] = c
    return raw, cal


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
) -> None:
    live_path = features_root / f"{instrument}_live.ndjson"

    print()
    print(f"  SEA -- {instrument}")
    print(f"  Tail: {live_path}")
    models = load_models(instrument)
    print(f"  Model version: {models.version}")
    print(f"  Features: {len(models.feature_names)}")

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
    print()

    raw_logger = SignalLogger(instrument)
    filtered_logger = SignalLogger(instrument, root=Path("logs/signals"), suffix="_filtered")
    # T41 feedback-loop foundation: persist every per-head (prediction,
    # outcome) tuple. The logger buffers in-memory and flushes per chunk;
    # ``finalise()`` on shutdown merges chunks into one parquet for the
    # day. ``outcome_*`` columns are NaN at write time — backfilled by
    # ``signal_engine_agent.outcome_backfiller`` post-session.
    _t41_date = datetime.now(_IST).strftime("%Y-%m-%d")
    prediction_logger = PredictionLogger(
        instrument=instrument, date_str=_t41_date,
    )
    # T33 D56: pre-compute head -> cohort map once at startup. The map
    # is immutable per process so we pass the same dict on every
    # log_eval call. Heads without a window-derived cohort
    # (e.g. upside_percentile_30s, regression heads outside the
    # scalp/trend/swing bands) are simply absent — logger writes NULL.
    _t33_head_types = build_head_type_map(
        [gate_key for gate_key, _ in _HEAD_PREDS]
    )
    print(
        f"  T41 predictions -> data/predictions/{_t41_date}/"
        f"{instrument}_predictions.parquet"
    )
    print(
        f"  T33 cohorts:   "
        f"{sum(1 for v in _t33_head_types.values() if v == 'scalp')} scalp / "
        f"{sum(1 for v in _t33_head_types.values() if v == 'trend')} trend / "
        f"{sum(1 for v in _t33_head_types.values() if v == 'swing')} swing"
    )
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

            # T41: gather BOTH raw + calibrated. The gate consumes the
            # calibrated ``preds`` dict exactly as before; the raw dict
            # is only passed to the prediction logger after the gate runs.
            raw_preds, preds = _gather_predictions_raw_cal(models, X)
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

            # T41: persist this eval's per-head (prediction, outcome)
            # tuples. Outcome columns are NaN here; outcome_backfiller
            # joins them in post-session from the recorded tick stream.
            # Logged for EVERY eval — both heads-that-fired and heads-
            # that-didn't — so T34's reliability + calibration drift
            # analyses see the full distribution. Timestamp resolution
            # falls back to wall-clock when the row didn't carry one.
            _row_ts_ns = row.get("recv_ts_ns")
            if not isinstance(_row_ts_ns, int):
                _ts_str = row.get("timestamp")
                if isinstance(_ts_str, str):
                    try:
                        _row_ts_ns = int(
                            datetime.fromisoformat(_ts_str).timestamp() * 1e9
                        )
                    except (ValueError, OSError):
                        _row_ts_ns = time.time_ns()
                else:
                    _row_ts_ns = time.time_ns()
            try:
                prediction_logger.log_eval(
                    ts_ns=_row_ts_ns,
                    feature_vec=vec,
                    raw_preds=raw_preds,
                    calibrated_preds=preds,
                    gate_decision=action,
                    regime_tag=regime if isinstance(regime, str) else None,
                    head_types=_t33_head_types,
                )
            except Exception as exc:
                # Never let the prediction logger crash the inference
                # loop. Log + continue; T34 will surface gaps anyway.
                print(f"  T41 log_eval error: {exc}", file=sys.stderr)

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
                # T33 D56: cohort tag on every emitted signal. Current
                # gates (wave2 / wave1 / 3-cond) are all scalp-window
                # driven, so the originating cohort is always "scalp"
                # today. When T29 lands head-type routing for trend /
                # swing gates this will derive from the firing head's
                # cohort instead of being a constant.
                signal_cohort = "scalp"
                signal = {
                    "timestamp": row.get("timestamp"),
                    "timestamp_ist": datetime.now(_IST).isoformat(timespec="milliseconds"),
                    "instrument": instrument.upper(),
                    "action": action,
                    "cohort": signal_cohort,
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
                    "gate_mode": gate_mode,
                    "direction": "GO_CALL" if "CE" in action else "GO_PUT",
                }
                raw_logger.log(signal)

            # ── Filtered output ──
            # Log the failed-gate diagnostic line per spec §3
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
        # T41: finalise the prediction log — merges in-progress chunks
        # into <inst>_predictions.parquet and deletes the chunks. Safe
        # to call on partial-day data; outcome_backfiller picks it up
        # post-session regardless.
        try:
            final_pred_path = prediction_logger.finalise()
            if final_pred_path is not None:
                print(f"  T41 predictions finalised -> {final_pred_path}")
        except Exception as exc:
            print(f"  T41 finalise error: {exc}", file=sys.stderr)


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
    args = p.parse_args()

    run(
        args.instrument,
        features_root=Path(args.features_root),
        config_dir=Path(args.config_dir),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
