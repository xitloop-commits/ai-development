#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  ATS — macOS / Linux Setup Script                               ║
# ║  Run this once after cloning the repository.                    ║
# ║                                                                  ║
# ║  Usage:                                                          ║
# ║    chmod +x setup.sh                                             ║
# ║    ./setup.sh                                                    ║
# ╚══════════════════════════════════════════════════════════════════╝

set -e

echo ""
echo "============================================================"
echo "  ATS — Automatic Trading System — macOS / Linux Setup"
echo "============================================================"
echo ""

# --- Step 1: Check Node.js ---
echo "[1/6] Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo "  ERROR: Node.js is not installed or not in PATH."
    echo "  Install via Homebrew:  brew install node"
    echo "  Or download from:     https://nodejs.org/"
    exit 1
fi
echo "  Found Node.js $(node --version)"

# --- Step 2: Check Python ---
echo "[2/6] Checking Python..."
PYTHON_CMD=""
if command -v python3 &> /dev/null; then
    PYTHON_CMD="python3"
elif command -v python &> /dev/null; then
    PYTHON_CMD="python"
fi

if [ -z "$PYTHON_CMD" ]; then
    echo "  WARNING: Python is not installed or not in PATH."
    echo "  Python modules will not work without it."
    echo "  Install via Homebrew:  brew install python"
    echo "  Or download from:     https://www.python.org/downloads/"
else
    echo "  Found $($PYTHON_CMD --version)"
fi

# --- Step 3: Install pnpm (if not installed) ---
echo "[3/6] Checking pnpm..."
if ! command -v pnpm &> /dev/null; then
    echo "  pnpm not found. Installing via npm..."
    npm install -g pnpm
    if [ $? -ne 0 ]; then
        echo "  ERROR: Failed to install pnpm. Try:"
        echo "    sudo npm install -g pnpm"
        echo "  Or via Homebrew:  brew install pnpm"
        exit 1
    fi
    echo "  pnpm installed successfully."
else
    echo "  Found pnpm $(pnpm --version)"
fi

# --- Step 4: Install Node.js dependencies ---
echo "[4/6] Installing Node.js dependencies..."
pnpm install
if [ $? -ne 0 ]; then
    echo "  ERROR: pnpm install failed."
    echo "  Try deleting node_modules and pnpm-lock.yaml, then run again."
    exit 1
fi
echo "  Node.js dependencies installed."

# --- Step 5: Install Python dependencies ---
echo "[5/6] Installing Python dependencies..."
if [ -n "$PYTHON_CMD" ]; then
    $PYTHON_CMD -m pip install -r python_modules/requirements.txt 2>/dev/null || \
    $PYTHON_CMD -m pip install --user -r python_modules/requirements.txt 2>/dev/null || \
    echo "  WARNING: Python dependency install failed. Try: $PYTHON_CMD -m pip install requests python-dotenv"
    echo "  Python dependencies installed."
else
    echo "  Skipped (Python not found)."
fi

# --- Step 6: Create .env if it doesn't exist ---
echo "[6/6] Checking .env file..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "  Created .env from .env.example"
    echo ""
    echo "  *** IMPORTANT: Edit .env and fill in your values ***"
    echo "  At minimum, set MONGODB_URI to your MongoDB connection string."
    echo ""
else
    echo "  .env already exists. Skipping."
fi

echo ""
echo "============================================================"
echo "  Setup Complete!"
echo "============================================================"
echo ""
echo "  Next steps:"
echo "    1. Edit .env with your MongoDB URI and other settings"
echo "    2. Start the server:   ./dev.sh   (or pnpm dev)"
echo "    3. Open browser:       http://localhost:3000"
echo ""
echo "  To run Python modules (in a separate terminal):"
echo "    cd python_modules"
echo "    $PYTHON_CMD option_chain_fetcher.py"
echo ""
