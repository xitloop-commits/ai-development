"""
benchmark_signal_persistence.py — Phase 1A signal-quality benchmark.

Replays parquet feature data through 3 gate modes and reports per-mode metrics.
Used to validate the multi-horizon + sustained-tick changes BEFORE touching
production code.

Modes:
  1. current               — production gate (30s prob/RR/pctile only)
  2. multi_horizon         — current + C0 (30s/300s/900s direction agreement) + C4 (900s prob >= 0.70)
  3. multi_horizon_sustained — multi_horizon + N=10 consecutive same-action ticks

Days: 2026-04-22, 2026-04-29 (validated full-coverage)
Instruments: nifty50, banknifty, crudeoil, naturalgas
Filter to session hours: NSE 09:15–15:30 IST, MCX 09:00–23:30 IST.

Usage:
    py scripts/benchmark_signal_persistence.py
    py scripts/benchmark_signal_persistence.py --days 2026-04-22
    py scripts/benchmark_signal_persistence.py --instruments nifty50 banknifty
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent
_PY_MODULES = _REPO / "python_modules"
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

import numpy as np
import pyarrow.parquet as pq

from model_training_agent.preprocessor import preprocess_live_tick
from signal_engine_agent.model_loader import LoadedModels, load_models
from signal_engine_agent.sustain import SustainFilter
from signal_engine_agent.thresholds import (
    SignalAction,
    Thresholds,
    V2Thresholds,
    decide_action,
    decide_action_v2,
    load_thresholds,
    load_thresholds_v2,
)

# ── Constants ──────────────────────────────────────────────────────────────

_IST = timezone(timedelta(hours=5, minutes=30))

DEFAULT_DAYS = ["2026-04-22", "2026-04-29"]
DEFAULT_INSTRUMENTS = ["nifty50", "banknifty", "crudeoil", "naturalgas"]
MODES = ["current", "multi_horizon", "multi_horizon_sustained", "wave1_deterministic"]

# Session hours per exchange (IST)
SESSION_HOURS = {
    "nifty50":    (9, 15, 15, 30),   # NSE: 09:15 → 15:30
    "banknifty":  (9, 15, 15, 30),
    "crudeoil":   (9, 0, 23, 30),    # MCX: 09:00 → 23:30
    "naturalgas": (9, 0, 23, 30),
}

# Phase 1A tunables
PROB_900_MIN = 0.70                # 15-min direction conviction threshold
SUSTAIN_N = 10                     # consecutive same-action ticks
COOLDOWN_SEC = 30                  # same as production cooldown


# ── Session filter ─────────────────────────────────────────────────────────

def _in_session(ts_unix: float, instrument: str) -> bool:
    """Filter rows to the instrument's regular session hours in IST."""
    sh, sm, eh, em = SESSION_HOURS[instrument]
    dt = datetime.fromtimestamp(ts_unix, tz=_IST)
    start = dt.replace(hour=sh, minute=sm, second=0, microsecond=0)
    end = dt.replace(hour=eh, minute=em, second=0, microsecond=0)
    return start <= dt <= end


# ── Gate modes ─────────────────────────────────────────────────────────────

def _gate_current(preds: dict, thr: Thresholds, ce_ltp, pe_ltp) -> SignalAction:
    """Current production gate — direct delegation to decide_action."""
    return decide_action(preds, thr, ce_ltp=ce_ltp, pe_ltp=pe_ltp)


def _gate_multi_horizon(preds: dict, thr: Thresholds, ce_ltp, pe_ltp) -> SignalAction:
    """Multi-horizon agreement gate.

    Adds two conditions on top of the current gate:
      C0  — direction_30s, direction_300s, direction_900s all agree on side
      C4  — direction_prob_900s conviction >= PROB_900_MIN (0.70)
    """
    base = decide_action(preds, thr, ce_ltp=ce_ltp, pe_ltp=pe_ltp)
    if not base.gate_passed:
        return base

    d30 = preds.get("direction_prob_30s")
    d300 = preds.get("direction_prob_300s")
    d900 = preds.get("direction_prob_900s")

    extra: list[str] = []
    if any(v is None or (isinstance(v, float) and math.isnan(v)) for v in (d30, d300, d900)):
        extra.append("C0_missing_horizon")
    else:
        same_side = (d30 > 0.5) == (d300 > 0.5) == (d900 > 0.5)
        if not same_side:
            extra.append("C0_horizon_mismatch")
        prob_900 = max(d900, 1.0 - d900)
        if prob_900 < PROB_900_MIN:
            extra.append("C4_900s_prob")

    if extra:
        return SignalAction(
            action="WAIT", direction="WAIT",
            entry=0.0, tp=0.0, sl=0.0, rr=0.0,
            gate_passed=False, gate_reasons=base.gate_reasons + extra,
        )
    return base


