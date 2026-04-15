#!/usr/bin/env bash
# =============================================================
#  ATS -- Unified Launcher Menu
#  Arrow keys to navigate, Enter to select, Esc to go back/quit.
# =============================================================

set -eu

# Go to project root (parent of this script's dir)
cd "$(dirname "$0")/.."

export PYTHONIOENCODING=utf-8

# Find python — prefer python3, fall back to python
PYTHON_CMD=""
if command -v python3 >/dev/null 2>&1; then
    PYTHON_CMD="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_CMD="python"
else
    echo "ERROR: Python not found. Install Python 3.11+ and try again."
    exit 1
fi

exec "$PYTHON_CMD" startup/launcher.py
