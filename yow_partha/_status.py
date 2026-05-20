r"""Process liveness + progress reader.

Liveness signal hierarchy (cheapest first):
  1. psutil scan for a Python process whose cmdline matches the target's
     execution path (TFA = ``tick_feature_agent\main.py``, API =
     ``server_launcher.py``, etc.). Same pattern as ``startup\stop-all.ps1``.
  2. Falls back to log-mtime freshness (per-tick perf log within 60s, or
     main log within 5 min) — lift from tfa_bot migration doc §3.

For replay, also reads `data/raw/replay_checkpoint.json` to compute a
best-effort completed/total fraction. `planned_range` is parked (see
spec §11 #2) so the bot just shows the completed count if missing.

Train progress (parked, spec §11 #1): if `logs/train_progress_<INST>.json`
ever shows up, it's read here.
"""

from __future__ import annotations

import json
import logging
from datetime import timedelta
from pathlib import Path
from typing import Optional

import psutil

from ._runners.targets import TARGETS, Target
from ._utils import now_ist

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
LOGS_DIR = ROOT / "logs"
REPLAY_CHECKPOINT = ROOT / "data" / "raw" / "replay_checkpoint.json"


# Cmdline fragments that identify each kind's running process. Mirrors the
# stop-all.ps1 matcher.
_CMDLINE_FRAGMENTS = {
    "api": ["server_launcher.py"],
    "tfa": ["tick_feature_agent", "main.py"],
    "replay": ["tick_feature_agent", "main.py", "--mode", "replay"],
    "train": ["model_training_agent"],
}


def _matches(cmdline: list[str], frags: list[str], inst: Optional[str]) -> bool:
    joined = " ".join(cmdline).lower()
    if not all(f.lower() in joined for f in frags):
        return False
    if inst and inst.lower() not in joined:
        return False
    return True


def _scan_processes() -> list[psutil.Process]:
    out = []
    for p in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            if (p.info["name"] or "").lower() in ("python.exe", "python", "pythonw.exe"):
                out.append(p)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return out


def is_running(target: Target) -> bool:
    """True if a process matching this target is currently alive."""
    kind = target["kind"]
    inst = target.get("inst")
    frags = _CMDLINE_FRAGMENTS.get(kind)
    if not frags:
        return False  # backtest, compare, delete, shutdown are one-shot
    for p in _scan_processes():
        try:
            cl = p.info.get("cmdline") or []
            # For replay vs tfa: both use tick_feature_agent\main.py. Replay
            # has --mode replay in cmdline; live TFA does not. The replay
            # fragment list already includes "--mode replay" so the right
            # ordering is "check replay first" — but psutil iterates once,
            # so we test against the fragments for the requested kind only.
            if _matches(cl, frags, inst):
                # When matching kind="tfa", we must EXCLUDE replay processes
                # (they share the same script). Guard that here:
                if kind == "tfa" and "replay" in " ".join(cl).lower():
                    continue
                return True
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return False


def state_icon(target: Target) -> str:
    """Traffic-light: 🟢 running / ⚫ stopped / 🔴 crashed (last exit was non-zero)."""
    if is_running(target):
        return "🟢"
    # "crashed" requires looking at the most-recent lifecycle event for this
    # target in the NDJSON log. Cheap to skip on v0.1; default to stopped.
    return "⚫"


