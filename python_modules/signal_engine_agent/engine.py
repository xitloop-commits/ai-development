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
import math
import os
import sys
import threading
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
    TrendThresholds,
    V2Thresholds,
    Wave2Thresholds,
    decide_action,
    decide_action_trend,
    decide_action_v2,
    decide_action_wave2,
    load_thresholds_full,
    load_thresholds_trend,
)

_IST = timezone(timedelta(hours=5, minutes=30))

# ─── AI auto-trade wire (optional, off by default) ───────────────
# When the env var SEA_AUTO_TRADE is set to a channel (e.g. "ai-paper"), every
# wave-2 signal that the engine emits is also POSTed to the Node trade pipeline
# (/api/discipline/validateTrade → DA → RCA → TEA), which places the trade. The
# server sizes it (lots × scrip-master lot size), sources capital/exposure, and
# enforces one open position per instrument, so the 30s signal re-emits don't
# stack duplicate entries. No POST happens unless the env var is set.
_EXCHANGE_BY_INSTRUMENT = {
    "NIFTY50": "NSE",
    "BANKNIFTY": "NSE",
    "CRUDEOIL": "MCX",
    "NATURALGAS": "MCX",
}


def _finite(x: object) -> float | None:
    """Coerce to a finite float, else None. NaN/Inf are NOT valid JSON, so they
    must never reach the payload (express's body parser rejects them)."""
    try:
        f = float(x)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _fmt(x: object, d: int = 2) -> str:
    """Format a finite number to d decimals for the human-readable reason; '-' if absent."""
    v = _finite(x)
    return f"{v:.{d}f}" if v is not None else "-"


def _send_signal_to_tray(signal: dict) -> None:
    """Push the emitted signal to the server for the live UI tray (Mongo +
    /ws/ticks). Fire-and-forget — never let a delivery hiccup stall inference."""
    try:
        from signal_engine_agent.risk_control_client import send_signal

        send_signal(signal, timeout=3.0)
    except Exception as exc:  # pragma: no cover - convenience path only
        print(f"  [signal-tray] push skipped: {exc}", file=sys.stderr)


