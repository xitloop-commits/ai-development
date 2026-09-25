"""TCS2 — per-instrument capability config and paths.

Spec: docs/systems/14_tcs2.md

Every constant here carries the evidence for it. Where a figure came from our own
recordings rather than from Dhan it says so, because D22 makes our recordings
provisional until confirmed.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

# ── Instruments ──────────────────────────────────────────────────────────
# The four TCS2 covers (D4, revised 2026-09-23 from the earlier nifty-only D4).
INSTRUMENTS = ("nifty50", "banknifty", "crudeoil", "naturalgas")

# ── Paths ────────────────────────────────────────────────────────────────
# Date-first, instrument-second: retention deletes whole days (D20), so a day is
# one directory to remove rather than a scan across instruments.
#
# ANCHORED TO THE REPOSITORY, never to the current directory. `startup/tcs2.bat`
# runs from `python_modules` so that `tcs2` imports as a top-level package, and a
# relative path there silently created a SECOND data tree at
# `python_modules/data/tcs2/` - found live 2026-09-25, mid-session, with 4 MB of
# nifty ticks in the wrong place and the real recording apparently stalled.
# Where a process was launched from must never decide where a day's ticks land.
REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_ROOT = REPO_ROOT / "data" / "tcs2"
SCRIP_DIR = DATA_ROOT / "scrip"
SCRIP_CSV = SCRIP_DIR / "api-scrip-master-detailed.csv"
RESOLVED_DIR = SCRIP_DIR / "resolved"   # opt-in hand-debugging only, not written in normal running
TICKS_DIR = DATA_ROOT / "ticks"
ANALYSER_DIR = DATA_ROOT / "analyser"
HEALTH_DIR = DATA_ROOT / "health"
LOGS_DIR = DATA_ROOT / "logs"

# Dhan's DETAILED scrip master, not the compact one the Node server uses
# (server/broker/adapters/dhan/constants.ts SCRIP_MASTER). The detailed file adds
# UNDERLYING_SECURITY_ID and EXPIRY_FLAG, so legs group by id instead of by
# parsing symbol strings (D12).
SCRIP_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv"

# Re-download only if the cache is older than this. One shared file, because all
# four processes start at 08:54 (D18) and four simultaneous 35 MB downloads is
# waste. A read-only shared file is NOT a D14 violation: D14 bans shared analyser
# and tick state, not reading the same config.
SCRIP_MAX_AGE_HOURS = 24

# ── Connection limits ────────────────────────────────────────────────────
# DHAN_WS_MAX_INSTRUMENTS_PER_CONN in server/broker/adapters/dhan/constants.ts.
# Dhan's documented figure; 475 is all we have ever proven live. Breach shows up
# as disconnect code 804, "Instruments exceed limit".
MAX_INSTRUMENTS_PER_CONN = 5000

# Dhan accepts at most this many instruments per subscribe message, so a large
# chain is sent in several messages (tick_feature_agent/feed/dhan_feed.py:38).
MAX_INSTRUMENTS_PER_MSG = 100

# One connection per process, always (D13). A process that appears to need a
# second one means a wrong strike list, not growth.
MAX_CONNECTIONS_PER_PROCESS = 1


@dataclass(frozen=True)
class Capability:
    """What a given instrument actually has.

    Measured from our own 2026-09-22 recordings and confirmed against Dhan's
    detailed scrip master EXPIRY_FLAG on 2026-09-23 (D11, D19). Only NIFTY
    carries a W row; BANKNIFTY, CRUDEOIL and NATURALGAS are monthly-only.
    """

    name: str
    exchange: str            # NSE | MCX
    segment: str             # NSE_FNO | MCX_COMM  (for the history API)
    underlying_symbol: str   # UNDERLYING_SYMBOL in the detailed master
    option_instrument: str   # OPTIDX | OPTFUT
    futures_instrument: str  # FUTIDX | FUTCOM
    has_index: bool          # MCX has none: the futures IS the underlying
    has_vix: bool            # India VIX is NSE-only; no crude/gas equivalent
    has_weekly: bool         # NIFTY alone
    strike_step: float       # nifty 50, banknifty 100, crude 50, gas 5
    lot_size: int
    session_open: str
    session_close: str
    # Option chains to watch: 3 for nifty (week, month, next), 2 for the rest.
    # Whole chain every time, never a band around the money (D5) — proven
    # 2026-09-24 when crude's 5,000 PE, 4,040 points out of the money, carried
    # 682 candles and 499 OI. A moving band would have missed it.
    option_expiries: int = 2
    # Current + next futures, always, not only during rollover week (D19).
    futures_contracts: int = 2


CAPABILITIES: dict[str, Capability] = {
    "nifty50": Capability(
        name="nifty50", exchange="NSE", segment="NSE_FNO",
        underlying_symbol="NIFTY", option_instrument="OPTIDX",
        futures_instrument="FUTIDX",
        has_index=True, has_vix=True, has_weekly=True,
        strike_step=50.0, lot_size=65,
        session_open="09:15", session_close="15:30",
        option_expiries=3,
    ),
    "banknifty": Capability(
        name="banknifty", exchange="NSE", segment="NSE_FNO",
        underlying_symbol="BANKNIFTY", option_instrument="OPTIDX",
        futures_instrument="FUTIDX",
        has_index=True, has_vix=True, has_weekly=False,
        strike_step=100.0, lot_size=30,
        session_open="09:15", session_close="15:30",
    ),
    "crudeoil": Capability(
        name="crudeoil", exchange="MCX", segment="MCX_COMM",
        underlying_symbol="CRUDEOIL", option_instrument="OPTFUT",
        futures_instrument="FUTCOM",
        has_index=False, has_vix=False, has_weekly=False,
        strike_step=50.0, lot_size=100,
        session_open="09:00", session_close="23:30",
    ),
    "naturalgas": Capability(
        name="naturalgas", exchange="MCX", segment="MCX_COMM",
        underlying_symbol="NATURALGAS", option_instrument="OPTFUT",
        futures_instrument="FUTCOM",
        has_index=False, has_vix=False, has_weekly=False,
        strike_step=5.0, lot_size=1250,
        session_open="09:00", session_close="23:30",
    ),
}

# India VIX, subscribed by the nifty50 and banknifty processes independently
# (D14: twice on two connections rather than fetched once and shared — 1 leg
# each out of 5,000). Resolved from the scrip master by name, not hardcoded.
VIX_SYMBOL = "INDIA VIX"

# ── Expected leg counts ──────────────────────────────────────────────────
# From Dhan's detailed scrip master 2026-09-23 (D19). These are a SANITY BOUND,
# not a target: real per-expiry counts differ, because expiries do not carry
# equal strike counts. Phase 0 is done when resolve() lands in this range.
EXPECTED_LEGS = {
    "nifty50": (1200, 1800),    # measured 1,488 = week 460 + month 536 + next 488 + 4
    "banknifty": (1200, 1800),  # measured 1,442 = month 728 + next 710 + 4
    "crudeoil": (600, 1000),    # measured   786 = month 414 + next 370 + 2
    "naturalgas": (250, 500),   # measured   356 = month 184 + next 170 + 2
}
