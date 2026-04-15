#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  ATS — TickFeatureAgent (TFA) launcher (macOS / Linux)          ║
# ║                                                                  ║
# ║  Usage:                                                          ║
# ║    ./startup/start-tfa.sh nifty50                                ║
# ║    ./startup/start-tfa.sh banknifty                              ║
# ║    ./startup/start-tfa.sh crudeoil                               ║
# ║    ./startup/start-tfa.sh naturalgas                             ║
# ║                                                                  ║
# ║    ./startup/start-tfa.sh nifty50 --mode replay --date 2026-04-10║
# ║                                                                  ║
# ║  Press Ctrl+C to stop.                                           ║
# ╚══════════════════════════════════════════════════════════════════╝

set -e

# ─── Go to project root (one level up from this script) ───────
cd "$(dirname "$0")/.."

# ─── Instrument argument ──────────────────────────────────────────
INSTRUMENT="${1:-}"

if [ -z "$INSTRUMENT" ]; then
    echo ""
    echo "  Usage:  ./startup/start-tfa.sh <instrument> [options]"
    echo ""
    echo "  Instruments:"
    echo "    nifty50      NSE NIFTY 50 futures + options"
    echo "    banknifty    NSE Bank Nifty futures + options"
    echo "    crudeoil     MCX Crude Oil futures + options"
    echo "    naturalgas   MCX Natural Gas futures + options"
    echo ""
    echo "  Options:"
    echo "    --mode live              (default)"
    echo "    --mode replay --date YYYY-MM-DD"
    echo "    --log-level DEBUG"
    echo ""
    exit 1
fi

# ─── Resolve profile path ─────────────────────────────────────────
case "$INSTRUMENT" in
    nifty50)    PROFILE_PATH="config/instrument_profiles/nifty50_profile.json" ;;
    banknifty)  PROFILE_PATH="config/instrument_profiles/banknifty_profile.json" ;;
    crudeoil)   PROFILE_PATH="config/instrument_profiles/crudeoil_profile.json" ;;
    naturalgas) PROFILE_PATH="config/instrument_profiles/naturalgas_profile.json" ;;
    *)
        echo ""
        echo "  ERROR: Unknown instrument \"$INSTRUMENT\""
        echo "  Valid values: nifty50, banknifty, crudeoil, naturalgas"
        echo ""
        exit 1
        ;;
esac

# ─── Shift past the instrument name so remaining args pass through ─
shift

# ─── Detect Python ────────────────────────────────────────────────
PYTHON_CMD=""
for candidate in python3.14 python3.13 python3.12 python3.11 python3 python; do
    if command -v "$candidate" &>/dev/null; then
        PYTHON_CMD="$candidate"
        break
    fi
done

if [ -z "$PYTHON_CMD" ]; then
    echo "  ERROR: Python not found."
    echo "  Install Python 3.11+ from https://www.python.org/downloads/"
    exit 1
fi

# ─── Setup virtual environment ────────────────────────────────────
VENV_DIR="python_venv"
if [ ! -d "$VENV_DIR" ]; then
    echo "  [*] Creating Python virtual environment..."
    $PYTHON_CMD -m venv "$VENV_DIR" || { echo "  ERROR: Failed to create virtual environment"; exit 1; }
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

if [ -f "python_modules/requirements.txt" ]; then
    echo "  [*] Checking Python dependencies..."
    pip install -q -r python_modules/requirements.txt || { echo "  ERROR: Failed to install Python dependencies"; exit 1; }
fi

# ─── Run TFA ──────────────────────────────────────────────────────
OUTPUT_FILE="data/features/${INSTRUMENT}_live.ndjson"

exec python python_modules/tick_feature_agent/main.py \
    --instrument-profile "$PROFILE_PATH" \
    --output-file "$OUTPUT_FILE" \
    "$@"