def replay_progress(inst: str) -> Optional[tuple[int, int]]:
    """Return (done, total) for replay progress, or (done, None-equivalent) if
    `planned_range` missing.

    Output convention: (done, total). total=0 means "unknown" — caller
    renders "N done" without `/Y`.
    """
    if not REPLAY_CHECKPOINT.exists():
        return None
    try:
        data = json.loads(REPLAY_CHECKPOINT.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        log.debug("replay checkpoint unreadable: %s", exc)
        return None
    per_inst = data.get(inst) or data.get(inst.upper()) or {}
    if isinstance(per_inst, dict):
        done = len([k for k in per_inst.keys() if k != "planned_range"])
        total = len(per_inst.get("planned_range") or []) if "planned_range" in per_inst else 0
        return (done, total)
    return None


def train_progress(inst: str) -> Optional[tuple[int, int, str]]:
    """Read logs/train_progress_<INST>.json if it exists. Returns
    (done, total, current_date) or None. Parked feature — most of the time
    this file won't exist and the row shows without a fraction.
    """
    candidates = [
        LOGS_DIR / f"train_progress_{inst}.json",
        LOGS_DIR / f"train_progress_{inst.upper()}.json",
    ]
    for path in candidates:
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                # 5-min staleness check — same threshold as the spec
                mtime = now_ist() - timedelta(seconds=(now_ist().timestamp() - path.stat().st_mtime))
                if (now_ist() - mtime).total_seconds() > 300:
                    return None
                return (int(data.get("done", 0)), int(data.get("total", 0)), str(data.get("current_date", "")))
            except (json.JSONDecodeError, OSError, ValueError):
                continue
    return None


def _extract_inst(cmdline_lower: str) -> str:
    """Best-effort instrument detection from a cmdline string."""
    for inst in ("nifty50", "banknifty", "crudeoil", "naturalgas"):
        if inst in cmdline_lower:
            return inst
    return "?"


def _extract_dates(cmdline: list[str]) -> list[str]:
    """Pull out --include-dates / --date / --date-from values."""
    dates: list[str] = []
    for i, tok in enumerate(cmdline):
        if tok in ("--include-dates", "--date", "--date-from", "--date-to") and i + 1 < len(cmdline):
            nxt = cmdline[i + 1]
            if len(nxt) == 10 and nxt[4] == '-' and nxt[7] == '-':
                dates.append(nxt)
    return dates


def list_running(kind: str) -> list[dict]:
    """Enumerate every running process of `kind` (replay | train) with
    enough metadata for a per-pid listing UI.

    Returns: [{pid, inst, dates: list[str], label: str}], one per process.
    `label` is a human-readable identifier suitable for an inline button
    (e.g. "Crude Oil replay · 2026-04-22").
    """
    if kind not in ("replay", "train"):
        return []
    out: list[dict] = []
    for p in _scan_processes():
        try:
            cl = p.info.get("cmdline") or []
            joined = " ".join(cl).lower()
            is_match = False
            if kind == "replay":
                is_match = ("tick_feature_agent" in joined and "main.py" in joined
                            and "--mode" in joined and "replay" in joined)
            elif kind == "train":
                is_match = "model_training_agent" in joined
            if not is_match:
                continue
            inst = _extract_inst(joined)
            dates = _extract_dates(cl)
            inst_noun = {
                "nifty50": "NIFTY 50",
                "banknifty": "Bank Nifty",
                "crudeoil": "Crude Oil",
                "naturalgas": "Natural Gas",
            }.get(inst, inst)
            kind_word = "replay" if kind == "replay" else "model training"
            if dates:
                label = f"{inst_noun} {kind_word} · {dates[0]}"
                if len(dates) > 1:
                    label += f" (+{len(dates)-1})"
            else:
                label = f"{inst_noun} {kind_word}"
            out.append({"pid": p.pid, "inst": inst, "dates": dates, "label": label})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return out


def list_all_managed_running() -> list[dict]:
    """Enumerate every running process the bot considers 'managed' (api +
    tfa + replay + train). Used by the smart shutdown gate so we don't
    silently nuke an in-flight replay or training run.

    Returns: [{pid, kind, inst, label}], one per process.
    """
    out: list[dict] = []
    # API (single process)
    for p in _scan_processes():
        try:
            cl = p.info.get("cmdline") or []
            if _matches(cl, _CMDLINE_FRAGMENTS["api"], None):
                out.append({"pid": p.pid, "kind": "api", "inst": None, "label": "API server"})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    # TFA recorders (one per instrument, can have multiple of same inst)
    for inst in ("nifty50", "banknifty", "crudeoil", "naturalgas"):
        for p in _scan_processes():
            try:
                cl = p.info.get("cmdline") or []
                joined = " ".join(cl).lower()
                if (_matches(cl, _CMDLINE_FRAGMENTS["tfa"], inst)
                        and "replay" not in joined):
                    inst_noun = {"nifty50": "NIFTY 50", "banknifty": "Bank Nifty",
                                 "crudeoil": "Crude Oil", "naturalgas": "Natural Gas"}[inst]
                    out.append({"pid": p.pid, "kind": "tfa", "inst": inst,
                                "label": f"{inst_noun} recorder"})
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    # Replay + train (each can have multiple instances)
    for kind in ("replay", "train"):
        out.extend(list_running(kind))
    return out


def status_for(tid: str) -> dict:
    """One row's worth of status for the home table."""
    t = TARGETS[tid]
    row = {
        "id": tid,
        "noun": t["noun"],
        "icon": state_icon(t),
        "running": is_running(t),
        "progress": "",
    }
    if row["running"]:
        if t["kind"] == "replay" and t.get("inst"):
            p = replay_progress(t["inst"])
            if p is not None:
                done, total = p
                row["progress"] = f"{done}/{total}" if total else f"{done} done"
        elif t["kind"] == "train" and t.get("inst"):
            p = train_progress(t["inst"])
            if p is not None:
                done, total, current = p
                row["progress"] = f"{done}/{total}" if total else f"{done} done"
    return row
