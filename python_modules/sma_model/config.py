"""sma-model configuration constants.

Charge rates mirror the production Charges engine defaults
(server/userSettings.ts DEFAULT_CHARGES + server/portfolio/charges.ts
rounding rules). Statutory rates as of 2026-04-01.
"""
from __future__ import annotations

from pathlib import Path

# Project root = ai-development repo root (this file lives at
# python_modules/sma_model/config.py).
PROJECT_ROOT = Path(__file__).resolve().parents[2]

RAW_ROOT = PROJECT_ROOT / "data" / "raw"
DATASET_ROOT = PROJECT_ROOT / "data" / "sma_model_dataset"
MODELS_ROOT = PROJECT_ROOT / "models" / "sma_model"

INSTRUMENT = "nifty50"

# NIFTY option/futures lot size. Verified 2026-08-07 from recorded order-book
# quantities (GCD of all observed ltq/bid_size/ask_size on 2026-08-06 = 65).
LOT_SIZE = 65

# Strike spacing for NIFTY weeklies.
STRIKE_STEP = 50

# IST offset (recv_ts is UTC epoch seconds).
IST_OFFSET_SEC = 19800

# NSE session (IST).
SESSION_START_MIN = 9 * 60 + 15   # 09:15
SESSION_END_MIN = 15 * 60 + 30    # 15:30

SMA_PERIOD = 5
RSI_PERIOD = 14

# Decisions need indicator history; first decision candle index (0-based)
# within the day. 14 → RSI/leg-memory have data (~09:30 onward).
MIN_DECISION_CANDLE = 14

# A quote older than this at decision time counts as missing (data gap).
QUOTE_STALENESS_SEC = 120.0

# ── Charges (production DEFAULT_CHARGES, round-trip long option) ──────────
BROKERAGE_PER_ORDER = 20.0        # Dhan flat/order; 2 orders per round trip
STT_SELL_PCT = 0.15               # % of sell premium (from 2026-04-01)
EXCHANGE_TXN_PCT = 0.03553        # % of premium, both sides (NSE options)
GST_PCT = 18.0                    # on brokerage + exchange txn
SEBI_PCT = 0.0001                 # % of turnover both sides
STAMP_BUY_PCT = 0.003             # % of buy premium


def round_trip_charges(buy_value: float, sell_value: float) -> float:
    """Total charges for one long-option round trip (buy then sell).

    Mirrors server/portfolio/charges.ts: STT and Stamp Duty rounded to the
    nearest rupee (contract-note behaviour), everything else to 2 decimals.
    """
    brokerage = round(BROKERAGE_PER_ORDER * 2, 2)
    exch = round((buy_value + sell_value) * EXCHANGE_TXN_PCT / 100.0, 2)
    stt = float(round(sell_value * STT_SELL_PCT / 100.0))
    gst = round((brokerage + exch) * GST_PCT / 100.0, 2)
    sebi = round((buy_value + sell_value) * SEBI_PCT / 100.0, 2)
    stamp = float(round(buy_value * STAMP_BUY_PCT / 100.0))
    return round(brokerage + exch + stt + gst + sebi + stamp, 2)
