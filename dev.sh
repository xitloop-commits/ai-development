#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  ATS — Start Development Server (macOS / Linux)                  ║
# ║                                                                  ║
# ║  Starts both the Node.js server and the Python AI pipeline.     ║
# ║                                                                  ║
# ║  Usage:                                                          ║
# ║    chmod +x dev.sh                                               ║
# ║    ./dev.sh              # Node.js + Python AI pipeline          ║
# ║    ./dev.sh --node-only  # Node.js server only (no Python)       ║
# ║    ./dev.sh --py-only    # Python AI pipeline only               ║
# ║                                                                  ║
# ║  Press Ctrl+C to stop all processes.                             ║
# ╚══════════════════════════════════════════════════════════════════╝

set -e

# ─── Parse arguments ──────────────────────────────────────────
NODE_ONLY=false
PY_ONLY=false
for arg in "$@"; do
    case "$arg" in
        --node-only) NODE_ONLY=true ;;
        --py-only)   PY_ONLY=true ;;
    esac
done

# ─── Check .env ───────────────────────────────────────────────
if [ ! -f .env ]; then
    echo "  ERROR: .env file not found."
    echo "  Run ./setup.sh first, or copy .env.example to .env"
    exit 1
fi

# ─── Detect and setup pnpm ────────────────────────────────────
PNPM_CMD=""
if command -v pnpm &> /dev/null; then
    PNPM_CMD="pnpm"
else
    echo "  [!] pnpm not found. Installing globally..."
    npm install -g pnpm 2>/dev/null && PNPM_CMD="pnpm"

    # Fallback to npx if global install failed
    if [ -z "$PNPM_CMD" ] && command -v npx &> /dev/null; then
        echo "      Using npx pnpm instead."
        PNPM_CMD="npx pnpm"
    fi
fi

if [ -z "$PNPM_CMD" ]; then
    echo "  ERROR: pnpm could not be installed and npx is not available."
    exit 1
fi

# ─── Install dependencies if needed ───────────────────────────
if [ ! -d "node_modules" ] || [ $(ls node_modules 2>/dev/null | wc -l) -lt 50 ]; then
    echo "  [*] Installing dependencies with $PNPM_CMD..."
    $PNPM_CMD install || { echo "  ERROR: Failed to install dependencies"; exit 1; }
    echo ""
fi

# ─── Detect Python ────────────────────────────────────────────
PYTHON_CMD=""
if command -v python3 &> /dev/null; then
    PYTHON_CMD="python3"
elif command -v python &> /dev/null; then
    PYTHON_CMD="python"
fi

# ─── Setup Python virtual environment ──────────────────────────
if [ -n "$PYTHON_CMD" ]; then
    VENV_DIR="python_venv"
    if [ ! -d "$VENV_DIR" ]; then
        echo "  [*] Creating Python virtual environment..."
        $PYTHON_CMD -m venv "$VENV_DIR" || { echo "  ERROR: Failed to create virtual environment"; exit 1; }
    fi

    # Activate virtual environment
    source "$VENV_DIR/bin/activate"

    # Install Python dependencies if needed
    if [ -f "python_modules/requirements.txt" ]; then
        echo "  [*] Installing Python dependencies..."
        pip install -q -r python_modules/requirements.txt || { echo "  ERROR: Failed to install Python dependencies"; exit 1; }
        echo ""
    fi
fi

# ─── Cleanup on exit ──────────────────────────────────────────
NODE_PID=""
PY_PID=""

cleanup() {
    echo ""
    echo "  Stopping all processes..."
    [ -n "$PY_PID" ] && kill "$PY_PID" 2>/dev/null && wait "$PY_PID" 2>/dev/null
    [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null && wait "$NODE_PID" 2>/dev/null
    echo "  All processes stopped."
    exit 0
}
trap cleanup SIGINT SIGTERM

# ─── Banner ───────────────────────────────────────────────────
echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║  ATS — Automatic Trading System          ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# ─── Start Node.js server ─────────────────────────────────────
if [ "$PY_ONLY" = false ]; then
    echo "  [1] Starting Node.js server..."
    $PNPM_CMD dev &
    NODE_PID=$!
    echo "      PID: $NODE_PID"
    echo ""

    # Wait for Node.js to be ready before starting Python
    if [ "$NODE_ONLY" = false ]; then
        echo "  [*] Waiting for Node.js server to be ready..."
        for i in $(seq 1 30); do
            if curl -s http://localhost:${PORT:-3000}/api/trading/heartbeat > /dev/null 2>&1; then
                echo "      Node.js server ready."
                break
            fi
            if [ $i -eq 30 ]; then
                echo "      WARNING: Node.js server not responding after 30s."
                echo "      Starting Python modules anyway..."
            fi
            sleep 1
        done
        echo ""
    fi
fi

# ─── Start Python AI pipeline ─────────────────────────────────
if [ "$NODE_ONLY" = false ]; then
    if [ -z "$PYTHON_CMD" ]; then
        echo "  [!] Python not found — AI pipeline will not start."
        echo "      Install Python 3.8+ to enable AI features."
        echo ""
    else
        echo "  [2] Starting Python AI pipeline..."
        $PYTHON_CMD python_modules/run_all.py &
        PY_PID=$!
        echo "      PID: $PY_PID"
        echo ""
    fi
fi

# ─── Wait ─────────────────────────────────────────────────────
echo "  Press Ctrl+C to stop all processes."
echo ""
wait
