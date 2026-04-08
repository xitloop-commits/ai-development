#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  ATS — Start Web Server only (macOS / Linux)                     ║
# ║                                                                  ║
# ║  Starts the Node.js / Vite dev server.                          ║
# ║  Usage:  ./dev-web.sh                                            ║
# ║  Press Ctrl+C to stop.                                           ║
# ╚══════════════════════════════════════════════════════════════════╝

set -e

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
if [ ! -d "node_modules" ] || [ "$(ls node_modules 2>/dev/null | wc -l)" -lt 50 ]; then
    echo "  [*] Installing dependencies with $PNPM_CMD..."
    $PNPM_CMD install || { echo "  ERROR: Failed to install dependencies"; exit 1; }
    echo ""
fi

# ─── Banner ───────────────────────────────────────────────────
echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║  ATS — Web Server                        ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""
echo "  Starting Node.js / Vite dev server..."
echo ""

exec $PNPM_CMD dev