def _gate_multi_horizon_sustained(
    preds: dict, thr: Thresholds, ce_ltp, pe_ltp, history: deque
) -> SignalAction:
    """multi_horizon + sustained-N=10 consecutive same-action ticks before emit.

    `history` is a deque (maxlen=N) holding the most recent gate-decision
    actions. WAIT decisions break the run.
    """
    sig = _gate_multi_horizon(preds, thr, ce_ltp, pe_ltp)

    history.append(sig.action if sig.gate_passed else "WAIT")
    if len(history) < SUSTAIN_N:
        return _wait("C5_warming_up")
    if not all(a == sig.action and a != "WAIT" for a in history):
        if not sig.gate_passed:
            return sig  # propagate underlying reason
        return _wait("C5_not_sustained")
    return sig


def _wait(reason: str) -> SignalAction:
    return SignalAction(
        action="WAIT", direction="WAIT",
        entry=0.0, tp=0.0, sl=0.0, rr=0.0,
        gate_passed=False, gate_reasons=[reason],
    )


# ── Per-tick prediction (mirrors backtest_scored.py) ──────────────────────

def _gather_preds(models: LoadedModels, X) -> dict:
    """All predictions the 3 gate modes might need."""
    def p(name: str) -> float:
        m = models.models.get(name)
        return float(m.predict(X)[0]) if m else float("nan")
    return {
        "direction_prob_30s":     p("direction_30s"),
        "direction_prob_60s":     p("direction_60s"),
        "direction_prob_300s":    p("direction_300s"),
        "direction_prob_900s":    p("direction_900s"),
        "risk_reward_ratio_30s":  p("risk_reward_ratio_30s"),
        "max_upside_30s":         p("max_upside_30s"),
        "max_drawdown_30s":       p("max_drawdown_30s"),
        "max_upside_300s":        p("max_upside_300s"),
        "max_drawdown_300s":      p("max_drawdown_300s"),
        "max_upside_900s":        p("max_upside_900s"),
        "max_drawdown_900s":      p("max_drawdown_900s"),
    }


# ── Per-day/instrument run ─────────────────────────────────────────────────

