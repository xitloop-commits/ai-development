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

# ─── Detect Python ────────────────────────────────────────────
PYTHON_CMD=""
if command -v python3 &> /dev/null; then
    PYTHON_CMD="python3"
elif command -v python &> /dev/null; then
    PYTHON_CMD="python"
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
    pnpm dev &
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
