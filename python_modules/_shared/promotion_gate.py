"""
_shared/promotion_gate.py — T42 Saturday promotion-gate logic.

Pure functions consumed by ``scripts/saturday_promote.py``. Given a
candidate training bundle's manifest + the currently-live (LATEST)
manifest, decide whether to promote the candidate.

V2_MASTER_SPEC §2.3.4 rule:

    promote iff
        candidate.sim_pnl_total_inr >= baseline.sim_pnl_total_inr × multiplier
      AND
        candidate.sim_pnl_expectancy_inr >= min_expectancy_inr

Defaults: multiplier = 1.20 (must beat baseline by 20%),
min_expectancy = ₹8 per trade (per V2 spec "+8 pts" floor;
expectancy in the manifest is already in rupees so we keep the same
numeric value as a rupee floor for the MVP — operator can override
via CLI if they want a different ₹/pt convention).

Edge cases (all return ``SKIP`` with an actionable reason so the
operator's Telegram alert tells them exactly what to do):

  - **No baseline yet** (first-ever bundle): auto-PASS with a note,
    because there's no previous model to be worse than.
  - **Candidate already IS LATEST**: SKIP — nothing to do.
  - **Candidate missing sim_pnl block** (``sim_pnl_signals == 0`` or
    a skipped reason in the manifest): SKIP — can't grade.
  - **Candidate older than baseline**: SKIP — defensive; shouldn't
    happen normally.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

DEFAULT_BASELINE_MULTIPLIER: float = 1.20
DEFAULT_MIN_EXPECTANCY_INR: float = 8.0


class Verdict(Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    SKIP = "SKIP"


@dataclass
class PromotionDecision:
    verdict: Verdict
    reason: str
    instrument: str
    candidate_timestamp: str
    baseline_timestamp: str | None
    candidate_metrics: dict = field(default_factory=dict)
    baseline_metrics: dict = field(default_factory=dict)


def _sim_pnl_metrics(manifest: dict) -> dict:
    """Pull the six numbers the gate compares + reports."""
    return {
        "sim_pnl_total_inr": float(manifest.get("sim_pnl_total_inr", 0.0)),
        "sim_pnl_expectancy_inr": float(manifest.get("sim_pnl_expectancy_inr", 0.0)),
        "sim_pnl_max_drawdown_inr": float(manifest.get("sim_pnl_max_drawdown_inr", 0.0)),
        "sim_pnl_signals": int(manifest.get("sim_pnl_signals", 0)),
        "sim_pnl_wins": int(manifest.get("sim_pnl_wins", 0)),
        "sim_pnl_win_rate": float(manifest.get("sim_pnl_win_rate", 0.0)),
    }


def decide_promotion(
    *,
    candidate_manifest: dict,
    baseline_manifest: dict | None,
    multiplier: float = DEFAULT_BASELINE_MULTIPLIER,
    min_expectancy_inr: float = DEFAULT_MIN_EXPECTANCY_INR,
) -> PromotionDecision:
    """Pure decision function. No I/O, no side effects.

    Args:
        candidate_manifest: parsed ``training_manifest.json`` from the
            newest dated bundle under ``models/<inst>/``.
        baseline_manifest: parsed manifest from the bundle that LATEST
            currently points at, or ``None`` if there isn't one yet.
        multiplier: how much candidate must beat baseline (1.20 = 20%).
        min_expectancy_inr: candidate's per-trade expectancy must
            clear this floor regardless of the multiplier check.
    """
    instrument = str(candidate_manifest.get("instrument", "<unknown>"))
    candidate_ts = str(candidate_manifest.get("timestamp", "<unknown>"))
    baseline_ts = (
        str(baseline_manifest.get("timestamp", "<unknown>"))
        if baseline_manifest else None
    )
    candidate_metrics = _sim_pnl_metrics(candidate_manifest)
    baseline_metrics = _sim_pnl_metrics(baseline_manifest) if baseline_manifest else {}

    common_payload = dict(
        instrument=instrument,
        candidate_timestamp=candidate_ts,
        baseline_timestamp=baseline_ts,
        candidate_metrics=candidate_metrics,
        baseline_metrics=baseline_metrics,
    )

    # Candidate already promoted — happens if the cron fired twice or
    # the operator ran the script after manually flipping LATEST.
    if baseline_ts is not None and baseline_ts == candidate_ts:
        return PromotionDecision(
            verdict=Verdict.SKIP,
            reason=f"candidate bundle ({candidate_ts}) is already LATEST",
            **common_payload,
        )

    # Defensive: candidate older than baseline.
    if baseline_ts is not None and candidate_ts < baseline_ts:
        return PromotionDecision(
            verdict=Verdict.SKIP,
            reason=(
                f"candidate timestamp {candidate_ts} is older than "
                f"current LATEST {baseline_ts} — not promoting backwards"
            ),
            **common_payload,
        )

    # Sim-PnL graceful-skip path: trainer was unable to score.
    if candidate_manifest.get("sim_pnl_skipped"):
        skip_reason = candidate_manifest.get(
            "sim_pnl_skipped_reason", "manifest carries sim_pnl_skipped=True",
        )
        return PromotionDecision(
            verdict=Verdict.SKIP,
            reason=f"sim_pnl harness skipped: {skip_reason}",
            **common_payload,
        )

    # No signals fired during sim_pnl — can't grade.
    if candidate_metrics["sim_pnl_signals"] == 0:
        return PromotionDecision(
            verdict=Verdict.SKIP,
            reason="sim_pnl produced 0 signals on the val set — cannot grade",
            **common_payload,
        )

    # No prior baseline (first-ever bundle).
    if baseline_manifest is None:
        if candidate_metrics["sim_pnl_expectancy_inr"] < min_expectancy_inr:
            return PromotionDecision(
                verdict=Verdict.FAIL,
                reason=(
                    f"first bundle but expectancy "
                    f"₹{candidate_metrics['sim_pnl_expectancy_inr']:.2f} "
                    f"< ₹{min_expectancy_inr:.2f} floor"
                ),
                **common_payload,
            )
        return PromotionDecision(
            verdict=Verdict.PASS,
            reason="first-ever bundle (no baseline to compare); meets expectancy floor",
            **common_payload,
        )

    # Standard two-check gate.
    cand_total = candidate_metrics["sim_pnl_total_inr"]
    base_total = baseline_metrics["sim_pnl_total_inr"]
    required_total = base_total * multiplier
    cand_expectancy = candidate_metrics["sim_pnl_expectancy_inr"]

    if cand_expectancy < min_expectancy_inr:
        return PromotionDecision(
            verdict=Verdict.FAIL,
            reason=(
                f"per-trade expectancy ₹{cand_expectancy:.2f} "
                f"< ₹{min_expectancy_inr:.2f} floor"
            ),
            **common_payload,
        )

    # Baseline of 0 (or negative) — multiplier comparison degenerates.
    # Treat any positive candidate as PASS provided the expectancy
    # floor is already cleared above.
    if base_total <= 0:
        return PromotionDecision(
            verdict=Verdict.PASS,
            reason=(
                f"baseline sim_pnl_total ₹{base_total:.0f} ≤ 0; "
                f"candidate ₹{cand_total:.0f} accepted on expectancy floor"
            ),
            **common_payload,
        )

    if cand_total < required_total:
        deficit = required_total - cand_total
        return PromotionDecision(
            verdict=Verdict.FAIL,
            reason=(
                f"sim_pnl_total ₹{cand_total:.0f} < required "
                f"₹{required_total:.0f} (baseline ₹{base_total:.0f} × "
                f"{multiplier:.2f}) — short ₹{deficit:.0f}"
            ),
            **common_payload,
        )

    return PromotionDecision(
        verdict=Verdict.PASS,
        reason=(
            f"sim_pnl_total ₹{cand_total:.0f} ≥ ₹{required_total:.0f} "
            f"(baseline ₹{base_total:.0f} × {multiplier:.2f}); "
            f"expectancy ₹{cand_expectancy:.2f} ≥ ₹{min_expectancy_inr:.2f}"
        ),
        **common_payload,
    )


# --- bundle discovery + manifest I/O ----------------------------------------

def list_dated_bundles(instrument_dir: Path) -> list[Path]:
    """Return all ``YYYYMMDD_HHMMSS`` subdirs under ``instrument_dir``,
    sorted oldest → newest.
    """
    if not instrument_dir.is_dir():
        return []
    out: list[Path] = []
    for child in instrument_dir.iterdir():
        if not child.is_dir():
            continue
        # MTA's timestamp shape: 8 digits + underscore + 6 digits.
        name = child.name
        if (
            len(name) == 15
            and name[:8].isdigit()
            and name[8] == "_"
            and name[9:].isdigit()
        ):
            out.append(child)
    return sorted(out)


def newest_bundle(instrument_dir: Path) -> Path | None:
    """The most recent dated bundle, or ``None`` if there are none."""
    bundles = list_dated_bundles(instrument_dir)
    return bundles[-1] if bundles else None


def load_manifest(bundle_dir: Path) -> dict | None:
    """Read ``training_manifest.json`` from a dated bundle, or ``None``
    if the manifest is missing / unreadable. Callers treat None as
    "no scoring data available" and SKIP.
    """
    path = bundle_dir / "training_manifest.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def resolve_current_latest_bundle(instrument_dir: Path) -> Path | None:
    """Resolve ``<instrument_dir>/LATEST`` to its dated bundle dir.

    Handles the three on-disk layouts (text-file pointer, symlink,
    fallback to manifest timestamp) consistently with
    ``feature_importance.resolve_latest_model_dir``. Returns ``None``
    if LATEST is absent OR points at a non-existent timestamp (first
    ever run before promotion).
    """
    candidate = instrument_dir / "LATEST"
    if candidate.is_file():
        timestamp = candidate.read_text(encoding="utf-8").strip()
        dated = instrument_dir / timestamp
        return dated if dated.is_dir() else None
    if candidate.is_dir():
        return candidate.resolve()
    return None


def update_latest_pointer(instrument_dir: Path, timestamp: str) -> Path:
    """Atomically write ``<instrument_dir>/LATEST`` with ``timestamp``.

    Uses a `.tmp` + os.replace so an interrupted write can't leave a
    half-written LATEST file pointing at a garbage timestamp.
    """
    target = instrument_dir / "LATEST"
    tmp = instrument_dir / "LATEST.tmp"
    tmp.write_text(timestamp, encoding="utf-8")
    # On Windows, os.replace overwrites atomically. shutil.move is a
    # thin wrapper that calls os.replace when src+dst are on the same
    # filesystem (which they always are here).
    shutil.move(str(tmp), str(target))
    return target


# --- reporting --------------------------------------------------------------

def format_decision_for_telegram(d: PromotionDecision) -> str:
    """Compact multi-line summary suitable for a Telegram push."""
    icon = {"PASS": "✅", "FAIL": "❌", "SKIP": "⏭"}[d.verdict.value]
    lines = [
        f"{icon} {d.verdict.value} [{d.instrument}] "
        f"candidate {d.candidate_timestamp}",
    ]
    if d.baseline_timestamp:
        lines.append(f"baseline {d.baseline_timestamp}")
    lines.append(d.reason)
    if d.candidate_metrics:
        c = d.candidate_metrics
        lines.append(
            f"cand: total ₹{c['sim_pnl_total_inr']:.0f} · "
            f"exp ₹{c['sim_pnl_expectancy_inr']:.2f} · "
            f"signals {c['sim_pnl_signals']} · "
            f"win-rate {c['sim_pnl_win_rate']:.1%}"
        )
    if d.baseline_metrics:
        b = d.baseline_metrics
        lines.append(
            f"base: total ₹{b['sim_pnl_total_inr']:.0f} · "
            f"exp ₹{b['sim_pnl_expectancy_inr']:.2f} · "
            f"signals {b['sim_pnl_signals']}"
        )
    return "\n".join(lines)
