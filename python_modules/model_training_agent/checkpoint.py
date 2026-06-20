"""
checkpoint.py — Per-fold + per-head checkpoint state for resumable training
(Phase 3, 2026-06-20).

When training gets interrupted (Esc, OOM-kill, power loss, cmd-window
close), the operator can re-launch with ``--resume`` and pick up where
the killed run left off instead of redoing the 60+ minute walk-forward
CV + the 5-10 minute final fit from scratch.

State written under the run's ``output_dir`` (the timestamped folder
under ``models/<instrument>/``):

  - ``partial_folds.json``      One JSON object per completed CV fold,
                                appended in order. Format::

                                  {
                                    "schema_fp": "<sha256 of feature list + targets>",
                                    "folds": [
                                      {"fold_index": 0, "metrics": {...},
                                       "train_dates": [...], "val_dates": [...]},
                                      ...
                                    ]
                                  }

                                Rewritten atomically (tmp + rename) after
                                each fold completes so a kill mid-write
                                leaves the prior state intact.

  - ``partial_metrics.jsonl``   One line per completed FINAL-FIT head.
                                Append-only. Format per line::

                                  {"target": "direction_30s",
                                   "objective": "binary",
                                   "metrics": {...}}

                                Append-only lets a kill mid-write at most
                                lose the in-progress head.

The schema fingerprint protects against resuming a run whose feature
config changed between launches — a silent feature-mismatch would
corrupt the model. Mismatched fingerprint → resume refuses.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


def compute_schema_fingerprint(
    features: list[str],
    targets: list[str],
) -> str:
    """Stable hash of the feature + target lists so a resumed run can
    detect schema drift before training a single head.

    Order-insensitive (sorted before hashing); short (12 hex chars) so
    it fits in logs and manifest entries cleanly.
    """
    blob = json.dumps(
        {"features": sorted(features), "targets": sorted(targets)},
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:12]


# ── Per-fold checkpoint (CV phase) ────────────────────────────────────


def read_partial_folds(output_dir: Path) -> tuple[str | None, list[dict]]:
    """Return ``(schema_fp, folds)`` or ``(None, [])`` if no checkpoint."""
    path = output_dir / "partial_folds.json"
    if not path.exists():
        return None, []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload.get("schema_fp"), list(payload.get("folds", []))
    except (json.JSONDecodeError, OSError):
        return None, []


def write_partial_folds(
    output_dir: Path,
    schema_fp: str,
    folds: list[dict],
) -> None:
    """Atomically write the partial-folds checkpoint.

    Tmp + rename so a kill mid-write leaves the prior state intact.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    tmp = output_dir / "partial_folds.json.tmp"
    final = output_dir / "partial_folds.json"
    tmp.write_text(
        json.dumps({"schema_fp": schema_fp, "folds": folds}, indent=2) + "\n",
        encoding="utf-8",
    )
    tmp.replace(final)


# ── Per-head checkpoint (final-fit phase) ─────────────────────────────


def read_partial_head_metrics(output_dir: Path) -> dict[str, dict]:
    """Return ``{target: metrics_dict}`` parsed from partial_metrics.jsonl.

    Returns empty dict if the file doesn't exist or is malformed.
    Skips malformed lines individually so a partial corruption can't
    block resume entirely.
    """
    path = output_dir / "partial_metrics.jsonl"
    if not path.exists():
        return {}
    out: dict[str, dict] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                t = rec.get("target")
                m = rec.get("metrics")
                if isinstance(t, str) and isinstance(m, dict):
                    out[t] = m
            except json.JSONDecodeError:
                continue
    except OSError:
        return {}
    return out


def append_partial_head_metrics(
    output_dir: Path,
    target: str,
    objective: str,
    metrics: dict,
) -> None:
    """Append one head's metrics to partial_metrics.jsonl.

    Append-only lets a kill mid-write at most lose the in-progress head.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "partial_metrics.jsonl"
    line = json.dumps(
        {"target": target, "objective": objective, "metrics": metrics}
    )
    with path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


# ── Resume directory detection ────────────────────────────────────────


def find_resumable_run_dir(
    instrument: str,
    models_root: Path,
) -> Path | None:
    """Return the most recent timestamped run dir for the instrument
    that has at least one partial-state file AND no
    ``training_manifest.json`` (which only appears on COMPLETED runs).

    Returns None when no such dir exists (no interrupted run to resume).
    """
    inst_dir = models_root / instrument
    if not inst_dir.exists():
        return None
    # Timestamped run dirs are named YYYYMMDD_HHMMSS — sort by name to
    # get chronological order.
    candidates = sorted(
        (p for p in inst_dir.iterdir() if p.is_dir() and not p.name.startswith("_")),
        reverse=True,  # newest first
    )
    for cand in candidates:
        if (cand / "training_manifest.json").exists():
            # Completed — don't touch
            continue
        has_partial = (
            (cand / "partial_folds.json").exists()
            or (cand / "partial_metrics.jsonl").exists()
        )
        if has_partial:
            return cand
    return None


def cleanup_partial_state(output_dir: Path) -> None:
    """Remove the partial-state sidecars after a successful run.

    Keeps the run dir clean once ``training_manifest.json`` lands. Safe
    to call on dirs where the files don't exist.
    """
    for name in ("partial_folds.json", "partial_metrics.jsonl"):
        try:
            (output_dir / name).unlink()
        except (FileNotFoundError, OSError):
            pass


__all__ = [
    "compute_schema_fingerprint",
    "read_partial_folds",
    "write_partial_folds",
    "read_partial_head_metrics",
    "append_partial_head_metrics",
    "find_resumable_run_dir",
    "cleanup_partial_state",
]
