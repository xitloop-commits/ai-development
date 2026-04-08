#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  ATS — Start Full Dev Environment (macOS / Linux)                ║
# ║                                                                  ║
# ║  Launches both the web server and Python AI pipeline.           ║
# ║  Use the split scripts to run each independently:               ║
# ║    ./dev-web.sh  — Node.js / Vite dev server only               ║
# ║    ./dev-py.sh   — Python AI pipeline only                       ║
# ║                                                                  ║
# ║  Press Ctrl+C to stop all processes.                             ║
# ╚══════════════════════════════════════════════════════════════════╝

set -e

# ─── Cleanup on exit ──────────────────────────────────────────
WEB_PID=""
PY_PID=""

cleanup() {
    echo ""
    echo "  Stopping all processes..."
    [ -n "$PY_PID" ]  && kill "$PY_PID"  2>/dev/null; wait "$PY_PID"  2>/dev/null || true
    [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null; wait "$WEB_PID" 2>/dev/null || true
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
echo "  Use ./dev-web.sh or ./dev-py.sh to run each independently."
echo ""

# ─── Start web server in background ───────────────────────────
echo "  [1] Starting web server..."
bash dev-web.sh &
WEB_PID=$!
echo "      PID: $WEB_PID"
echo ""

# ─── Start Python pipeline in background ──────────────────────
echo "  [2] Starting Python AI pipeline..."
bash dev-py.sh &
PY_PID=$!
echo "      PID: $PY_PID"
echo ""

echo "  Press Ctrl+C to stop all processes."
echo ""
wait
