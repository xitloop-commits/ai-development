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
from signal_engine_agent import legacy_filter
from signal_engine_agent.model_loader import LoadedModels, load_models
from signal_engine_agent.thresholds import (
    decide_action,
    load_thresholds,
)
from signal_engine_agent.trade_filter import TickDecision, TradeFilter

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
    filter_mode: str = "gate",
    # Legacy-only knobs
    sustained_n: int = 5,
    avg_prob_thresh: float = 0.65,
    filter_cooldown_sec: float = 60.0,
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

    # Output directory — segment by filter so gate vs legacy A/B sit
    # in distinct dirs and downstream tools can compare scorecards.
    out_dir = output_root / instrument / model_version / date_str / filter_mode
    out_dir.mkdir(parents=True, exist_ok=True)

    if filter_mode == "gate":
        thresholds = load_thresholds(instrument, config_dir)
        trade_filter = None
    elif filter_mode == "legacy":
        thresholds = None
        trade_filter = TradeFilter(
            sustained_n=sustained_n,
            avg_prob_threshold=avg_prob_thresh,
            cooldown_sec=filter_cooldown_sec,
        )
    else:
        raise ValueError(f"filter_mode must be 'gate' or 'legacy', got {filter_mode!r}")

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

            regime = row.get("regime")
            ce_ltp = row.get("opt_0_ce_ltp")
            pe_ltp = row.get("opt_0_pe_ltp")

            # Per E9: upside_percentile_30s is a TFA-emitted live feature
            # column (session rank), not a model target. Read it from the
            # parquet row directly.
            pctile_live = row.get("upside_percentile_30s")
            try:
                pctile_live_f = float(pctile_live) if pctile_live is not None else float("nan")
            except (TypeError, ValueError):
                pctile_live_f = float("nan")

            if filter_mode == "gate":
                preds = {
                    "direction_prob_30s": dir_prob_30,
                    "risk_reward_ratio_30s": rr_pred_30,
                    "upside_percentile_30s": pctile_live_f,
                    "max_upside_30s": up_pred_30,
                    "max_drawdown_30s": dn_pred_30,
                    "max_upside_300s": up_pred_300,
                    "max_drawdown_300s": dn_pred_300,
                    "max_upside_900s": up_pred_900,
                    "max_drawdown_900s": dn_pred_900,
                }
                sig = decide_action(preds, thresholds, ce_ltp=ce_ltp, pe_ltp=pe_ltp)
                action = sig.action
                result = {
                    "entry": sig.entry,
                    "tp": sig.tp,
                    "sl": sig.sl,
                    "rr": sig.rr,
                    "gate_reasons": sig.gate_reasons,
                }
            else:
                # Prefer 15min for TP/SL, fallback to 5min, then 30s
                up_swing = up_pred_900 if not np.isnan(up_pred_900) else up_pred_300
                dn_swing = dn_pred_900 if not np.isnan(dn_pred_900) else dn_pred_300
                legacy = legacy_filter.legacy_decide(
                    dir_prob_30,
                    up_pred_30,
                    dn_pred_30,
                    regime,
                    ce_ltp,
                    pe_ltp,
                    up_pred_swing=up_swing,
                    dn_pred_swing=dn_swing,
                )
                action = legacy.action
                result = {
                    "entry": legacy.entry,
                    "tp": legacy.tp,
                    "sl": legacy.sl,
                    "rr": legacy.rr,
                    "gate_reasons": [],
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
            if filter_mode == "gate":
                # Gate path: write the per-spec diagnostic line for each
                # tick whose gate failed (`fail_reasons` non-empty), so we
                # can tune thresholds offline. Mirrors the live engine's
                # `_filtered_signals.log` schema.
                gate_reasons = result.get("gate_reasons") or []
                if not np.isnan(dir_prob_30) and gate_reasons:
                    filtered_emitted += 1
                    would_be = "GO_CALL" if dir_prob_30 > 0.5 else "GO_PUT"
                    filt_rec = {
                        "tick": i,
                        "timestamp": _safe(row.get("timestamp")),
                        "instrument": instrument.upper(),
                        "would_be_direction": would_be,
                        "fail_reasons": gate_reasons,
                        "direction_prob_30s": _safe(dir_prob_30),
                        "risk_reward_ratio_30s": _safe(rr_pred_30),
                        "upside_percentile_30s": _safe(pctile_live_f),
                        "model_version": model_version,
                    }
                    filtered_list.append(filt_rec)
                    filt_f.write(json.dumps(filt_rec) + "\n")
            else:
                # Legacy path: 4-stage TradeFilter
                tick_decision = TickDecision(
                    timestamp=row.get("timestamp") or 0,
                    action=action,
                    direction_prob=dir_prob_30,
                    max_upside_pred=up_pred_30,
                    max_drawdown_pred=dn_pred_30,
                    risk_reward_pred=rr_pred_30,
                    magnitude_pred=mag_pred_30,
                    regime=regime,
                    entry=result["entry"],
                    tp=result["tp"],
                    sl=result["sl"],
                    rr=result["rr"],
                )
                rec = trade_filter.evaluate(tick_decision)
                if rec is not None:
                    filtered_emitted += 1
                    filt_rec = {
                        **pred_rec,
                        "filter_action": rec.action,
                        "filter_confidence": rec.confidence,
                        "filter_score": rec.score,
                        "filter_sustained": rec.sustained_ticks,
                        "filter_avg_prob": rec.avg_prob,
                        "filter_reasoning": rec.reasoning,
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

    scorecard["filter_mode"] = filter_mode
    if filter_mode == "gate":
        # Gate path: filtered_list is the diagnostic stream of failed-gate
        # ticks. Tally the fail-reason histogram so the PR body has
        # something concrete to compare against the legacy run.
        scorecard["filtered"] = _compute_gate_diagnostics(filtered_list)
    else:
        scorecard["filtered"] = _compute_filtered_metrics(filtered_list, trade_filter.stats())

    (out_dir / "scorecard.json").write_text(
        json.dumps(scorecard, indent=2, default=str), encoding="utf-8"
    )

    _print_scorecard(scorecard)
    return scorecard


def _compute_gate_diagnostics(filtered_signals: list[dict]) -> dict:
    """3-condition gate diagnostic histogram.

    `filtered_signals` here is the stream of ticks that **failed** the
    gate (one record per failed tick). Reports per-condition fail
    counts so the PR body / scorecard can show where most ticks were
    rejected. There's no precision computation in this path because
    no trade was emitted.
    """
    fail_counts: dict[str, int] = {"C1_prob": 0, "C2_rr": 0, "C3_pct": 0}
    for s in filtered_signals:
        for r in s.get("fail_reasons", []) or []:
            if r in fail_counts:
                fail_counts[r] += 1
    return {
        "count": len(filtered_signals),
        "fail_counts": fail_counts,
    }


def _compute_filtered_metrics(filtered_signals: list[dict], filter_stats: dict) -> dict:
    """Compute metrics for filtered trade recommendations (legacy path)."""
    fm: dict = {
        "count": len(filtered_signals),
        "filter_stats": filter_stats,
    }

    if not filtered_signals:
        fm["precision"] = None
        fm["action_breakdown"] = {}
        return fm

    # Direction-based precision (same logic as raw signals)
    counts = {}
    correct = {}
    for s in filtered_signals:
        action = s.get("filter_action", s.get("action"))
        counts[action] = counts.get(action, 0) + 1
        actual_dir = s.get("actual_dir_30s")
        if actual_dir is None:
            continue
        if action == "LONG_CE" and actual_dir == 1:
            correct[action] = correct.get(action, 0) + 1
        elif action == "LONG_PE" and actual_dir == 0:
            correct[action] = correct.get(action, 0) + 1
        elif action == "SHORT_CE" and actual_dir == 0:
            correct[action] = correct.get(action, 0) + 1
        elif action == "SHORT_PE" and actual_dir == 1:
            correct[action] = correct.get(action, 0) + 1

    fm["action_breakdown"] = {}
    total_c = 0
    total_n = 0
    for action in counts:
        n = counts[action]
        c = correct.get(action, 0)
        total_c += c
        total_n += n
        fm["action_breakdown"][action] = {
            "count": n,
            "precision": round(c / n * 100, 2) if n > 0 else None,
        }

    fm["precision"] = round(total_c / total_n * 100, 2) if total_n > 0 else None
    return fm


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
    signal_counts = {"LONG_CE": 0, "LONG_PE": 0, "SHORT_CE": 0, "SHORT_PE": 0}
    signal_correct = {"LONG_CE": 0, "LONG_PE": 0, "SHORT_CE": 0, "SHORT_PE": 0}

    for s in signals:
        action = s["action"]
        if action not in signal_counts:
            continue
        signal_counts[action] += 1

        actual_dir = s.get("actual_dir_30s")
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
        actual_up = s.get("actual_up_30s") or 0
        actual_dn = s.get("actual_dn_30s") or 0

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

    # Filter diagnostics — gate vs legacy summarised differently
    filt = sc.get("filtered", {})
    filter_mode = sc.get("filter_mode", "legacy")
    raw_count = sc.get("total_signals", 0)
    print()
    if filter_mode == "gate":
        fail_counts = filt.get("fail_counts", {})
        print("    ─── 3-Condition Gate Diagnostics ───")
        print(f"      Raw signals (gate-passed):  {raw_count}")
        print(f"      Gate-failed ticks:          {filt.get('count', 0)}")
        if filt.get("count"):
            print(f"      C1_prob fails:  {fail_counts.get('C1_prob', 0)}")
            print(f"      C2_rr   fails:  {fail_counts.get('C2_rr', 0)}")
            print(f"      C3_pct  fails:  {fail_counts.get('C3_pct', 0)}")
    else:
        filt_count = filt.get("count", 0)
        filt_prec = filt.get("precision")
        print("    ─── Filtered Trade Recommendations (LEGACY) ───")
        print(f"      Raw signals:      {raw_count}")
        print(f"      Filtered trades:  {filt_count}")
        if raw_count > 0:
            print(f"      Pass rate:        {filt_count / raw_count * 100:.1f}%")
        if filt_prec is not None:
            print(f"      Precision:        {filt_prec:.1f}%")
        for action, data in filt.get("action_breakdown", {}).items():
            prec = data.get("precision")
            n = data.get("count", 0)
            prec_str = f"{prec:.1f}%" if prec is not None else "—"
            print(f"        {action:<10}  {n:>4} trades  →  {prec_str} correct")
        fstats = filt.get("filter_stats", {})
        if fstats:
            print(f"      Stage 1 (sustained):  {fstats.get('stage1_passed', 0)} passed")
            print(f"      Stage 2 (confidence): {fstats.get('stage2_passed', 0)} passed")
            print(f"      Stage 3 (consensus):  {fstats.get('stage3_passed', 0)} passed")
            print(
                f"      Stage 4 (dir change): {fstats.get('stage4_blocked', 0)} blocked (same direction)"
            )
            print(f"      Cooldown blocked:     {fstats.get('cooldown_blocked', 0)}")

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
    p.add_argument(
        "--filter",
        choices=("gate", "legacy"),
        default="gate",
        help="'gate' = canonical 3-condition gate (Phase D4); "
        "'legacy' = pre-E5 4-stage filter (DEPRECATED)",
    )
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

    try:
        run_scored_backtest(
            instrument=args.instrument,
            date_str=args.date,
            features_root=Path(args.features_root),
            output_root=Path(args.output_root),
            config_dir=Path(args.config_dir),
            filter_mode=args.filter,
            sustained_n=args.sustained_n,
            avg_prob_thresh=args.avg_prob_thresh,
            filter_cooldown_sec=args.filter_cooldown,
        )
    except KeyboardInterrupt:
        print("\n  Stopped by user.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
