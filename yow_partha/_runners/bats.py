"""Shell-out wrappers — every bot action ends up here.

The bot **never** reimplements what `startup/start-*.bat` already does. We
spawn the bat in a new console window (matching what the desktop launcher
does) so logs and Ctrl+C remain independent per process.

Stop is more involved on Windows: cmd.exe doesn't propagate a parent kill
to the Python child cleanly, so we use the existing `_send-ctrlc-helper.ps1`
helper that `stop-all.ps1` already relies on.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path

import psutil

from .._status import _CMDLINE_FRAGMENTS, _matches, _scan_processes
from .targets import TARGETS

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent.parent
STARTUP = ROOT / "startup"
HELPER = STARTUP / "_send-ctrlc-helper.ps1"


def _bat_path(name: str) -> Path:
    return STARTUP / name


def start_target(tid: str) -> str:
    """Spawn the target's bat in a new console window. Returns a short
    human-readable status string for the bot to reply with."""
    t = TARGETS[tid]
    bat = t.get("bat")
    if not bat:
        return f"❓ No launcher mapping for {tid}"
    bat_path = _bat_path(bat)
    if not bat_path.exists():
        return f"❌ Missing {bat_path.name} — cannot start {t['noun']}"

    # Match launcher's `start "title" cmd /k <bat> <args>` pattern. Title must
    # contain a space so cmd treats it as a title (see launcher_v2.py bug we
    # already hit).
    title = f"Lubas: {t['noun']}"
    args = ["cmd", "/c", "start", title, "cmd", "/k", str(bat_path), *t.get("bat_args", [])]
    try:
        subprocess.Popen(args, cwd=str(ROOT))
        return f"▶ Starting {t['noun']}"
    except OSError as exc:
        log.exception("start_target failed for %s", tid)
        return f"❌ Failed to start {t['noun']}: {exc}"


def stop_target(tid: str) -> str:
    """Stop every process matching this target. Uses `stop_pid` per match
    so both single-process targets (API, recorders) and multi-process
    targets (replay, train) go through the same graceful-then-force kill
    pipeline.
    """
    t = TARGETS[tid]
    frags = _CMDLINE_FRAGMENTS.get(t["kind"])
    if not frags:
        return f"❓ Cannot stop {t['noun']} (no process pattern)"
    inst = t.get("inst")
    pids: list[int] = []
    for p in _scan_processes():
        try:
            cl = p.info.get("cmdline") or []
            if _matches(cl, frags, inst):
                # Disambiguate live TFA vs replay (both use main.py).
                if t["kind"] == "tfa" and "replay" in " ".join(cl).lower():
                    continue
                pids.append(p.pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    if not pids:
        return f"⚪ {t['noun']} is not running"

    results = [stop_pid(pid) for pid in pids]
    return "\n".join(results)


def stop_pid(pid: int) -> str:
    """Stop a specific process by pid. Skips Ctrl+C-via-AttachConsole
    entirely because that path broadcasts to the whole console group and
    triggers cmd.exe's `Terminate batch job (Y/N)?` prompt on the parent
    bat (user-visible noise). Direct `TerminateProcess` via psutil kills
    just the target; cmd sees the child died normally and continues.

    Child processes (e.g. Node under server_launcher.py) are terminated
    first so they don't get orphaned when the Python parent dies.
    """
    try:
        p = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return f"⚪ Process {pid} already gone"

    label = " ".join(p.cmdline()[-2:]) if p.cmdline() else str(pid)

    # Snapshot children + parent BEFORE terminating the target. The parent
    # is usually the cmd.exe hosting the bat that spawned this Python; we
    # kill it after the child so the desktop window closes gracefully.
    try:
        children = p.children(recursive=True)
    except psutil.NoSuchProcess:
        children = []
    parent_to_kill: psutil.Process | None = None
    try:
        par = p.parent()
        if par and (par.name() or "").lower() == "cmd.exe":
            par_cl = " ".join(par.cmdline() or []).lower()
            if "startup\\" in par_cl or "startup/" in par_cl:
                parent_to_kill = par
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass

    for c in children:
        try:
            c.terminate()
        except psutil.NoSuchProcess:
            pass

    try:
        p.terminate()
    except psutil.NoSuchProcess:
        return f"⚪ Process {pid} already gone"

    try:
        p.wait(timeout=3)
    except psutil.TimeoutExpired:
        try:
            p.kill()
        except psutil.NoSuchProcess:
            pass

    # Now close the cmd window that hosted the bat.
    if parent_to_kill is not None:
        try:
            parent_to_kill.terminate()
        except psutil.NoSuchProcess:
            pass

    extras = []
    if children:
        extras.append(f"+{len(children)} child")
    if parent_to_kill is not None:
        extras.append("+window")
    suffix = f" ({', '.join(extras)})" if extras else ""
    return f"⏹ Stopped {label} (pid {pid}){suffix}"


def restart_target(tid: str) -> str:
    stop_msg = stop_target(tid)
    # Allow the OS a moment to release the port / file handles before respawn.
    # 2s mirrors the desktop launcher's restart pattern.
    import time
    time.sleep(2)
    start_msg = start_target(tid)
    return f"{stop_msg}\n{start_msg}"


def fire_shutdown() -> str:
    ps1 = STARTUP / "stop-all.ps1"
    if not ps1.exists():
        return "❌ stop-all.ps1 missing — cannot shut down"
    powershell = shutil.which("powershell") or "powershell"
    try:
        subprocess.Popen(
            [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps1)],
            cwd=str(ROOT),
        )
        return "🛑 Shutdown initiated — 60s grace; run `shutdown /a` on desktop to cancel."
    except OSError as exc:
        log.exception("shutdown spawn failed")
        return f"❌ Failed to start shutdown: {exc}"


def fire_run(tid: str) -> str:
    """One-shot run for backtest / compare. Same start-in-new-window pattern
    as start_target but doesn't track liveness afterwards."""
    return start_target(tid)


def fire_delete(kind: str) -> str:
    """Delete one of: raw, parquet, live, models. Each maps to a directory
    or file glob under data/ or models/. Irreversible; caller confirmed."""
    if kind == "raw":
        target = ROOT / "data" / "raw"
    elif kind == "parquet":
        target = ROOT / "data" / "features"  # parquet files live alongside features
    elif kind == "live":
        target = ROOT / "data" / "features"
    elif kind == "models":
        target = ROOT / "models"
    else:
        return f"❓ Unknown delete kind: {kind}"

    if not target.exists():
        return f"⚪ {kind} folder already empty ({target.name})"

    try:
        if kind == "live":
            # Only the *_live.ndjson files, not the parquet
            removed = 0
            for f in target.glob("*_live.ndjson"):
                f.unlink()
                removed += 1
            return f"🗑 Deleted {removed} live NDJSON file(s)"
        if kind == "parquet":
            removed = 0
            for f in target.rglob("*.parquet"):
                f.unlink()
                removed += 1
            return f"🗑 Deleted {removed} parquet file(s)"
        # raw + models: rmtree
        import shutil as _shutil
        _shutil.rmtree(target)
        target.mkdir(parents=True, exist_ok=True)
        return f"🗑 Cleared {target.name}/"
    except OSError as exc:
        log.exception("delete failed for kind=%s", kind)
        return f"❌ Delete failed: {exc}"
