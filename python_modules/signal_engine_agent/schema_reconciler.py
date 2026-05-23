"""
schema_reconciler.py — Quarantine heads trained against stale feature schemas.

Per V2_MASTER_SPEC D66 (locked 2026-05-16, scope extended by I10 +
D72 2026-05-17): when the TFA emitter ships a new feature schema (e.g.
v8 → v9 because Phase 2e macro columns landed), any model head that was
trained against the OLD schema would be fed the wrong feature vector at
predict time — silent corruption. The reconciler reads each head's
recorded `schema_version` from `LATEST_HEADS.json` and compares against
the current emitter schema; mismatches are returned for the caller
(typically `model_loader`) to drop from the loaded model set.

DESIGN
------
- Conservative on uncertainty. A head with NO recorded schema_version
  (`0` per the trainer's no-registry fallback, or absent entirely) is
  treated as "version unknown — trust it" and is NOT quarantined.
  Rationale: false positives (quarantining a valid head) silently kill
  live signals; false negatives (using a slightly-stale head) at worst
  produce a NaN from a downstream feature lookup and the gate fails
  open. The conservative bias keeps the engine running.
- Quarantine only fires when the head HAS a recorded version AND it
  doesn't match the current emitter schema.
- LATEST_HEADS.json missing → no reconciliation runs; loader falls back
  to its existing "load all .lgbm files" behavior. Same conservative
  intent: never break the engine on metadata absence.

CALL SITE
---------
`signal_engine_agent.model_loader.load_models()` runs the reconciler
after loading .lgbm files + sidecars. Returned quarantine list is used
to delete from `LoadedModels.models` and `LoadedModels.calibrations`
so the engine's `_pred(models, X, name)` returns NaN for those heads
(same path as missing .lgbm).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


SUPPORTED_LATEST_HEADS_VERSIONS: frozenset[int] = frozenset({1})


@dataclass(frozen=True)
class QuarantineReport:
    """Outcome of a reconciliation pass."""

    quarantined: list[str]
    """Names of heads whose recorded schema_version mismatched the
    current emitter schema. Caller drops these from loaded models."""

    inspected: int
    """How many heads the reconciler actually examined (those with a
    non-zero recorded schema_version). Heads with version=0 or absent
    are NOT counted here — they were skipped, not validated."""

    current_schema_version: int | None
    """The schema_version of the highest-numbered `v<N>.json` in
    `config/schema_registry/`. None when no registry file exists; in
    that case the reconciler is a no-op."""


def _read_current_schema_version(
    schema_registry_dir: Path,
) -> int | None:
    """Read the highest-numbered `v<N>.json` schema_version available.

    Mirrors the trainer's `_read_current_schema_version` reader. Kept
    duplicated here (rather than imported from MTA) so the SEA side has
    no MTA build dependency at runtime — model_loader already imports
    one MTA helper (CalibrationMap reader) which is OK; tipping the
    balance further would invert the layered design.
    """
    if not schema_registry_dir.is_dir():
        return None
    candidates: list[tuple[int, Path]] = []
    for p in schema_registry_dir.glob("v*.json"):
        stem = p.stem
        if not stem.startswith("v") or not stem[1:].isdigit():
            continue
        candidates.append((int(stem[1:]), p))
    if not candidates:
        return None
    _, latest = max(candidates, key=lambda t: t[0])
    payload = json.loads(latest.read_text(encoding="utf-8"))
    sv = payload.get("schema_version")
    return sv if isinstance(sv, int) else None


def reconcile_loaded_heads(
    latest_heads_path: Path,
    schema_registry_dir: Path = Path("config/schema_registry"),
) -> QuarantineReport:
    """Compare each head's recorded schema_version against the current
    emitter schema and return the list of heads to quarantine.

    Args:
        latest_heads_path: path to `LATEST_HEADS.json` (typically
            `models/<instrument>/LATEST_HEADS.json`).
        schema_registry_dir: directory containing `v<N>.json` schema
            files. Defaults to repo-relative `config/schema_registry`.

    Returns:
        QuarantineReport. `quarantined` is empty when the file is
        absent, the version is unsupported, or no heads have a recorded
        schema_version > 0.

    Never raises on missing files — falls through to an empty quarantine
    so the loader keeps running.
    """
    current_sv = _read_current_schema_version(schema_registry_dir)
    if current_sv is None:
        # No registry yet → can't reconcile anything. No-op.
        return QuarantineReport(
            quarantined=[], inspected=0, current_schema_version=None,
        )

    if not latest_heads_path.exists():
        # Legacy training run that predates T27 → trust the loader's
        # existing .lgbm-presence logic.
        return QuarantineReport(
            quarantined=[], inspected=0, current_schema_version=current_sv,
        )

    payload = json.loads(latest_heads_path.read_text(encoding="utf-8"))
    file_version = payload.get("version")
    if file_version not in SUPPORTED_LATEST_HEADS_VERSIONS:
        # Newer or unknown shape — bail rather than guess.
        return QuarantineReport(
            quarantined=[], inspected=0, current_schema_version=current_sv,
        )

    heads = payload.get("heads") or {}
    if not isinstance(heads, dict):
        return QuarantineReport(
            quarantined=[], inspected=0, current_schema_version=current_sv,
        )

    quarantined: list[str] = []
    inspected = 0
    for name, meta in heads.items():
        if not isinstance(meta, dict):
            continue
        recorded_sv = meta.get("schema_version")
        if not isinstance(recorded_sv, int) or recorded_sv == 0:
            # "Version unknown" — trust the head. See module docstring.
            continue
        inspected += 1
        if recorded_sv != current_sv:
            quarantined.append(name)

    return QuarantineReport(
        quarantined=quarantined,
        inspected=inspected,
        current_schema_version=current_sv,
    )
