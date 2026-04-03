#!/usr/bin/env python3
"""
ATS — Python AI Pipeline Orchestrator

Starts all Python AI modules in the correct dependency order:
  1. performance_feedback.py   — Pre-market parameter tuning (runs once, then exits)
  2. session_manager.py        — Session state, daily P&L caps, carry forward
  3. dhan_option_chain_fetcher.py — Fetches option chain data from Dhan
  4. option_chain_analyzer.py  — Analyzes option chain for S/R levels, IV, OI
  5. ai_decision_engine.py     — Generates trade decisions from analyzer output
  6. execution_module.py       — Executes trades (includes WebSocket feed + Momentum Engine)
  7. dashboard_data_pusher.py  — Pushes AI data to the Node.js dashboard

Usage:
    python3 run_all.py              # Start all modules
    python3 run_all.py --no-feedback  # Skip pre-market feedback loop
    python3 run_all.py --dry-run    # Print startup plan without launching

Press Ctrl+C to stop all modules gracefully.
"""
import env_loader  # noqa: F401 — load .env from project root

import os
import sys
import signal
import subprocess
import time
import argparse
from datetime import datetime

# ─── Configuration ────────────────────────────────────────────
PYTHON_CMD = sys.executable
MODULE_DIR = os.path.dirname(os.path.abspath(__file__))

# Startup order: (module_file, description, is_daemon)
# is_daemon=True  → runs continuously in background
# is_daemon=False → runs once and exits before next module starts
MODULES = [
    ("performance_feedback.py",      "Pre-market parameter tuning",   False),
    ("session_manager.py",           "Session manager (P&L caps)",    True),
    ("dhan_option_chain_fetcher.py", "Option chain fetcher",          True),
    ("option_chain_analyzer.py",     "Option chain analyzer",         True),
    ("ai_decision_engine.py",        "AI decision engine",            True),
    ("execution_module.py",          "Trade executor + momentum",     True),
    ("dashboard_data_pusher.py",     "Dashboard data pusher",         True),
]

# Delay between daemon launches (seconds)
LAUNCH_DELAY = 3

# ─── State ────────────────────────────────────────────────────
processes: list[tuple[str, subprocess.Popen]] = []
shutting_down = False


def log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] [Orchestrator] {msg}", flush=True)


def start_module(filename: str, description: str, is_daemon: bool) -> subprocess.Popen | None:
    """Start a Python module as a subprocess."""
    filepath = os.path.join(MODULE_DIR, filename)
    if not os.path.exists(filepath):
        log(f"  SKIP {filename} — file not found")
        return None

    log(f"  START {filename} — {description}")
    proc = subprocess.Popen(
        [PYTHON_CMD, filepath],
        cwd=MODULE_DIR,
        stdout=sys.stdout,
        stderr=sys.stderr,
    )

    if not is_daemon:
        # Wait for one-shot module to finish
        log(f"  WAIT  {filename} (one-shot)...")
        proc.wait()
        exit_code = proc.returncode
        if exit_code == 0:
            log(f"  DONE  {filename} (exit code 0)")
        else:
            log(f"  WARN  {filename} exited with code {exit_code}")
        return None
    else:
        # Daemon — add to process list
        processes.append((filename, proc))
        return proc


def shutdown_all(signum=None, frame=None):
    """Gracefully terminate all running daemon processes."""
    global shutting_down
    if shutting_down:
        return
    shutting_down = True

    log("")
    log("Shutting down all modules...")
    for name, proc in reversed(processes):
        if proc.poll() is None:
            log(f"  STOP  {name} (pid {proc.pid})")
            proc.terminate()

    # Wait up to 5 seconds for graceful shutdown
    deadline = time.time() + 5
    for name, proc in processes:
        remaining = max(0, deadline - time.time())
        try:
            proc.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            log(f"  KILL  {name} (pid {proc.pid}) — force kill")
            proc.kill()

    log("All modules stopped.")
    sys.exit(0)


def monitor_processes():
    """Monitor running daemons and restart any that crash."""
    while not shutting_down:
        for i, (name, proc) in enumerate(processes):
            if proc.poll() is not None:
                exit_code = proc.returncode
                if exit_code != 0 and not shutting_down:
                    log(f"  CRASH {name} (exit code {exit_code}) — restarting in 5s...")
                    time.sleep(5)
                    if shutting_down:
                        break
                    # Find the module config
                    for filename, desc, is_daemon in MODULES:
                        if filename == name and is_daemon:
                            new_proc = start_module(filename, desc, True)
                            if new_proc:
                                processes[i] = (name, new_proc)
                            break
        time.sleep(2)


def main():
    parser = argparse.ArgumentParser(description="ATS Python AI Pipeline Orchestrator")
    parser.add_argument("--no-feedback", action="store_true",
                        help="Skip pre-market performance feedback loop")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print startup plan without launching modules")
    args = parser.parse_args()

    log("╔══════════════════════════════════════════════════════════╗")
    log("║  ATS — Python AI Pipeline Orchestrator                  ║")
    log("╚══════════════════════════════════════════════════════════╝")
    log("")

    # Print startup plan
    log("Startup plan:")
    for i, (filename, desc, is_daemon) in enumerate(MODULES, 1):
        mode = "daemon" if is_daemon else "one-shot"
        skip = " (SKIP)" if (filename == "performance_feedback.py" and args.no_feedback) else ""
        log(f"  {i}. {filename:<35s} [{mode}] {desc}{skip}")
    log("")

    if args.dry_run:
        log("Dry run — no modules launched.")
        return

    # Register signal handlers for graceful shutdown
    signal.signal(signal.SIGINT, shutdown_all)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, shutdown_all)

    # Launch modules in order
    for filename, desc, is_daemon in MODULES:
        if shutting_down:
            break

        # Skip feedback if --no-feedback
        if filename == "performance_feedback.py" and args.no_feedback:
            log(f"  SKIP  {filename} (--no-feedback)")
            continue

        start_module(filename, desc, is_daemon)

        # Small delay between daemon launches to avoid port/resource conflicts
        if is_daemon and not shutting_down:
            time.sleep(LAUNCH_DELAY)

    if not shutting_down:
        log("")
        log(f"All {len(processes)} daemon modules running. Press Ctrl+C to stop.")
        log("")
        monitor_processes()


if __name__ == "__main__":
    main()
