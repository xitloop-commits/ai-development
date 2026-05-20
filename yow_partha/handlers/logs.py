"""Log-tail helpers — `👀 See logs` and `👀 See error`.

Lift pattern from tfa_bot/bot.py `_tail_log` (migration doc §10). Reads the
target's daily log file, optionally filters to WARN/ERROR, formats the last
N entries as plain text.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from .._runners.targets import TARGETS
from .._utils import now_ist

ROOT = Path(__file__).resolve().parent.parent.parent
LOGS = ROOT / "logs"

MAX_LINES = 20
MAX_TELEGRAM_CHARS = 3800  # 4096 cap with safety margin


def _log_file(tid: str) -> Optional[Path]:
    t = TARGETS[tid]
    key = t.get("log_key")
    if not key:
        # API and one-shots don't have a per-instrument log key. Best effort:
        # find the most-recent *.log under logs/ whose name contains the kind.
        candidates = sorted(LOGS.glob("*.log"), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
        for c in candidates:
            if t["kind"] in c.stem.lower():
                return c
        return None
    today = now_ist().strftime("%Y-%m-%d")
    candidate = LOGS / f"tfa_{key}_{today}.log"
    return candidate if candidate.exists() else None


def tail_for(tid: str, level_filter: Optional[list[str]] = None) -> str:
    t = TARGETS[tid]
    lf = _log_file(tid)
    if not lf:
        return f"No log file for {t['noun']} today."
    try:
        all_lines = lf.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as exc:
        return f"Error reading log: {exc}"

    if level_filter:
        filtered = []
        for line in all_lines:
            try:
                if json.loads(line).get("level") in level_filter:
                    filtered.append(line)
            except (ValueError, json.JSONDecodeError):
                continue
        all_lines = filtered

    tail = all_lines[-MAX_LINES:]
    if not tail:
        scope = "WARN/ERROR " if level_filter else ""
        return f"No {scope}log entries for {t['noun']} today."

    out_lines = [f"{t['noun']} — last {len(tail)} log lines:", ""]
    for line in tail:
        try:
            e = json.loads(line)
            ts = (e.get("ts", "")[:19]).replace("T", " ")
            level = (e.get("level", "") or "")[:4]
            alert = e.get("alert") or e.get("event", "")
            msg = e.get("msg") or ""
            out_lines.append(f"[{ts}] {level} {alert}: {msg}" if msg else f"[{ts}] {level} {alert}")
        except (ValueError, json.JSONDecodeError):
            out_lines.append(line)

    out = "\n".join(out_lines)
    if len(out) > MAX_TELEGRAM_CHARS:
        out = out[:MAX_TELEGRAM_CHARS] + "\n... (truncated)"
    return out
