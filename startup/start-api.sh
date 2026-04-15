#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  ATS — Start API Server only (macOS / Linux)                     ║
# ║                                                                  ║
# ║  Starts the Node.js broker / tRPC API server in dev mode.       ║
# ║  Usage:  ./startup/start-api.sh                                  ║
# ║  Press Ctrl+C to stop.                                           ║
# ╚══════════════════════════════════════════════════════════════════╝

set -e

# ─── Go to project root (one level up from this script) ───────
cd "$(dirname "$0")/.."

# ─── Check .env ───────────────────────────────────────────────
if [ ! -f .env ]; then
    echo "  ERROR: .env file not found."
    echo "  Run ./startup/setup.sh first, or copy .env.example to .env"
    exit 1
fi

# ─── Detect pnpm ──────────────────────────────────────────────
PNPM_CMD=""
if command -v pnpm &> /dev/null; then
    PNPM_CMD="pnpm"
elif command -v npx &> /dev/null; then
    PNPM_CMD="npx pnpm"
else
    echo "  ERROR: pnpm not found. Run: npm install -g pnpm"
    exit 1
fi

# ─── Install dependencies if needed ───────────────────────────
if [ ! -d "node_modules" ] || [ "$(ls node_modules 2>/dev/null | wc -l)" -lt 50 ]; then
    echo "  [*] Installing dependencies..."
    $PNPM_CMD install || { echo "  ERROR: Failed to install dependencies"; exit 1; }
    echo ""
fi

# ─── Banner ───────────────────────────────────────────────────
echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║  ATS — API Server                        ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""
echo "  Starting Node.js API server on http://localhost:3000"
echo ""

exec $PNPM_CMD dev
