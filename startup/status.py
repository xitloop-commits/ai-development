"""status.py -- one-screen ATS health snapshot.

Headless answer to "is ATS up right now?" without opening launcher_v2.py
or eyeballing 4 cmd windows. Reuses launcher_v2's process introspection
so this view and the interactive status table can't drift apart.

Usage:
    python startup\\status.py

Exit codes (useful for monitoring / hook scripts):
    0  - API server up AND >=1 live TFA recorder running
    1  - degraded or down
"""
from __future__ import annotations

import datetime
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Reuse launcher_v2's process introspection.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from launcher_v2 import _INSTRUMENTS, _read_server_port, running_processes  # noqa: E402

_LIFECYCLE_LOG = Path(__file__).resolve().parent.parent / "logs" / "ats-lifecycle.log"


def _server_up(port: int, timeout: float = 1.5) -> bool:
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/health", timeout=timeout) as r:
            return r.status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def _read_recent_events(n: int = 20) -> list[dict]:
    """Last n parsed events from the lifecycle log, oldest first."""
    if not _LIFECYCLE_LOG.exists():
        return []
    try:
        lines = _LIFECYCLE_LOG.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    events: list[dict] = []
    for line in lines[-n:]:
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def _ago(iso_ts: str) -> str:
    """Human-readable 'X ago' string for an ISO timestamp."""
    try:
        ts = datetime.datetime.fromisoformat(iso_ts)
    except (ValueError, TypeError):
        return "?"
    now = datetime.datetime.now(ts.tzinfo) if ts.tzinfo else datetime.datetime.now()
    secs = int((now - ts).total_seconds())
    if secs < 0:
        return "just now"
    if secs < 60:
        return f"{secs}s ago"
    if secs < 3600:
        return f"{secs // 60}m ago"
    if secs < 86400:
        return f"{secs // 3600}h {(secs % 3600) // 60}m ago"
    return f"{secs // 86400}d ago"


def main() -> int:
    port = _read_server_port()
    server_up = _server_up(port)

    procs = running_processes()
    by_inst: dict[str, list] = {inst: [] for inst in _INSTRUMENTS}
    for p in procs:
        if p.instrument in by_inst:
            by_inst[p.instrument].append(p)

    print(f"ATS status @ {Path.cwd()}")
    print(f"  API server  (port {port}):  {'UP' if server_up else 'DOWN'}")
    print()
    print(f"  {'instrument':<12}  {'kind':<8}  {'pid':>6}  {'rss_mb':>8}")
    print(f"  {'-' * 12}  {'-' * 8}  {'-' * 6}  {'-' * 8}")

    live_tfa = 0
    for inst in _INSTRUMENTS:
        rows = by_inst[inst]
        if not rows:
            print(f"  {inst:<12}  {'--':<8}  {'--':>6}  {'--':>8}")
            continue
        for r in rows:
            print(f"  {inst:<12}  {r.kind:<8}  {r.pid:>6}  {r.rss_mb:>8.1f}")
            if r.kind == "tfa":
                live_tfa += 1

    print()
    print(f"  Live TFA recorders: {live_tfa} / {len(_INSTRUMENTS)}")

    # Last lifecycle events (start / stop) -- turns the log file from "audit
    # later" into "is today's session healthy".
    events = _read_recent_events()
    last_start = next((e for e in reversed(events) if e.get("event") == "start"), None)
    last_stop  = next((e for e in reversed(events) if e.get("event") == "stop"),  None)
    print()
    if last_start:
        print(f"  Last start:  {last_start.get('ts','?')}  ({_ago(last_start.get('ts',''))})")
    if last_stop:
        print(f"  Last stop:   {last_stop.get('ts','?')}  ({_ago(last_stop.get('ts',''))})")
    if not events:
        print(f"  Lifecycle log: empty (no events recorded yet)")

    return 0 if (server_up and live_tfa >= 1) else 1


if __name__ == "__main__":
    sys.exit(main())
