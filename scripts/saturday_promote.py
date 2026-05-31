"""
scripts/saturday_promote.py — T42 Saturday promotion-gate runner.

Decides whether each instrument's newest training bundle (produced by
the 02:00 ``Lubas-Retrain-Saturday`` cron) should replace the current
``models/<inst>/LATEST`` pointer or hold for manual review. Auto-
promotes on PASS, fires a Telegram alert via yow-partha on FAIL/SKIP.

Usage::

    py scripts/saturday_promote.py                   # full run
    py scripts/saturday_promote.py --dry-run         # compute + log only
    py scripts/saturday_promote.py --no-promote      # always alert, never flip LATEST
    py scripts/saturday_promote.py --no-telegram     # local-only run
    py scripts/saturday_promote.py --instruments nifty50

Default behaviour (V2 §2.3.4 + Partha 2026-05-31):
  - baseline = current LATEST bundle's manifest sim_pnl_total_inr
  - promote iff candidate_total >= baseline_total × 1.20
                AND candidate_expectancy_inr >= ₹8
  - PASS  → update LATEST atomically; PASS row to stdout; NO Telegram
            (silence is success).
  - FAIL  → keep LATEST as-is; FAIL row to stdout; Telegram alert so
            operator can review next morning.
  - SKIP  → keep LATEST as-is; SKIP row to stdout; Telegram alert.

Exit code:
  0 — at least one PASS or all SKIPs (nothing to do)
  1 — one or more FAILs (operator review required)
  2 — fatal error (no instruments, no manifests, etc.)

Cron wiring: append this script as a downstream step of
``Lubas-Retrain-Saturday`` in ``startup/install-scheduled-tasks.ps1``,
or run it manually in dev with ``--dry-run`` to preview.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Force UTF-8 on stdio so the ₹ symbol + cohort tags don't crash on
# Windows' default cp1252. Matches benchmark_signal_persistence.py's
# convention.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent
_PY_MODULES = _REPO / "python_modules"
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

from _shared.promotion_gate import (  # noqa: E402
    DEFAULT_BASELINE_MULTIPLIER,
    DEFAULT_MIN_EXPECTANCY_INR,
    PromotionDecision,
    Verdict,
    decide_promotion,
    format_decision_for_telegram,
    load_manifest,
    newest_bundle,
    resolve_current_latest_bundle,
    update_latest_pointer,
)


def _notify_yow_partha(text: str) -> bool:
    """Best-effort Telegram push to yow-partha. Mirrors TFA's
    `tick_feature_agent.main._notify_yow_partha` semantics — missing
    env vars → log to stderr + return False, never raise.
    """
    token = os.environ.get("YOW_PARTHA_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("YOW_PARTHA_CHAT_ID", "").strip()
    if not token or not chat_id:
        print(
            "[saturday_promote] YOW_PARTHA_BOT_TOKEN or YOW_PARTHA_CHAT_ID "
            "missing — Telegram notify skipped",
            file=sys.stderr,
        )
        return False
    try:
        import urllib.parse
        import urllib.request
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        data = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode()
        with urllib.request.urlopen(url, data=data, timeout=5) as resp:
            return resp.status == 200
    except Exception as exc:  # noqa: BLE001
        print(f"[saturday_promote] Telegram push failed: {exc}", file=sys.stderr)
        return False


def discover_instruments(models_root: Path) -> list[str]:
    """Every subdir of ``models/`` that has at least one dated bundle."""
    if not models_root.is_dir():
        return []
    found: list[str] = []
    for child in sorted(models_root.iterdir()):
        if child.is_dir() and newest_bundle(child) is not None:
            found.append(child.name)
    return found


def process_one_instrument(
    *,
    instrument: str,
    instrument_dir: Path,
    multiplier: float,
    min_expectancy_inr: float,
    no_promote: bool,
    no_telegram: bool,
    dry_run: bool,
) -> PromotionDecision:
    """Score + (maybe) promote one instrument's newest bundle."""
    candidate_dir = newest_bundle(instrument_dir)
    if candidate_dir is None:
        return PromotionDecision(
            verdict=Verdict.SKIP,
            reason="no dated bundles found",
            instrument=instrument,
            candidate_timestamp="<none>",
            baseline_timestamp=None,
        )
    candidate_manifest = load_manifest(candidate_dir)
    if candidate_manifest is None:
        return PromotionDecision(
            verdict=Verdict.SKIP,
            reason=f"candidate {candidate_dir.name} has no readable training_manifest.json",
            instrument=instrument,
            candidate_timestamp=candidate_dir.name,
            baseline_timestamp=None,
        )

    baseline_dir = resolve_current_latest_bundle(instrument_dir)
    baseline_manifest = load_manifest(baseline_dir) if baseline_dir else None

    decision = decide_promotion(
        candidate_manifest=candidate_manifest,
        baseline_manifest=baseline_manifest,
        multiplier=multiplier,
        min_expectancy_inr=min_expectancy_inr,
    )

    if decision.verdict is Verdict.PASS and not no_promote and not dry_run:
        update_latest_pointer(instrument_dir, decision.candidate_timestamp)
        print(
            f"[saturday_promote] {instrument}: PROMOTED "
            f"LATEST → {decision.candidate_timestamp}",
            file=sys.stderr,
        )
    elif decision.verdict is Verdict.PASS and (no_promote or dry_run):
        print(
            f"[saturday_promote] {instrument}: would PROMOTE "
            f"LATEST → {decision.candidate_timestamp} "
            f"({'--dry-run' if dry_run else '--no-promote'})",
            file=sys.stderr,
        )

    # Telegram fires on FAIL + SKIP (operator wants to know) and on
    # PASS only when --no-promote (so the operator is reminded to
    # flip LATEST manually). Silent on plain PASS.
    if not no_telegram:
        wants_alert = (
            decision.verdict is not Verdict.PASS
            or (decision.verdict is Verdict.PASS and no_promote)
        )
        if wants_alert:
            _notify_yow_partha(format_decision_for_telegram(decision))

    return decision


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--instruments", type=str, default=None,
        help="Comma-separated instruments. Default: auto-discover.",
    )
    parser.add_argument(
        "--models-root", type=Path, default=_REPO / "models",
    )
    parser.add_argument(
        "--multiplier", type=float, default=DEFAULT_BASELINE_MULTIPLIER,
        help="Required ratio: candidate_total ≥ baseline_total × THIS "
             f"(default {DEFAULT_BASELINE_MULTIPLIER}).",
    )
    parser.add_argument(
        "--min-expectancy-inr", type=float,
        default=DEFAULT_MIN_EXPECTANCY_INR,
        help=f"Per-trade expectancy floor in ₹ (default {DEFAULT_MIN_EXPECTANCY_INR}).",
    )
    parser.add_argument(
        "--no-promote", action="store_true",
        help="Alert-only mode — never flip LATEST automatically.",
    )
    parser.add_argument(
        "--no-telegram", action="store_true",
        help="Skip Telegram pushes entirely (local-only run).",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Compute decisions + print them, but neither flip LATEST "
             "nor push to Telegram.",
    )
    args = parser.parse_args(argv)

    # --dry-run implies --no-telegram (we don't want to spam during testing).
    if args.dry_run:
        args.no_telegram = True

    if args.instruments:
        instruments = [s.strip() for s in args.instruments.split(",") if s.strip()]
    else:
        instruments = discover_instruments(args.models_root)
        if not instruments:
            print(
                f"ERROR no instruments with dated bundles found under "
                f"{args.models_root}",
                file=sys.stderr,
            )
            return 2

    print(
        f"[saturday_promote] scoring {len(instruments)} instruments "
        f"({', '.join(instruments)}) "
        f"multiplier={args.multiplier} "
        f"min_expectancy=₹{args.min_expectancy_inr:.2f} "
        f"{'DRY-RUN' if args.dry_run else 'LIVE'} "
        f"{'NO-PROMOTE' if args.no_promote else 'AUTO-PROMOTE'}",
        file=sys.stderr,
    )

    decisions: list[PromotionDecision] = []
    for instrument in instruments:
        inst_dir = args.models_root / instrument
        decisions.append(process_one_instrument(
            instrument=instrument,
            instrument_dir=inst_dir,
            multiplier=args.multiplier,
            min_expectancy_inr=args.min_expectancy_inr,
            no_promote=args.no_promote,
            no_telegram=args.no_telegram,
            dry_run=args.dry_run,
        ))

    # Operator-visible verdict table on stdout (parseable for the cron
    # log + readable for humans).
    print("instrument,verdict,candidate,baseline,reason")
    any_fail = False
    for d in decisions:
        if d.verdict is Verdict.FAIL:
            any_fail = True
        print(
            f"{d.instrument},{d.verdict.value},{d.candidate_timestamp},"
            f"{d.baseline_timestamp or '<none>'},"
            f"\"{d.reason.replace(chr(34), chr(39))}\""
        )

    return 1 if any_fail else 0


if __name__ == "__main__":
    sys.exit(main())
