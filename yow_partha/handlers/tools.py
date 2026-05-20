"""Tools submenu actions.

Mirrors the launcher's Tools menu (`launcher_v2.py` `act_tools`), but
limited to items that make sense from a phone:

  - Refresh Dhan token (TOTP) — fires `scripts/run-dhan-refresh.bat`.
  - Today's raw file sizes      — text reply with file sizes.

The launcher's "Credentials info" and "Replay checkpoint status" are
skipped — both produce dense desktop-style output that doesn't add value
on the phone.
"""

from __future__ import annotations

import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))
ROOT = Path(__file__).resolve().parent.parent.parent


def _human_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    if n < 1024 * 1024 * 1024:
        return f"{n / 1024 / 1024:.2f} MB"
    return f"{n / 1024 / 1024 / 1024:.2f} GB"


def _refresh_token() -> str:
    bat = ROOT / "scripts" / "run-dhan-refresh.bat"
    if not bat.exists():
        return "❌ scripts/run-dhan-refresh.bat not found"
    try:
        subprocess.Popen(["cmd", "/c", "start", "Lubas: Dhan refresh",
                          "cmd", "/k", str(bat)], cwd=str(ROOT))
        return "🔄 Dhan token refresh started in a new window."
    except OSError as exc:
        return f"❌ Failed: {exc}"


def _file_sizes() -> str:
    today = datetime.now(IST).strftime("%Y-%m-%d")
    day_dir = ROOT / "data" / "raw" / today
    if not day_dir.exists():
        return f"No raw data folder for {today} yet."
    lines = [f"Raw file sizes — {today}", ""]
    for f in sorted(day_dir.glob("*.ndjson.gz")):
        lines.append(f"{f.name:<45} {_human_bytes(f.stat().st_size):>10}")
    if len(lines) == 2:
        lines.append("(no files yet)")
    return "\n".join(lines)


def handle_tool(name: str) -> str:
    if name == "refresh_token":
        return _refresh_token()
    if name == "file_sizes":
        return _file_sizes()
    return f"Unknown tool: {name}"
