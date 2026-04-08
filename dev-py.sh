#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  ATS — Start Python AI Pipeline only (macOS / Linux)             ║
# ║                                                                  ║
# ║  Starts the Python AI pipeline (run_all.py).                    ║
# ║  Usage:  ./dev-py.sh                                             ║
# ║  Press Ctrl+C to stop.                                           ║
# ╚══════════════════════════════════════════════════════════════════╝

set -e

# ─── Check .env ───────────────────────────────────────────────
if [ ! -f .env ]; then
    echo "  ERROR: .env file not found."
    echo "  Run ./setup.sh first, or copy .env.example to .env"
    exit 1
fi

# ─── Detect Python ────────────────────────────────────────────
PYTHON_CMD=""
if command -v python3 &> /dev/null; then
    PYTHON_CMD="python3"
elif command -v python &> /dev/null; then
    PYTHON_CMD="python"
fi

if [ -z "$PYTHON_CMD" ]; then
    echo "  ERROR: Python not found."
    echo "  Install Python 3.8+ to enable AI features."
    exit 1
fi

# ─── Setup Python virtual environment ─────────────────────────
VENV_DIR="python_venv"
if [ ! -d "$VENV_DIR" ]; then
    echo "  [*] Creating Python virtual environment..."
    $PYTHON_CMD -m venv "$VENV_DIR" || { echo "  ERROR: Failed to create virtual environment"; exit 1; }
fi

source "$VENV_DIR/bin/activate"

if [ -f "python_modules/requirements.txt" ]; then
    echo "  [*] Installing Python dependencies..."
    pip install -q -r python_modules/requirements.txt || { echo "  ERROR: Failed to install Python dependencies"; exit 1; }
    echo ""
fi

# ─── Banner ───────────────────────────────────────────────────
echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║  ATS — Python AI Pipeline                ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""
echo "  Using Python: $(which python)"
echo ""

exec python python_modules/run_all.py