def _maybe_submit_ai_trade(signal: dict) -> None:
    channel = os.environ.get("SEA_AUTO_TRADE", "").strip()
    if not channel:
        return
    try:
        action = signal.get("action") or ""
        side = "CE" if "CE" in action else "PE"
        sec_id = (
            signal.get("atm_ce_security_id") if side == "CE"
            else signal.get("atm_pe_security_id")
        )
        inst = str(signal.get("instrument", "")).upper()
        entry = _finite(signal.get("entry"))
        strike = _finite(signal.get("atm_strike"))
        if not sec_id or entry is None or entry <= 0 or strike is None:
            return  # can't price the leg or route it — skip silently
        from signal_engine_agent.risk_control_client import submit_new_trade

        payload = {
            "executionId": f"AI-{inst}-{int(time.time() * 1000)}",
            "channel": channel,
            "origin": "AI",
            "instrument": inst,
            "exchange": _EXCHANGE_BY_INSTRUMENT.get(inst, "NSE"),
            "transactionType": "BUY" if action.startswith("LONG") else "SELL",
            "optionType": side,
            "strike": strike,
            "contractSecurityId": str(sec_id),
            "entryPrice": entry,
            # stopLoss/takeProfit accept number OR null — send finite value or null.
            "stopLoss": _finite(signal.get("sl")),
            "takeProfit": _finite(signal.get("tp")),
            "lots": int(os.environ.get("SEA_AUTO_TRADE_LOTS", "1") or "1"),
        }
        # Optional fields — include only when finite / present (schema rejects null).
        cohort = signal.get("cohort")
        if isinstance(cohort, str) and cohort:
            payload["cohort"] = cohort
        conf = _finite(signal.get("direction_prob_30s"))
        if conf is not None:
            payload["aiConfidence"] = conf
        rr = _finite(signal.get("rr"))
        if rr is not None:
            payload["aiRiskReward"] = rr

        submit_new_trade(payload, timeout=5.0)
    except Exception as exc:  # never let auto-trade crash the inference loop
        print(f"  [auto-trade] skipped: {exc}", file=sys.stderr)


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
    # Trend-cohort heads (15-min / 30-min horizon). Consumed by
    # decide_action_trend (2026-06-22). Off the hot path until the
    # per-instrument JSON config's `trend.enabled: true` -- but always
    # gathered so the prediction logger captures them for analysis.
    ("trend_direction_900s",         "trend_direction_900s"),
    ("trend_direction_1800s",        "trend_direction_1800s"),
    ("trend_continues_900s",         "trend_continues_900s"),
    ("trend_continues_1800s",        "trend_continues_1800s"),
    ("trend_breakout_imminent_900s",  "trend_breakout_imminent_900s"),
    ("trend_breakout_imminent_1800s", "trend_breakout_imminent_1800s"),
    ("trend_magnitude_900s",         "trend_magnitude_900s"),
    ("trend_magnitude_1800s",        "trend_magnitude_1800s"),
    ("trend_max_drawdown_900s",       "trend_max_drawdown_900s"),
    ("trend_max_drawdown_1800s",      "trend_max_drawdown_1800s"),
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
    """Generator: yield each NEW line appended to `path`.

    Seeks to the END on first open (true `tail -f`) so a mid-session restart
    resumes at the live tick immediately, instead of replaying the whole day's
    feature file from the start (which can be hundreds of MB → many minutes of
    backlog before any live signal). At market open the file is empty so this is
    a no-op. Handles file rotation (truncate / recreate → reopen from 0)."""
    pos: int | None = None
    while True:
        if not path.exists():
            time.sleep(poll_sec)
            continue
        size = path.stat().st_size
        if pos is None:
            pos = size  # start at end — skip the backlog on (re)start
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
    # Trend gate (cohort=trend, 30-min horizon). Loaded independently
    # of the scalp gate mode so both can fire on the same tick.
    trend_thresholds = load_thresholds_trend(instrument, config_dir)
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
    # Trend gate banner (2026-06-22).
    if trend_thresholds.enabled:
        print(
            f"  Trend gate: ENABLED (cohort=trend, 30-min horizon)  "
            f"(dir>={trend_thresholds.dir_prob_min}, "
            f"continues>={trend_thresholds.continues_min}, "
            f"breakout>={trend_thresholds.breakout_min}, "
            f"cooldown={trend_thresholds.min_seconds_between_signals}s)"
        )
    else:
        print(f"  Trend gate: disabled (no `trend` block in config)")
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
    # Per-instrument trend-cohort cooldown. Trend horizon is 30 min --
    # spamming GO_CALL every tick is meaningless. One signal per
    # `min_seconds_between_signals` (default 600s = 10 min).
    _last_trend_emit_ts: float = 0.0
    trend_emitted = 0

    # Liveness heartbeat — a daemon thread POSTs to the server every 5s
    # INDEPENDENT of tick flow, so the UI shows SEA as running even when the
    # feed is starved (the tail loop below blocks when there are no ticks).
    _hb_stop = threading.Event()

    def _heartbeat_loop() -> None:
        from signal_engine_agent.risk_control_client import send_heartbeat

        while True:
            try:
                send_heartbeat(instrument)
            except Exception:  # pragma: no cover - never crash on heartbeat
                pass
            if _hb_stop.wait(5.0):
                break

    _hb_thread = threading.Thread(
        target=_heartbeat_loop, name=f"sea-heartbeat-{instrument}", daemon=True
    )
    _hb_thread.start()

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
                # Human-readable "why this trade fired" — the gate drivers that
                # cleared the threshold (logged with the signal for audit).
                _dp = _finite(preds.get("direction_prob_30s")) or 0.0
                reason = (
                    f"{gate_mode} gate · conviction {max(_dp, 1.0 - _dp):.2f} · "
                    f"RR {_fmt(preds.get('risk_reward_ratio_30s'), 1)} · "
                    f"pctile {_fmt(preds.get('upside_percentile_30s'), 0)} · "
                    f"persist60 {_fmt(preds.get('direction_persists_60s'))} · "
                    f"persist300 {_fmt(preds.get('direction_persists_300s'))} · "
                    f"exit60 {_fmt(preds.get('exit_signal_60s'))} · regime {regime}"
                )
                signal = {
                    "timestamp": row.get("timestamp"),
                    "timestamp_ist": datetime.now(_IST).isoformat(timespec="milliseconds"),
                    "instrument": instrument.upper(),
                    "action": action,
                    "cohort": signal_cohort,
                    "reason": reason,
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
                _send_signal_to_tray(signal)  # live UI tray (Mongo + WS)
                # Optional: also place the trade (off unless SEA_AUTO_TRADE set).
                _maybe_submit_ai_trade(signal)

            # ── Trend-cohort gate (2026-06-22) ─────────────────────
            # Independent of the scalp gate above -- can fire on the
            # same tick AND in addition to a scalp signal. Trend gate
            # consumes the 30-min horizon heads (trend_direction_1800s,
            # trend_continues_1800s, trend_breakout_imminent_1800s).
            # Disabled-by-default; opt in via the per-instrument JSON
            # config's `trend.enabled: true`.
            if trend_thresholds.enabled:
                trend_sig = decide_action_trend(
                    preds, trend_thresholds,
                    ce_ltp=ce_ltp, pe_ltp=pe_ltp,
                )
                if trend_sig.action != "WAIT" and trend_sig.gate_passed:
                    # Per-instrument cooldown -- don't spam the same
                    # 30-min trend over and over.
                    seconds_since_last = now_ts - _last_trend_emit_ts
                    if seconds_since_last >= trend_thresholds.min_seconds_between_signals:
                        _last_trend_emit_ts = now_ts
                        trend_emitted += 1
                        trend_reason = (
                            f"trend gate · dir {_fmt(preds.get('trend_direction_1800s'))} · "
                            f"continues {_fmt(preds.get('trend_continues_1800s'))} · "
                            f"breakout {_fmt(preds.get('trend_breakout_imminent_1800s'))} · "
                            f"mag {_fmt(preds.get('trend_magnitude_1800s'), 1)} · regime {regime}"
                        )
                        trend_signal = {
                            "timestamp": row.get("timestamp"),
                            "timestamp_ist": datetime.now(_IST).isoformat(timespec="milliseconds"),
                            "instrument": instrument.upper(),
                            "action": trend_sig.action,
                            "cohort": "trend",
                            "reason": trend_reason,
                            "trend_dir_prob_1800s": round(
                                float(preds.get("trend_direction_1800s") or 0.0), 4,
                            ),
                            "trend_continues_1800s": round(
                                float(preds.get("trend_continues_1800s") or 0.0), 4,
                            ),
                            "trend_breakout_in_1800s": round(
                                float(preds.get("trend_breakout_imminent_1800s") or 0.0), 4,
                            ),
                            "trend_magnitude_1800s": round(
                                float(preds.get("trend_magnitude_1800s") or 0.0), 2,
                            ),
                            "regime": regime,
                            "entry": trend_sig.entry,
                            "tp": trend_sig.tp,
                            "sl": trend_sig.sl,
                            "rr": trend_sig.rr,
                            "atm_strike": row.get("atm_strike"),
                            "atm_ce_ltp": ce_ltp,
                            "atm_pe_ltp": pe_ltp,
                            "atm_ce_security_id": row.get("atm_ce_security_id"),
                            "atm_pe_security_id": row.get("atm_pe_security_id"),
                            "spot_price": row.get("spot_price"),
                            "model_version": models.version,
                            "gate_mode": "trend",
                            "direction": trend_sig.direction,
                        }
                        raw_logger.log(trend_signal)
                        _send_signal_to_tray(trend_signal)  # live UI tray (Mongo + WS)
                        # Optional: also place the trend trade (off unless SEA_AUTO_TRADE set).
                        _maybe_submit_ai_trade(trend_signal)

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
        _hb_stop.set()  # stop the liveness heartbeat thread
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
