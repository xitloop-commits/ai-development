"""
backtest_compare.py — Compare two scored backtest runs side by side.

Usage:
    py backtest_compare.py nifty50 --date 2026-04-16
        (auto-finds the two most recent model versions)

    py backtest_compare.py nifty50 --date 2026-04-16 \\
        --run1 20260418_002808 --run2 20260420_xxxx
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def _load_scorecard(base: Path, instrument: str, model_version: str, date: str) -> dict | None:
    path = base / instrument / model_version / date / "scorecard.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _find_versions(base: Path, instrument: str) -> list[str]:
    """Find all model version dirs for an instrument, sorted chronologically."""
    inst_dir = base / instrument
    if not inst_dir.exists():
        return []
    return sorted(d.name for d in inst_dir.iterdir() if d.is_dir())


def _delta(v1, v2) -> str:
    """Format delta between two values."""
    if v1 is None or v2 is None:
        return ""
    d = v2 - v1
    sign = "+" if d >= 0 else ""
    return f"{sign}{d:.2f}"


def compare(
    instrument: str,
    date: str,
    run1: str | None = None,
    run2: str | None = None,
    backtests_root: Path = Path("data/backtests"),
) -> None:
    versions = _find_versions(backtests_root, instrument)

    if run1 and run2:
        v1, v2 = run1, run2
    elif len(versions) >= 2:
        v1, v2 = versions[-2], versions[-1]
    elif len(versions) == 1:
        print(f"\n  Only 1 backtest run found for {instrument}: {versions[0]}")
        print(f"  Need at least 2 runs to compare. Train a new model and backtest again.\n")
        return
    else:
        print(f"\n  No backtest runs found for {instrument} in {backtests_root}\n")
        return

    sc1 = _load_scorecard(backtests_root, instrument, v1, date)
    sc2 = _load_scorecard(backtests_root, instrument, v2, date)

    if not sc1:
        print(f"\n  Scorecard not found: {backtests_root / instrument / v1 / date}/scorecard.json")
        return
    if not sc2:
        print(f"\n  Scorecard not found: {backtests_root / instrument / v2 / date}/scorecard.json")
        return

    print()
    print(f"  ══════════════════════════════════════════════════════════════════��════════")
    print(f"    COMPARISON — {instrument} / {date}")
    print(f"  ═══════════════════════════════════════════════════════════════════════════")
    print()
    print(f"    {'Metric':<35} {'Model A':>12}  {'Model B':>12}  {'Delta':>10}")
    print(f"    {'Model version':<35} {v1:>12}  {v2:>12}")
    print(f"    {'─' * 35} {'─' * 12}  {'─' * 12}  {'─' * 10}")

    # Direction accuracy
    for w in ("30s", "60s"):
        k = f"direction_{w}_accuracy"
        a, b = sc1.get(k), sc2.get(k)
        d = _delta(a, b)
        a_str = f"{a:.1f}%" if a is not None else "—"
        b_str = f"{b:.1f}%" if b is not None else "—"
        improved = " ✓" if a and b and b > a else " ✗" if a and b and b < a else ""
        print(f"    {'Direction ' + w + ' acc':<35} {a_str:>12}  {b_str:>12}  {d:>10}{improved}")

    print()

    # Signal precision per action
    for action in ("LONG_CE", "LONG_PE", "SHORT_CE", "SHORT_PE"):
        a = sc1.get("signal_precision", {}).get(action)
        b = sc2.get("signal_precision", {}).get(action)
        n1 = sc1.get("signal_counts", {}).get(action, 0)
        n2 = sc2.get("signal_counts", {}).get(action, 0)
        d = _delta(a, b)
        a_str = f"{a:.1f}% ({n1})" if a is not None else f"— ({n1})"
        b_str = f"{b:.1f}% ({n2})" if b is not None else f"— ({n2})"
        improved = " ✓" if a and b and b > a else " ✗" if a and b and b < a else ""
        print(f"    {action + ' precision':<35} {a_str:>12}  {b_str:>12}  {d:>10}{improved}")

    a_overall = sc1.get("signal_precision_overall")
    b_overall = sc2.get("signal_precision_overall")
    d = _delta(a_overall, b_overall)
    a_str = f"{a_overall:.1f}%" if a_overall is not None else "—"
    b_str = f"{b_overall:.1f}%" if b_overall is not None else "—"
    improved = " ✓" if a_overall and b_overall and b_overall > a_overall else ""
    print(f"    {'Overall precision':<35} {a_str:>12}  {b_str:>12}  {d:>10}{improved}")

    print()

    # TP/SL hit rates
    for k, label in [("tp_hit_rate", "TP hit rate"), ("sl_hit_rate", "SL hit rate")]:
        a, b = sc1.get(k), sc2.get(k)
        d = _delta(a, b)
        a_str = f"{a:.1f}%" if a is not None else "—"
        b_str = f"{b:.1f}%" if b is not None else "—"
        good = (k == "tp_hit_rate" and b and a and b > a) or (k == "sl_hit_rate" and b and a and b < a)
        improved = " ✓" if good else ""
        print(f"    {label:<35} {a_str:>12}  {b_str:>12}  {d:>10}{improved}")

    print()

    # Signal count
    a_n = sc1.get("total_signals", 0)
    b_n = sc2.get("total_signals", 0)
    print(f"    {'Total signals':<35} {a_n:>12}  {b_n:>12}  {b_n - a_n:>+10}")

    print()

    # Regression MAE
    for target in ("up_30s", "up_60s", "dn_30s", "dn_60s"):
        k = f"mae_{target}"
        a, b = sc1.get(k), sc2.get(k)
        d = _delta(a, b) if a and b else ""
        a_str = f"{a:.4f}" if a is not None else "—"
        b_str = f"{b:.4f}" if b is not None else "—"
        improved = " ✓" if a and b and b < a else " ✗" if a and b and b > a else ""
        print(f"    {'MAE ' + target:<35} {a_str:>12}  {b_str:>12}  {d:>10}{improved}")

    for target in ("up_30s", "up_60s", "dn_30s", "dn_60s"):
        k = f"correlation_{target}"
        a, b = sc1.get(k), sc2.get(k)
        d = _delta(a, b) if a and b else ""
        a_str = f"{a:.3f}" if a is not None else "—"
        b_str = f"{b:.3f}" if b is not None else "—"
        improved = " ✓" if a and b and b > a else " ✗" if a and b and b < a else ""
        print(f"    {'Corr ' + target:<35} {a_str:>12}  {b_str:>12}  {d:>10}{improved}")

    print()
    print(f"    ✓ = improved    ✗ = regressed")
    print()
    print(f"  ═══════════════════════════════════════════════════════════════════════════")
    print()


def main() -> int:
    p = argparse.ArgumentParser(prog="backtest_compare")
    p.add_argument("instrument",
                   choices=("nifty50", "banknifty", "crudeoil", "naturalgas"))
    p.add_argument("--date", required=True, help="Backtest date YYYY-MM-DD")
    p.add_argument("--run1", default=None, help="Model version A (older)")
    p.add_argument("--run2", default=None, help="Model version B (newer)")
    p.add_argument("--backtests-root", default="data/backtests")
    args = p.parse_args()

    compare(
        instrument=args.instrument,
        date=args.date,
        run1=args.run1,
        run2=args.run2,
        backtests_root=Path(args.backtests_root),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
