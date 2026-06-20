"""
date_hygiene.py — Validator pre-flight for training (Phase 4, 2026-06-20).

Reads the per-date validation JSON the TFA replay validator produces at
``data/validation/{date}/{instrument}_validation.json`` and classifies
each requested training date as PASS / WARN / FAIL / MISSING. The CLI
uses this to auto-drop FAIL dates before they ever reach the trainer,
saving the operator from remembering which dates have known issues.

Validator verdict semantics (mirrors replay's view):
  PASS    -- all checks clean; safe for training.
  WARN    -- usable but flagged (e.g. ``regime: always NEUTRAL`` on a
             low-volatility day; other 600+ features still good).
  FAIL    -- structural issue (null floods, anachronistic data, timestamp
             out-of-order); drop unless operator explicitly overrides.
  MISSING -- no validation JSON on disk -- usually means the date was
             never replayed. Default: include (validator absence is not
             evidence of badness); operator can flip the policy via
             ``--missing-policy=drop`` if they want to be strict.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class DateClassification:
    """Sorted PASS / WARN / FAIL / MISSING lists for a date set."""

    pass_dates: list[str] = field(default_factory=list)
    warn_dates: list[str] = field(default_factory=list)
    fail_dates: list[str] = field(default_factory=list)
    missing_dates: list[str] = field(default_factory=list)
    # Verdict-specific reasons for the operator-facing banner.
    # Keyed by date; value is the first non-PASS check string.
    reasons: dict[str, str] = field(default_factory=dict)


def _read_verdict(path: Path) -> tuple[str | None, str | None]:
    """Return ``(verdict, first_non_pass_reason)`` or ``(None, None)``.

    ``verdict`` is uppercased PASS / WARN / FAIL. ``reason`` is the first
    failing check's display string, truncated to ~80 chars. None on
    parse failure or missing file.
    """
    if not path.exists():
        return None, None
    try:
        v = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None, None
    verdict = str(v.get("verdict", "")).upper() or None
    reason: str | None = None
    for _layer_name, layer in (v.get("layers") or {}).items():
        for ck_name, status in (layer.get("checks") or {}).items():
            status_str = str(status)
            if not status_str.startswith("PASS"):
                reason = f"{ck_name}: {status_str}"
                if len(reason) > 80:
                    reason = reason[:77] + "..."
                break
        if reason:
            break
    return verdict, reason


def classify_dates(
    dates: list[str],
    instrument: str,
    validation_root: Path,
) -> DateClassification:
    """Classify each date by reading ``{validation_root}/{date}/{instrument}_validation.json``.

    Dates with no validation JSON go into ``missing_dates`` -- the caller
    decides whether to keep or drop them.
    """
    result = DateClassification()
    for d in dates:
        path = validation_root / d / f"{instrument}_validation.json"
        verdict, reason = _read_verdict(path)
        if verdict == "PASS":
            result.pass_dates.append(d)
        elif verdict == "WARN":
            result.warn_dates.append(d)
            if reason:
                result.reasons[d] = reason
        elif verdict == "FAIL":
            result.fail_dates.append(d)
            if reason:
                result.reasons[d] = reason
        else:
            result.missing_dates.append(d)
    return result


def filter_for_training(
    dates: list[str],
    instrument: str,
    validation_root: Path,
    *,
    include_warns: bool = True,
    include_fails: bool = False,
    missing_policy: str = "include",  # "include" | "drop"
) -> tuple[list[str], DateClassification]:
    """Return ``(kept_dates, classification)`` after applying the policy.

    Defaults (recommended):
      include_warns = True   -- WARN dates retained (most are usable).
      include_fails = False  -- FAIL dates auto-dropped.
      missing_policy = "include" -- validator absence is not evidence
                                    of badness.
    """
    cls = classify_dates(dates, instrument, validation_root)
    kept: list[str] = list(cls.pass_dates)
    if include_warns:
        kept.extend(cls.warn_dates)
    if include_fails:
        kept.extend(cls.fail_dates)
    if missing_policy == "include":
        kept.extend(cls.missing_dates)
    kept.sort()
    return kept, cls


def format_summary_lines(
    cls: DateClassification,
    kept: list[str],
    *,
    include_warns: bool,
    include_fails: bool,
    missing_policy: str,
) -> list[str]:
    """Format banner lines for the CLI to print under MTA header.

    Each line is plain ASCII so it renders cleanly in any cmd window.
    """
    lines: list[str] = []
    counts = (
        f"PASS {len(cls.pass_dates)}  WARN {len(cls.warn_dates)}  "
        f"FAIL {len(cls.fail_dates)}  MISSING {len(cls.missing_dates)}"
    )
    lines.append(f"   Date hygiene: {counts}")

    dropped_fails = [d for d in cls.fail_dates if d not in kept]
    if dropped_fails:
        lines.append(
            f"   Auto-dropped {len(dropped_fails)} FAIL date(s):"
        )
        for d in dropped_fails[:5]:
            r = cls.reasons.get(d, "(no reason)")
            lines.append(f"     - {d}  {r}")
        if len(dropped_fails) > 5:
            lines.append(f"     ... and {len(dropped_fails) - 5} more")

    kept_warns = [d for d in cls.warn_dates if d in kept]
    if kept_warns:
        lines.append(
            f"   Kept {len(kept_warns)} WARN date(s) (use --no-warns to drop):"
        )
        for d in kept_warns[:5]:
            r = cls.reasons.get(d, "(no reason)")
            lines.append(f"     - {d}  {r}")
        if len(kept_warns) > 5:
            lines.append(f"     ... and {len(kept_warns) - 5} more")

    dropped_missing = [d for d in cls.missing_dates if d not in kept]
    if dropped_missing and missing_policy == "drop":
        lines.append(
            f"   Dropped {len(dropped_missing)} MISSING date(s) "
            "(no validation JSON):"
        )
        for d in dropped_missing[:5]:
            lines.append(f"     - {d}")
        if len(dropped_missing) > 5:
            lines.append(f"     ... and {len(dropped_missing) - 5} more")

    if include_fails and cls.fail_dates:
        lines.append(
            f"   WARNING: --include-fails in effect; FAIL dates retained: "
            f"{len(cls.fail_dates)}"
        )

    return lines