def run_one_day_instrument(
    instrument: str, day: str, features_root: Path,
) -> dict[str, list[dict]]:
    """Run all 3 modes against one (day, instrument). Returns per-mode signal lists."""
    parquet_path = features_root / day / f"{instrument}_features.parquet"
    if not parquet_path.exists():
        print(f"  [SKIP] {parquet_path} not found")
        return {m: [] for m in MODES}

    models = load_models(instrument)
    thresholds, v2_thresholds = load_thresholds_v2(instrument, Path("config/sea_thresholds"))

    print(f"  [{instrument}/{day}] loading parquet...", end=" ", flush=True)
    table = pq.read_table(parquet_path)
    n_rows = table.num_rows
    col_data = {c: table.column(c).to_pylist() for c in table.schema.names}
    print(f"{n_rows:,} rows")

    # Per-mode state
    sustained_history: deque = deque(maxlen=SUSTAIN_N)
    wave1_sustain = SustainFilter(window_n=SUSTAIN_N)
    last_emit: dict[str, tuple[str, float]] = {m: ("", 0.0) for m in MODES}
    signals: dict[str, list[dict]] = {m: [] for m in MODES}

    # Layer 1 features computed inline since parquet was generated pre-Wave 1
    day_high: float | None = None
    day_low: float | None = None

    skipped = 0
    processed = 0

    for i in range(n_rows):
        row = {c: col_data[c][i] for c in col_data}

        ts = row.get("timestamp")
        if ts is None or not _in_session(ts, instrument):
            skipped += 1
            continue
        if row.get("trading_state") != "TRADING":
            skipped += 1
            continue
        if row.get("data_quality_flag") == 0:
            skipped += 1
            continue

        vec = preprocess_live_tick(row, models.feature_config)
        if vec is None:
            skipped += 1
            continue
        X = vec.reshape(1, -1)

        preds = _gather_preds(models, X)
        # Live session-rank, not a model prediction
        try:
            preds["upside_percentile_30s"] = float(row.get("upside_percentile_30s") or float("nan"))
        except (TypeError, ValueError):
            preds["upside_percentile_30s"] = float("nan")

        ce_ltp = row.get("opt_0_ce_ltp")
        pe_ltp = row.get("opt_0_pe_ltp")

        # Track session OHLC for Wave 1 S/R features (parquet pre-dates Wave 1)
        spot = row.get("spot_price")
        if spot is not None and spot > 0:
            day_high = spot if day_high is None else max(day_high, spot)
            day_low = spot if day_low is None else min(day_low, spot)

        d_high_pct = ((spot - day_high) / day_high * 100.0) if (spot and day_high and day_high > 0) else None
        d_low_pct = ((spot - day_low) / day_low * 100.0) if (spot and day_low and day_low > 0) else None

        # Wave 1 deterministic gate input (read deterministic features from row)
        regime_v = row.get("regime")
        mom_persist = row.get("momentum_persistence_ticks")

        wave1_raw = decide_action_v2(
            preds, thresholds, v2_thresholds,
            ce_ltp=ce_ltp, pe_ltp=pe_ltp,
            regime=regime_v if isinstance(regime_v, str) else None,
            momentum_persistence_ticks=mom_persist,
            distance_to_day_high_pct=d_high_pct,
            distance_to_day_low_pct=d_low_pct,
        )
        # Apply sustained-tick filter on the wave1 decision
        confirmed_action = wave1_sustain.observe(wave1_raw.action)
        if confirmed_action != "WAIT" and wave1_raw.gate_passed:
            wave1_sig = wave1_raw
        else:
            wave1_sig = SignalAction(
                action="WAIT", direction=wave1_raw.direction,
                entry=0.0, tp=0.0, sl=0.0, rr=0.0,
                gate_passed=False,
                gate_reasons=wave1_raw.gate_reasons + (["C7_not_sustained"] if confirmed_action == "WAIT" and wave1_raw.gate_passed else []),
            )

        # Evaluate each mode
        results = {
            "current":                 _gate_current(preds, thresholds, ce_ltp, pe_ltp),
            "multi_horizon":           _gate_multi_horizon(preds, thresholds, ce_ltp, pe_ltp),
            "multi_horizon_sustained": _gate_multi_horizon_sustained(
                preds, thresholds, ce_ltp, pe_ltp, sustained_history,
            ),
            "wave1_deterministic":     wave1_sig,
        }

        for mode, sig in results.items():
            if sig.action == "WAIT" or not sig.gate_passed:
                continue
            # Same cooldown as production
            last_act, last_ts = last_emit[mode]
            if sig.action == last_act and (ts - last_ts) < COOLDOWN_SEC:
                continue
            last_emit[mode] = (sig.action, ts)
            signals[mode].append({
                "timestamp": ts,
                "action": sig.action,
                "entry": sig.entry,
                "tp": sig.tp,
                "sl": sig.sl,
                "rr": sig.rr,
                # Realized values (from parquet target columns — pre-computed truth)
                "realized_direction_30s":    row.get("direction_30s"),
                "realized_direction_60s":    row.get("direction_60s"),
                "realized_direction_300s":   row.get("direction_300s"),
                "realized_direction_900s":   row.get("direction_900s"),
                "realized_max_upside_60s":   row.get("max_upside_60s"),
                "realized_max_drawdown_60s": row.get("max_drawdown_60s"),
                "realized_max_upside_300s":  row.get("max_upside_300s"),
                "realized_max_drawdown_300s": row.get("max_drawdown_300s"),
                "realized_max_upside_900s":  row.get("max_upside_900s"),
                "realized_max_drawdown_900s": row.get("max_drawdown_900s"),
            })

        processed += 1

    print(f"    processed={processed:,} skipped={skipped:,}")
    for mode in MODES:
        print(f"    {mode:<28}: {len(signals[mode]):>4} signals")
    return signals


# ── Metrics ────────────────────────────────────────────────────────────────

def _direction_held(sig: dict, horizon: str) -> bool | None:
    """For LONG_CE: realized_direction_X == 1 means underlying went up = CE wins.
    For LONG_PE: invert (underlying went down = PE wins)."""
    realized = sig.get(f"realized_direction_{horizon}")
    if realized is None or (isinstance(realized, float) and math.isnan(realized)):
        return None
    is_call = "CE" in sig["action"]
    return (realized == 1) if is_call else (realized == 0)


