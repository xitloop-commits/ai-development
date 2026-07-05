"""
backtest_scored.py — Scored backtest: run SEA inline on parquet, compare predictions
against ground truth, produce a versioned scorecard.

Output:
    data/backtests/{instrument}/{model_version}/{backtest_date}/
      ├── predictions.ndjson   — every tick's raw predictions + ground truth
      ├── signals.ndjson       — only emitted signals (non-WAIT)
      └── scorecard.json       — accuracy metrics

Usage:
    py backtest_scored.py nifty50 2026-04-16
    py backtest_scored.py nifty50 2026-04-16 --models-dir models/nifty50/20260418_002808
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import timedelta, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = Path(__file__).resolve().parent
_PY_MODULES = _HERE / "python_modules"
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

import numpy as np
import pyarrow.parquet as pq

from model_training_agent.preprocessor import preprocess_live_tick
from signal_engine_agent.engine import _build_structure_context
from signal_engine_agent.model_loader import LoadedModels, load_models
from signal_engine_agent.thresholds import (
    Wave2Thresholds,
    apply_buildup_filter,
    apply_trend_alignment,
    decide_action_wave2,
    load_thresholds_full,
    load_thresholds_trend,
)

_IST = timezone(timedelta(hours=5, minutes=30))

# ── Target columns we score against ─────────────────────────────────────────

_DIRECTION_TARGETS = ["direction_30s", "direction_60s"]
_REGRESSION_TARGETS = [
    "max_upside_30s",
    "max_upside_60s",
    "max_drawdown_30s",
    "max_drawdown_60s",
    "risk_reward_ratio_30s",
    "risk_reward_ratio_60s",
    "direction_30s_magnitude",
    "direction_60s_magnitude",
    "total_premium_decay_30s",
    "total_premium_decay_60s",
    "avg_decay_per_strike_30s",
    "avg_decay_per_strike_60s",
    "upside_percentile_30s",
]


def _safe(v):
    """Convert numpy/pyarrow types to JSON-safe Python types."""
    if v is None:
        return None
    if isinstance(v, (np.floating, float)):
        if np.isnan(v) or np.isinf(v):
            return None
        return round(float(v), 6)
    if isinstance(v, (np.integer, int)):
        return int(v)
    if hasattr(v, "item"):
        return v.item()
    return v


def run_scored_backtest(
    instrument: str,
    date_str: str,
    models: LoadedModels | None = None,
    features_root: Path = Path("data/features"),
    output_root: Path = Path("data/backtests"),
    config_dir: Path = Path("config/sea_thresholds"),
) -> dict:
    """Run scored backtest, return scorecard dict."""

    parquet_path = features_root / date_str / f"{instrument}_features.parquet"
    if not parquet_path.exists():
        print(f"  ERROR: {parquet_path} not found")
        sys.exit(1)

    # Load models
    if models is None:
        models = load_models(instrument)

    model_version = models.version

    # Output directory. Older A/B runs lived under a `gate/` or
    # `legacy/` subdir; keeping the `gate/` suffix preserves cross-
    # scorecard tooling that hard-codes the path shape.
    out_dir = output_root / instrument / model_version / date_str / "gate"
    out_dir.mkdir(parents=True, exist_ok=True)

    # 2026-06-23 fix: load BOTH the base 3-cond and the Wave 2 add-on
    # from the per-instrument JSON (was passing Wave2Thresholds() defaults
    # which ignored every tuning override in config/sea_thresholds/*.json).
    trend_thresholds = load_thresholds_trend(instrument, config_dir)
    thresholds, _v2, wave2_thresholds, _gate_mode = load_thresholds_full(
        instrument, config_dir,
    )

    print()
    print("  ═══════════════════════════════════════════════════════════")
    print(f"    SCORED BACKTEST — {instrument} / {date_str}")
    print("  ═══════════════════════════════════════════════════════════")
    print(f"    Model:    {model_version}")
    print(f"    Source:   {parquet_path}")
    print(f"    Output:   {out_dir}")
    print("  ═══════════════════════════════════════════════════════════")
    print()

    # Read parquet as list of dicts
    table = pq.read_table(parquet_path)
    col_names = table.schema.names
    n_rows = table.num_rows

    print(f"  Loaded {n_rows:,} rows, {len(col_names)} cols")

    # Pre-extract columns for fast row iteration
    col_data = {c: table.column(c).to_pylist() for c in col_names}

    # Counters
    processed = 0
    skipped = 0
    signals_emitted = 0
    filtered_emitted = 0
    predictions_list: list[dict] = []
    signals_list: list[dict] = []
    filtered_list: list[dict] = []

    # Cooldown tracking (same as live SEA)
    COOLDOWN_SEC = 30
    last_action = ""
    last_emit_ts = 0.0

    started = time.time()

    pred_f = open(out_dir / "predictions.ndjson", "w", encoding="utf-8")
    sig_f = open(out_dir / "signals.ndjson", "w", encoding="utf-8")
    filt_f = open(out_dir / "filtered_signals.ndjson", "w", encoding="utf-8")

    try:
        for i in range(n_rows):
            row = {c: col_data[c][i] for c in col_names}

            # Skip non-TRADING rows
            if row.get("trading_state") != "TRADING":
                skipped += 1
                continue
            if row.get("data_quality_flag") == 0:
                skipped += 1
                continue

            # Preprocess
            vec = preprocess_live_tick(row, models.feature_config)
            if vec is None:
                skipped += 1
                continue

            X = vec.reshape(1, -1)

            # Predict all available models
            def _pred(name: str) -> float:
                m = models.models.get(name)
                return float(m.predict(X)[0]) if m else float("nan")

            def _pred_cal(name: str) -> float:
                # Calibrated (isotonic) — the gate/filters key off calibrated
                # probs. Raw trend_direction tops ~0.48 and would never clear
                # dir_prob_min, so trend-alignment needs the calibrated value.
                m = models.models.get(name)
                if m is None:
                    return float("nan")
                return float(models.apply_calibration(name, float(m.predict(X)[0])))

            dir_prob_30 = _pred("direction_30s")
            dir_prob_60 = _pred("direction_60s")
            up_pred_30 = _pred("max_upside_30s")
            up_pred_60 = _pred("max_upside_60s")
            dn_pred_30 = _pred("max_drawdown_30s")
            dn_pred_60 = _pred("max_drawdown_60s")
            rr_pred_30 = _pred("risk_reward_ratio_30s")
            rr_pred_60 = _pred("risk_reward_ratio_60s")
            mag_pred_30 = _pred("direction_30s_magnitude")
            mag_pred_60 = _pred("direction_60s_magnitude")
            decay_pred_30 = _pred("total_premium_decay_30s")
            decay_pred_60 = _pred("total_premium_decay_60s")
            avg_decay_30 = _pred("avg_decay_per_strike_30s")
            avg_decay_60 = _pred("avg_decay_per_strike_60s")
            pctile_pred = _pred("upside_percentile_30s")
            # Swing predictions (5min / 15min)
            up_pred_300 = _pred("max_upside_300s")
            dn_pred_300 = _pred("max_drawdown_300s")
            up_pred_900 = _pred("max_upside_900s")
            dn_pred_900 = _pred("max_drawdown_900s")
            # Multi-horizon direction (2026-06-21): scalp 300s, trend
            # 900s/1800s, swing 3600s/7200s -- captured so the chart
            # visualizer can show when all horizons agree (high-conviction
            # entry zone) vs disagree (regime change / chop).
            dir_prob_300 = _pred("direction_300s")
            trend_dir_900 = _pred("trend_direction_900s")
            trend_dir_1800 = _pred("trend_direction_1800s")
            swing_dir_3600 = _pred("swing_direction_3600s")
            swing_dir_7200 = _pred("swing_direction_7200s")
            # Wave 2 gate inputs (2026-06-21): SEA's live engine.py uses
            # decide_action_wave2 with these; backtest now mirrors the
            # production gate so signal counts match what Monday will see.
            persists_60 = _pred("direction_persists_60s")
            persists_300 = _pred("direction_persists_300s")
            exit_60 = _pred("exit_signal_60s")
            breakout_60 = _pred("breakout_in_60s")
            # Part B PE-leg heads (2026-07-06): the live engine passes these;
            # without them a PUT gets no PE-leg RR (C2) or TP/SL → the gate
            # returns WAIT on every put. Their absence is why the backtest
            # showed 0 puts across all OOS days. Feed them like production.
            rr_pe_60 = _pred("risk_reward_ratio_pe_60s")
            up_pe_60 = _pred("max_upside_pe_60s")
            dn_pe_60 = _pred("max_drawdown_pe_60s")
            up_pe_300 = _pred("max_upside_pe_300s")
            dn_pe_300 = _pred("max_drawdown_pe_300s")

            regime = row.get("regime")
            ce_ltp = row.get("opt_0_ce_ltp")
            pe_ltp = row.get("opt_0_pe_ltp")

            # upside_percentile is TFA-emitted (session rank), not a model
            # target -- read from the parquet row. Wave 2 uses the 60s
            # window; fall back to 30s if the 60s column isn't present
            # (older parquets pre-Wave-2 schema).
            pctile_live = row.get("upside_percentile_60s")
            if pctile_live is None:
                pctile_live = row.get("upside_percentile_30s")
            try:
                pctile_live_f = float(pctile_live) if pctile_live is not None else float("nan")
            except (TypeError, ValueError):
                pctile_live_f = float("nan")

            # Wave 2 preds dict (2026-06-21): mirrors what SEA's live
            # engine.py passes to decide_action_wave2. The base 3-cond
            # gate now reads the 60s window (was 30s pre-Wave-2); W1-W4
            # add the new model-driven checks (persistence, exit,
            # breakout). The legacy 30s entries are kept for the
            # scorecard's MAE/correlation print, but the gate uses 60s.
            preds = {
                # Base 3-cond (60s window per Wave 2 spec)
                "direction_prob_60s": dir_prob_60,
                "risk_reward_ratio_60s": rr_pred_60,
                "upside_percentile_60s": pctile_live_f,
                # Wave 2 model gates
                "direction_persists_60s": persists_60,
                "direction_persists_300s": persists_300,
                "exit_signal_60s": exit_60,
                "breakout_in_60s": breakout_60,
                # TP/SL inputs (60s + swing horizons)
                "max_upside_60s": up_pred_60,
                "max_drawdown_60s": dn_pred_60,
                "max_upside_300s": up_pred_300,
                "max_drawdown_300s": dn_pred_300,
                "max_upside_900s": up_pred_900,
                "max_drawdown_900s": dn_pred_900,
                # Part B PE-leg targets — put RR (C2) + put TP/SL.
                "risk_reward_ratio_pe_60s": rr_pe_60,
                "max_upside_pe_60s": up_pe_60,
                "max_drawdown_pe_60s": dn_pe_60,
                "max_upside_pe_300s": up_pe_300,
                "max_drawdown_pe_300s": dn_pe_300,
                # Calibrated 30-min trend heads — for apply_trend_alignment.
                "trend_direction_1800s": _pred_cal("trend_direction_1800s"),
                "trend_direction_down_1800s": _pred_cal("trend_direction_down_1800s"),
            }
            structure = (
                _build_structure_context(row)
                if wave2_thresholds.structure_tp_sl else None
            )
            sig = decide_action_wave2(
                preds, thresholds, wave2_thresholds,
                ce_ltp=ce_ltp, pe_ltp=pe_ltp, structure=structure,
            )
            # Post-gate filters — mirror the live engine so buildup/trend-align
            # are actually exercised in the backtest (they were absent before).
            sig = apply_trend_alignment(
                sig, preds, trend_thresholds.dir_prob_min,
                enabled=wave2_thresholds.scalp_trend_align and trend_thresholds.enabled,
            )
            sig = apply_buildup_filter(
                sig, row, wave2_thresholds, enabled=wave2_thresholds.buildup_filter,
            )
            action = sig.action
            result = {
                "entry": sig.entry,
                "tp": sig.tp,
                "sl": sig.sl,
                "rr": sig.rr,
                "gate_reasons": sig.gate_reasons,
            }
            processed += 1

            # Build prediction record with ground truth
            pred_rec = {
                "tick": i,
                "timestamp": _safe(row.get("timestamp")),
                "action": action,
                "regime": regime,
                # Predictions
                "pred_dir_30s": _safe(dir_prob_30),
                "pred_dir_60s": _safe(dir_prob_60),
                # Multi-horizon direction predictions (scalp / trend / swing)
                "pred_dir_300s": _safe(dir_prob_300),
                "pred_trend_dir_900s": _safe(trend_dir_900),
                "pred_trend_dir_1800s": _safe(trend_dir_1800),
                "pred_swing_dir_3600s": _safe(swing_dir_3600),
                "pred_swing_dir_7200s": _safe(swing_dir_7200),
                "pred_up_30s": _safe(up_pred_30),
                "pred_up_60s": _safe(up_pred_60),
                "pred_dn_30s": _safe(dn_pred_30),
                "pred_dn_60s": _safe(dn_pred_60),
                "pred_rr_30s": _safe(rr_pred_30),
                "pred_rr_60s": _safe(rr_pred_60),
                "pred_mag_30s": _safe(mag_pred_30),
                "pred_mag_60s": _safe(mag_pred_60),
                "pred_decay_30s": _safe(decay_pred_30),
                "pred_decay_60s": _safe(decay_pred_60),
                "pred_avg_decay_30s": _safe(avg_decay_30),
                "pred_avg_decay_60s": _safe(avg_decay_60),
                "pred_pctile_30s": _safe(pctile_pred),
                # Ground truth
                "actual_dir_30s": _safe(row.get("direction_30s")),
                "actual_dir_60s": _safe(row.get("direction_60s")),
                # Multi-horizon ground truth (2026-06-21) so the chart
                # can paint correct/wrong markers for trend + swing too.
                "actual_dir_300s": _safe(row.get("direction_300s")),
                "actual_trend_dir_900s": _safe(row.get("trend_direction_900s")),
                "actual_trend_dir_1800s": _safe(row.get("trend_direction_1800s")),
                "actual_swing_dir_3600s": _safe(row.get("swing_direction_3600s")),
                "actual_swing_dir_7200s": _safe(row.get("swing_direction_7200s")),
                "actual_up_30s": _safe(row.get("max_upside_30s")),
                "actual_up_60s": _safe(row.get("max_upside_60s")),
                "actual_dn_30s": _safe(row.get("max_drawdown_30s")),
                "actual_dn_60s": _safe(row.get("max_drawdown_60s")),
                "actual_rr_30s": _safe(row.get("risk_reward_ratio_30s")),
                "actual_rr_60s": _safe(row.get("risk_reward_ratio_60s")),
                "actual_mag_30s": _safe(row.get("direction_30s_magnitude")),
                "actual_mag_60s": _safe(row.get("direction_60s_magnitude")),
                "actual_decay_30s": _safe(row.get("total_premium_decay_30s")),
                "actual_decay_60s": _safe(row.get("total_premium_decay_60s")),
                "actual_pctile_30s": _safe(row.get("upside_percentile_30s")),
                # Context
                "entry": _safe(result["entry"]),
                "tp": _safe(result["tp"]),
                "sl": _safe(result["sl"]),
                "rr": _safe(result["rr"]),
                "spot_price": _safe(row.get("spot_price")),
                "ce_ltp": _safe(ce_ltp),
                "pe_ltp": _safe(pe_ltp),
            }
            predictions_list.append(pred_rec)
            pred_f.write(json.dumps(pred_rec) + "\n")

            # Signal emission (with cooldown, same as live)
            now_ts = row.get("timestamp") or 0
            should_emit = action != "WAIT" and (
                action != last_action or now_ts - last_emit_ts >= COOLDOWN_SEC
            )
            if should_emit:
                last_action = action
                last_emit_ts = now_ts
                signals_list.append(pred_rec)
                sig_f.write(json.dumps(pred_rec) + "\n")
                signals_emitted += 1

            # ── Filtered output ──
            # Write the per-spec diagnostic line for each tick whose
            # gate failed (`fail_reasons` non-empty), so we can tune
            # thresholds offline. Mirrors the live engine's
            # `_filtered_signals.log` schema.
            gate_reasons = result.get("gate_reasons") or []
            # Wave 2 filtered-signal record: anchored on the 60s window
            # the gate actually consumes (was 30s pre-Wave-2). The 30s
            # cols are still printed in MAE/correlation, just not used
            # for the gate.
            if not np.isnan(dir_prob_60) and gate_reasons:
                filtered_emitted += 1
                would_be = "GO_CALL" if dir_prob_60 > 0.5 else "GO_PUT"
                filt_rec = {
                    "tick": i,
                    "timestamp": _safe(row.get("timestamp")),
                    "instrument": instrument.upper(),
                    "would_be_direction": would_be,
                    "fail_reasons": gate_reasons,
                    "direction_prob_60s": _safe(dir_prob_60),
                    "risk_reward_ratio_60s": _safe(rr_pred_60),
                    "upside_percentile_60s": _safe(pctile_live_f),
                    "direction_persists_60s": _safe(persists_60),
                    "direction_persists_300s": _safe(persists_300),
                    "exit_signal_60s": _safe(exit_60),
                    "breakout_in_60s": _safe(breakout_60),
                    "model_version": model_version,
                }
                filtered_list.append(filt_rec)
                filt_f.write(json.dumps(filt_rec) + "\n")

            # Progress
            if processed % 2000 == 0:
                elapsed = time.time() - started
                rate = processed / max(elapsed, 0.001)
                sys.stdout.write(
                    f"\r  processed {processed:>7,} / {n_rows:,}  "
                    f"raw={signals_emitted}  filtered={filtered_emitted}  ({rate:,.0f}/s)"
                )
                sys.stdout.flush()

    finally:
        pred_f.close()
        sig_f.close()
        filt_f.close()

    elapsed = time.time() - started
    print(
        f"\n\n  Done. {processed:,} ticks processed, "
        f"{signals_emitted} raw signals, {filtered_emitted} filtered in {elapsed:.1f}s\n"
    )

    # ── Compute scorecard ────────────────────────────────────────────────────
    scorecard = _compute_scorecard(
        predictions_list, signals_list, instrument, date_str, model_version, processed, skipped
    )

    # filtered_list is the diagnostic stream of failed-gate ticks.
    # Tally the fail-reason histogram so threshold tuning has
    # something concrete to compare across runs.
    scorecard["filtered"] = _compute_gate_diagnostics(filtered_list)

    (out_dir / "scorecard.json").write_text(
        json.dumps(scorecard, indent=2, default=str), encoding="utf-8"
    )

    _print_scorecard(scorecard)

    # Auto-render the interactive prediction chart (2026-06-21). Best-
    # effort -- a chart-build failure must not fail the backtest itself.
    # Prints `file:///...` URL the operator can click to open in browser.
    try:
        _render_prediction_chart(
            instrument=instrument,
            date_str=date_str,
            model_version=model_version,
            out_dir=out_dir,
        )
    except Exception as exc:  # noqa: BLE001 -- visualization is non-fatal
        print(f"\n  (chart skipped: {type(exc).__name__}: {exc})\n")

    return scorecard


def _render_prediction_chart(
    *,
    instrument: str,
    date_str: str,
    model_version: str,
    out_dir: Path,
) -> None:
    """Call scripts/plot_backtest.py for this run and print its file URL.

    Invoked at the tail of each backtest so the operator gets a clickable
    chart link in the cmd window. Failures (missing plotly, malformed
    predictions, etc.) are caught upstream so the backtest itself stays
    green even if the chart can't render.
    """
    import sys as _sys
    import subprocess as _subprocess
    script = Path(__file__).resolve().parent / "scripts" / "plot_backtest.py"
    if not script.exists():
        return
    # Drain our buffered output BEFORE spawning the child so cmd shows the
    # scorecard fully before the chart URL prints below it.
    _sys.stdout.flush()
    _subprocess.run(
        [_sys.executable, str(script), instrument, date_str,
         "--model-version", model_version],
        check=False,
    )


def _compute_gate_diagnostics(filtered_signals: list[dict]) -> dict:
    """7-condition Wave-2 gate diagnostic histogram (2026-06-21).

    `filtered_signals` here is the stream of ticks that **failed** the
    gate (one record per failed tick). Reports per-condition fail
    counts so the PR body / scorecard can show where most ticks were
    rejected. There's no precision computation in this path because
    no trade was emitted.

    Base (Wave 1): C1_prob, C2_rr, C3_pct
    Wave 2 add-ons: W1_persists_60s, W2_persists_300s, W3_exit_signal,
                    W4_breakout_in
    Sentinel: MISSING_PREDICTION (one of the required inputs was NaN)
    """
    fail_counts: dict[str, int] = {
        "C1_prob": 0, "C2_rr": 0, "C3_pct": 0,
        "W1_persists_60s": 0, "W2_persists_300s": 0,
        "W3_exit_signal": 0, "W4_breakout_in": 0,
        "MISSING_PREDICTION": 0,
    }
    for s in filtered_signals:
        for r in s.get("fail_reasons", []) or []:
            if r in fail_counts:
                fail_counts[r] += 1
    return {
        "count": len(filtered_signals),
        "fail_counts": fail_counts,
    }


def _compute_scorecard(
    predictions: list[dict],
    signals: list[dict],
    instrument: str,
    date_str: str,
    model_version: str,
    total_processed: int,
    total_skipped: int,
) -> dict:
    """Compute accuracy metrics from predictions vs ground truth."""

    sc: dict = {
        "instrument": instrument,
        "date": date_str,
        "model_version": model_version,
        "total_ticks": total_processed,
        "total_skipped": total_skipped,
        "total_signals": len(signals),
    }

    # ── Direction accuracy (all ticks) ───────────────────────────────────
    for window in ("30s", "60s"):
        pred_key = f"pred_dir_{window}"
        actual_key = f"actual_dir_{window}"
        pairs = [
            (p[pred_key], p[actual_key])
            for p in predictions
            if p.get(pred_key) is not None and p.get(actual_key) is not None
        ]
        if pairs:
            correct = sum(
                1
                for prob, actual in pairs
                if (prob >= 0.5 and actual == 1) or (prob < 0.5 and actual == 0)
            )
            sc[f"direction_{window}_accuracy"] = round(correct / len(pairs) * 100, 2)
            sc[f"direction_{window}_n"] = len(pairs)
            # Avg probability when correct vs wrong
            correct_probs = [
                prob
                for prob, actual in pairs
                if (prob >= 0.5 and actual == 1) or (prob < 0.5 and actual == 0)
            ]
            wrong_probs = [
                prob
                for prob, actual in pairs
                if not ((prob >= 0.5 and actual == 1) or (prob < 0.5 and actual == 0))
            ]
            sc[f"direction_{window}_avg_confidence_correct"] = (
                round(np.mean([abs(p - 0.5) for p in correct_probs]) * 2 * 100, 2)
                if correct_probs
                else None
            )
            sc[f"direction_{window}_avg_confidence_wrong"] = (
                round(np.mean([abs(p - 0.5) for p in wrong_probs]) * 2 * 100, 2)
                if wrong_probs
                else None
            )

    # ── Signal precision (only emitted signals) ─────────────────────────
    # 2026-06-23: precision check now uses actual_dir_60s (matches the
    # Wave 2 gate's 60s horizon). Previously read actual_dir_30s which
    # is NaN under the current model -- new MVP_TARGETS dropped the 30s
    # window (direction_60s/120s/180s/240s/300s only). That made the
    # precision tally skip every signal and report 0% even when the
    # gate fired correctly.
    signal_counts = {"LONG_CE": 0, "LONG_PE": 0, "SHORT_CE": 0, "SHORT_PE": 0}
    signal_correct = {"LONG_CE": 0, "LONG_PE": 0, "SHORT_CE": 0, "SHORT_PE": 0}

    for s in signals:
        action = s["action"]
        if action not in signal_counts:
            continue
        signal_counts[action] += 1

        actual_dir = s.get("actual_dir_60s")
        if actual_dir is None:
            continue

        # LONG_CE correct if underlying went up (direction=1 → CE appreciates)
        # LONG_PE correct if underlying went down (direction=0 → PE appreciates)
        # SHORT_CE correct if underlying didn't go up (direction=0 → CE decays)
        # SHORT_PE correct if underlying didn't go down (direction=1 → PE decays)
        if action == "LONG_CE" and actual_dir == 1:
            signal_correct[action] += 1
        elif action == "LONG_PE" and actual_dir == 0:
            signal_correct[action] += 1
        elif action == "SHORT_CE" and actual_dir == 0:
            signal_correct[action] += 1
        elif action == "SHORT_PE" and actual_dir == 1:
            signal_correct[action] += 1

    sc["signal_counts"] = signal_counts
    sc["signal_precision"] = {}
    for action in signal_counts:
        n = signal_counts[action]
        if n > 0:
            sc["signal_precision"][action] = round(signal_correct[action] / n * 100, 2)

    overall_signals = sum(signal_counts.values())
    overall_correct = sum(signal_correct.values())
    sc["signal_precision_overall"] = (
        round(overall_correct / overall_signals * 100, 2) if overall_signals > 0 else None
    )

    # ── TP/SL hit rate (signals only) ───────────────────────────────────
    tp_hits = 0
    sl_hits = 0
    neither = 0
    for s in signals:
        action = s["action"]
        entry = s.get("entry") or 0
        tp = s.get("tp") or 0
        sl = s.get("sl") or 0
        # 2026-06-23: use 60s actuals (was 30s, now NaN for current model).
        actual_up = s.get("actual_up_60s") or 0
        actual_dn = s.get("actual_dn_60s") or 0

        if entry <= 0 or tp <= 0 or sl <= 0:
            continue

        if "LONG" in action:
            # For LONG: TP hit if actual upside >= TP distance
            tp_dist = tp - entry
            sl_dist = entry - sl
            if actual_up >= tp_dist:
                tp_hits += 1
            elif abs(actual_dn) >= sl_dist:
                sl_hits += 1
            else:
                neither += 1
        elif "SHORT" in action:
            # For SHORT: TP hit if decay/reversal >= TP distance
            tp_dist = entry - tp
            sl_dist = sl - entry
            if abs(actual_dn) >= tp_dist:
                tp_hits += 1
            elif actual_up >= sl_dist:
                sl_hits += 1
            else:
                neither += 1

    total_tp_sl = tp_hits + sl_hits + neither
    sc["tp_hit_rate"] = round(tp_hits / total_tp_sl * 100, 2) if total_tp_sl > 0 else None
    sc["sl_hit_rate"] = round(sl_hits / total_tp_sl * 100, 2) if total_tp_sl > 0 else None
    sc["neither_rate"] = round(neither / total_tp_sl * 100, 2) if total_tp_sl > 0 else None

    # ── Regression accuracy (MAE for upside/drawdown predictions) ───────
    for target in ("up_30s", "up_60s", "dn_30s", "dn_60s"):
        pred_key = f"pred_{target}"
        actual_key = f"actual_{target}"
        pairs = [
            (p[pred_key], p[actual_key])
            for p in predictions
            if p.get(pred_key) is not None and p.get(actual_key) is not None
        ]
        if pairs:
            mae = np.mean([abs(pred - actual) for pred, actual in pairs])
            corr = np.corrcoef([p[0] for p in pairs], [p[1] for p in pairs])[0, 1]
            sc[f"mae_{target}"] = round(float(mae), 4)
            sc[f"correlation_{target}"] = round(float(corr), 4) if not np.isnan(corr) else None

    # ── Regime distribution ─────────────────────────────────────────────
    regimes = {}
    for p in predictions:
        r = p.get("regime") or "NONE"
        regimes[r] = regimes.get(r, 0) + 1
    sc["regime_distribution"] = regimes

    return sc


def _print_scorecard(sc: dict) -> None:
    """Pretty-print the scorecard to terminal."""
    print("  ═══════════════════════════════════════════════════════════")
    print(f"    SCORECARD — {sc['instrument']} / {sc['date']}")
    print(f"    Model: {sc['model_version']}")
    print("  ═══════════════════════════════════════════════════════════")
    print()

    print(f"    Ticks processed:  {sc['total_ticks']:,}")
    print(f"    Signals emitted:  {sc['total_signals']}")
    print()

    # Direction accuracy
    for w in ("30s", "60s"):
        acc = sc.get(f"direction_{w}_accuracy")
        n = sc.get(f"direction_{w}_n")
        conf_c = sc.get(f"direction_{w}_avg_confidence_correct")
        conf_w = sc.get(f"direction_{w}_avg_confidence_wrong")
        if acc is not None:
            print(f"    Direction {w}:  {acc:.1f}% accuracy  (n={n:,})")
            if conf_c is not None:
                print(f"      Confidence when correct: {conf_c:.1f}%  |  wrong: {conf_w:.1f}%")

    print()

    # Signal precision
    print("    Signal Precision:")
    for action, count in sc.get("signal_counts", {}).items():
        prec = sc.get("signal_precision", {}).get(action)
        if count > 0:
            print(f"      {action:<10}  {count:>4} signals  →  {prec:.1f}% correct")
    overall = sc.get("signal_precision_overall")
    if overall is not None:
        print(f"      {'OVERALL':<10}  {sc['total_signals']:>4} signals  →  {overall:.1f}% correct")

    print()

    # TP/SL
    tp = sc.get("tp_hit_rate")
    sl = sc.get("sl_hit_rate")
    if tp is not None:
        print(
            f"    TP hit: {tp:.1f}%  |  SL hit: {sl:.1f}%  |  Neither: {sc.get('neither_rate', 0):.1f}%"
        )

    print()

    # Regression MAE
    print("    Prediction MAE / Correlation:")
    for target in ("up_30s", "up_60s", "dn_30s", "dn_60s"):
        mae = sc.get(f"mae_{target}")
        corr = sc.get(f"correlation_{target}")
        if mae is not None:
            corr_str = f"{corr:.3f}" if corr is not None else "N/A"
            print(f"      {target:<8}  MAE={mae:.4f}  corr={corr_str}")

    print()

    # Regime distribution
    print("    Regime distribution:")
    for r, count in sorted(sc.get("regime_distribution", {}).items(), key=lambda x: -x[1]):
        pct = count / max(sc["total_ticks"], 1) * 100
        print(f"      {r:<10}  {count:>6,}  ({pct:.1f}%)")

    # Wave 2 gate diagnostics (2026-06-21): 3 base + 4 Wave 2 model
    # conditions + MISSING_PREDICTION sentinel. Sorted by frequency
    # so the biggest blocker is most visible.
    filt = sc.get("filtered", {})
    raw_count = sc.get("total_signals", 0)
    fail_counts = filt.get("fail_counts", {})
    print()
    print("    ─── Wave 2 Gate Diagnostics ───")
    print(f"      Raw signals (gate-passed):  {raw_count}")
    print(f"      Gate-failed ticks:          {filt.get('count', 0)}")
    if filt.get("count"):
        # All 7 conditions + sentinel, sorted by count descending so
        # the biggest blocker pops first.
        ordered = sorted(
            (k for k in fail_counts.keys()),
            key=lambda k: -fail_counts.get(k, 0),
        )
        for key in ordered:
            if fail_counts.get(key, 0) > 0:
                print(f"      {key:25s} {fail_counts[key]:>6}")

    print()
    print("  ═══════════════════════════════════════════════════════════")
    print()


# ── CLI ──────────────────────────────────────────────────────────────────────


def main() -> int:
    p = argparse.ArgumentParser(
        prog="backtest_scored",
        description="Run SEA inference on parquet with scorecard",
    )
    p.add_argument("instrument", choices=("nifty50", "banknifty", "crudeoil", "naturalgas"))
    p.add_argument("date", help="YYYY-MM-DD (parquet date to backtest)")
    p.add_argument("--features-root", default="data/features")
    p.add_argument("--output-root", default="data/backtests")
    p.add_argument(
        "--config-dir",
        default="config/sea_thresholds",
        help="Per-instrument SEA thresholds JSON dir",
    )
    args = p.parse_args()

    try:
        run_scored_backtest(
            instrument=args.instrument,
            date_str=args.date,
            features_root=Path(args.features_root),
            output_root=Path(args.output_root),
            config_dir=Path(args.config_dir),
        )
    except KeyboardInterrupt:
        print("\n  Stopped by user.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
