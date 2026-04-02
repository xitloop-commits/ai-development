#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  ATS — Start Development Server (macOS / Linux)                  ║
# ║                                                                  ║
# ║  Usage:                                                          ║
# ║    chmod +x dev.sh                                               ║
# ║    ./dev.sh                                                      ║
# ╚══════════════════════════════════════════════════════════════════╝

echo ""
echo "  Starting ATS Development Server..."
echo "  Press Ctrl+C to stop."
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "  ERROR: .env file not found."
    echo "  Run ./setup.sh first, or copy .env.example to .env"
    exit 1
fi

# Start the dev server
pnpm dev