def _return_at(sig: dict, horizon: str) -> float | None:
    """Approximate option-leg return at +horizon (first-order).

    LONG_CE: max_upside on CE leg ≈ best-case PnL on the leg we're long.
    LONG_PE: max_drawdown on CE leg ≈ best-case PnL on PE (CE-down ↔ PE-up).
    """
    is_call = "CE" in sig["action"]
    val = sig.get(f"realized_max_upside_{horizon}") if is_call else sig.get(f"realized_max_drawdown_{horizon}")
    if val is None or (isinstance(val, float) and math.isnan(val)):
        return None
    entry = sig.get("entry") or 0
    if entry <= 0:
        return None
    return (float(val) / entry) * 100.0  # %


def _hit(sig: dict, target: float, side: str) -> bool | None:
    """Did the option leg hit `target` price within the lookahead window?
    side="up" → check max_upside reached. side="down" → check max_drawdown reached.
    Uses 900s window (matches `neither_rate_900s` semantics)."""
    if "CE" in sig["action"]:
        up = sig.get("realized_max_upside_900s")
        dn = sig.get("realized_max_drawdown_900s")
    else:
        up = sig.get("realized_max_drawdown_900s")  # PE leg upside ≈ CE drawdown
        dn = sig.get("realized_max_upside_900s")    # PE leg downside ≈ CE upside
    entry = sig.get("entry") or 0
    if entry <= 0 or up is None or dn is None:
        return None
    if side == "up":
        return float(up) >= max(0.0, target - entry)
    if side == "down":
        return float(dn) >= max(0.0, entry - target)
    return None


def compute_metrics(signals: list[dict], session_end_ts: float) -> dict:
    n = len(signals)
    if n == 0:
        return {"count": 0}

    # Lifetime: time until next opposite-direction signal (or session end)
    lifetimes: list[float] = []
    sigs_sorted = sorted(signals, key=lambda s: s["timestamp"])
    for i, s in enumerate(sigs_sorted):
        end = session_end_ts
        for j in range(i + 1, len(sigs_sorted)):
            if sigs_sorted[j]["action"] != s["action"]:
                end = sigs_sorted[j]["timestamp"]
                break
        lifetimes.append(end - s["timestamp"])

    holds_60 = [_direction_held(s, "60s") for s in signals]
    holds_60 = [h for h in holds_60 if h is not None]
    holds_300 = [_direction_held(s, "300s") for s in signals]
    holds_300 = [h for h in holds_300 if h is not None]

    ret_60 = [_return_at(s, "60s") for s in signals]
    ret_60 = [r for r in ret_60 if r is not None]
    ret_300 = [_return_at(s, "300s") for s in signals]
    ret_300 = [r for r in ret_300 if r is not None]

    # Neither-rate at 900s: hit neither TP nor SL within the longest target window
    neither = []
    for s in signals:
        tp_hit = _hit(s, s.get("tp", 0.0), "up")
        sl_hit = _hit(s, s.get("sl", 0.0), "down")
        if tp_hit is None or sl_hit is None:
            continue
        neither.append(not tp_hit and not sl_hit)

    return {
        "count": n,
        "lifetime_p50_sec": round(statistics.median(lifetimes), 1) if lifetimes else None,
        "lifetime_p90_sec": round(_percentile(lifetimes, 90), 1) if lifetimes else None,
        "direction_holds_60s_pct":  round(100 * sum(holds_60) / len(holds_60), 1) if holds_60 else None,
        "direction_holds_300s_pct": round(100 * sum(holds_300) / len(holds_300), 1) if holds_300 else None,
        "avg_return_at_60s_pct":  round(statistics.mean(ret_60), 2) if ret_60 else None,
        "avg_return_at_300s_pct": round(statistics.mean(ret_300), 2) if ret_300 else None,
        "neither_rate_900s_pct": round(100 * sum(neither) / len(neither), 1) if neither else None,
        "long_ce_count": sum(1 for s in signals if s["action"] == "LONG_CE"),
        "long_pe_count": sum(1 for s in signals if s["action"] == "LONG_PE"),
    }


def _percentile(xs: Iterable[float], p: float) -> float:
    xs = sorted(xs)
    if not xs:
        return float("nan")
    k = (len(xs) - 1) * (p / 100.0)
    f, c = math.floor(k), math.ceil(k)
    if f == c:
        return xs[int(k)]
    return xs[f] + (xs[c] - xs[f]) * (k - f)


# ── Report ────────────────────────────────────────────────────────────────

def write_report(all_metrics: dict, out_path: Path) -> None:
    """Write a markdown report comparing the 3 modes across all (day, instrument)."""
    lines: list[str] = []
    lines.append(f"# Phase 1A signal-persistence benchmark")
    lines.append(f"")
    lines.append(f"Generated: {datetime.now(_IST).isoformat()}")
    lines.append(f"")
    lines.append(f"## Configuration")
    lines.append(f"- Days: {', '.join(DEFAULT_DAYS)}")
    lines.append(f"- Instruments: {', '.join(DEFAULT_INSTRUMENTS)}")
    lines.append(f"- Modes: current → multi_horizon → multi_horizon_sustained (additive)")
    lines.append(f"- 900s prob threshold: {PROB_900_MIN}")
    lines.append(f"- Sustained-N: {SUSTAIN_N}")
    lines.append(f"")

    # Per-cell tables
    for day in DEFAULT_DAYS:
        lines.append(f"## {day}")
        lines.append(f"")
        for inst in DEFAULT_INSTRUMENTS:
            lines.append(f"### {inst}")
            lines.append(f"")
            lines.append("| Metric | " + " | ".join(MODES) + " |")
            lines.append("|---|" + "|".join(["---:"] * len(MODES)) + "|")
            cell = all_metrics.get((day, inst), {})
            metrics_keys = [
                "count",
                "long_ce_count",
                "long_pe_count",
                "lifetime_p50_sec",
                "lifetime_p90_sec",
                "direction_holds_60s_pct",
                "direction_holds_300s_pct",
                "avg_return_at_60s_pct",
                "avg_return_at_300s_pct",
                "neither_rate_900s_pct",
            ]
            for k in metrics_keys:
                row = [k]
                for mode in MODES:
                    v = cell.get(mode, {}).get(k)
                    row.append("—" if v is None else str(v))
                lines.append("| " + " | ".join(row) + " |")
            lines.append(f"")

    # Aggregate
    lines.append(f"## Aggregate (all days × instruments)")
    lines.append(f"")
    lines.append("| Metric | " + " | ".join(MODES) + " |")
    lines.append("|---|" + "|".join(["---:"] * len(MODES)) + "|")
    aggregate_metrics = [
        "count",
        "lifetime_p50_sec",
        "direction_holds_60s_pct",
        "direction_holds_300s_pct",
        "avg_return_at_60s_pct",
        "avg_return_at_300s_pct",
        "neither_rate_900s_pct",
    ]
    for k in aggregate_metrics:
        row = [k]
        for mode in MODES:
            vals = [c.get(mode, {}).get(k) for c in all_metrics.values()]
            vals = [v for v in vals if v is not None]
            if not vals:
                row.append("—")
            elif k == "count":
                row.append(str(sum(vals)))
            else:
                row.append(f"{statistics.mean(vals):.1f}")
        lines.append("| " + " | ".join(row) + " |")
    lines.append(f"")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n[OK] Report written to {out_path}")


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", nargs="+", default=DEFAULT_DAYS)
    ap.add_argument("--instruments", nargs="+", default=DEFAULT_INSTRUMENTS)
    ap.add_argument("--features-root", default="data/features")
    ap.add_argument("--out", default=None,
                    help="Report output path (default: docs/benchmarks/<today>_phase1a.md)")
    args = ap.parse_args()

    features_root = Path(args.features_root)
    today = datetime.now(_IST).strftime("%Y-%m-%d")
    out_path = Path(args.out) if args.out else Path(f"docs/benchmarks/{today}_phase1a.md")

    all_metrics: dict[tuple[str, str], dict[str, dict]] = {}
    started = time.time()

    for day in args.days:
        for inst in args.instruments:
            print(f"\n=== {inst} / {day} ===")
            signals_by_mode = run_one_day_instrument(inst, day, features_root)

            # Session end timestamp = max timestamp seen in any mode (or session_hours boundary)
            all_ts = [s["timestamp"] for sigs in signals_by_mode.values() for s in sigs]
            session_end = max(all_ts) if all_ts else 0.0

            cell_metrics = {
                mode: compute_metrics(sigs, session_end)
                for mode, sigs in signals_by_mode.items()
            }
            all_metrics[(day, inst)] = cell_metrics

    elapsed = time.time() - started
    print(f"\nTotal runtime: {elapsed:.1f}s")

    # Write raw signals + report
    raw_dir = Path(f"data/benchmarks/{today}")
    raw_dir.mkdir(parents=True, exist_ok=True)
    raw_path = raw_dir / "metrics_raw.json"
    raw_path.write_text(
        json.dumps({f"{d}|{i}": m for (d, i), m in all_metrics.items()}, indent=2),
        encoding="utf-8",
    )
    print(f"[OK] Raw metrics → {raw_path}")
    write_report(all_metrics, out_path)


if __name__ == "__main__":
    main()
