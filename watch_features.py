"""
watch_features.py — Live dashboard for TFA feature output.

Usage:
    py watch_features.py crudeoil
    py watch_features.py nifty50
    py watch_features.py crudeoil --interval 2
    py watch_features.py crudeoil --full          # all 370 columns
    py watch_features.py crudeoil --full --interval 2
"""

import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

_IST = timezone(timedelta(hours=5, minutes=30))

# ── CLI args ──────────────────────────────────────────────────────────────────
instrument = sys.argv[1] if len(sys.argv) > 1 else "crudeoil"
full_mode  = "--full" in sys.argv
interval   = float(next((sys.argv[i+1] for i, a in enumerate(sys.argv)
                         if a == "--interval" and i+1 < len(sys.argv)), 1.0))

path = Path(f"data/features/{instrument}_live.ndjson")

# ── Summary groups (shown in default mode — fits one screen) ─────────────────
GROUPS = [
    ("MARKET", [
        "timestamp", "spot_price", "atm_strike", "strike_step",
        "trading_state", "is_market_open", "chain_available",
    ]),
    ("PRICE", [
        "underlying_ltp", "underlying_return_5ticks", "underlying_return_20ticks",
        "underlying_momentum", "underlying_velocity", "underlying_tick_imbalance_20",
    ]),
    ("OFI & VOL", [
        "underlying_ofi_5", "underlying_ofi_20",
        "underlying_realized_vol_5", "underlying_realized_vol_20",
    ]),
    ("COMPRESSION", [
        "volatility_compression", "breakout_readiness",
        "time_since_last_big_move", "stagnation_duration_sec",
    ]),
    ("REGIME & CHAIN", [
        "regime", "chain_pcr_atm", "chain_oi_imbalance_atm", "dead_market_score",
    ]),
    ("ATM OPTION (0 strike)", [
        "opt_0_ce_ltp", "opt_0_ce_bid_ask_imbalance",
        "opt_0_pe_ltp", "opt_0_pe_bid_ask_imbalance",
    ]),
    ("CALL SETUP", [
        # Direction
        "underlying_momentum",
        "underlying_velocity",
        "underlying_tick_imbalance_20",
        # Order flow
        "underlying_ofi_5",
        "underlying_ofi_20",
        # ATM call health
        "opt_0_ce_ltp",
        "opt_0_ce_bid_ask_imbalance",
        "opt_m1_ce_bid_ask_imbalance",
        # Chain
        "chain_pcr_atm",
        "chain_oi_imbalance_atm",
        # Regime & breakout
        "regime",
        "volatility_compression",
        "breakout_readiness",
    ]),
    ("TARGETS", [
        "max_upside_30s", "max_drawdown_30s", "direction_30s",
        "max_upside_60s", "max_drawdown_60s", "direction_60s",
        "upside_percentile_30s",
    ]),
]

_DIRECTION_KEYS = {"direction_30s", "direction_60s"}

# ── Helpers ───────────────────────────────────────────────────────────────────

def fmt_val(k, v):
    if v is None:
        return "—"
    if k == "timestamp":
        try:
            return datetime.fromtimestamp(v, tz=_IST).strftime("%H:%M:%S.%f")[:-3]
        except Exception:
            return str(v)
    if isinstance(v, float):
        if abs(v) >= 100_000:
            return f"{v:,.0f}"
        if abs(v) >= 1_000:
            return f"{v:.1f}"
        return f"{v:.4f}"
    return str(v)


def direction_arrow(v):
    if v == 1:  return "UP"
    if v == -1: return "DOWN"
    return "FLAT"


def clear():
    os.system("cls" if os.name == "nt" else "clear")


# ── Call setup signal interpretation ─────────────────────────────────────────
# Each entry: (field, label, bull_fn)
# bull_fn(v) → +1 (BULL), -1 (BEAR), 0 (NEUTRAL)

def _sign(v, thresh=0.0):
    if v is None or (isinstance(v, float) and v != v):  # nan
        return 0
    return 1 if v > thresh else (-1 if v < -thresh else 0)

_CALL_SIGNALS = [
    # field                         display label                  bull = ...
    ("underlying_momentum",         "Momentum",                    lambda v: _sign(v, 0.05)),
    ("underlying_velocity",         "Velocity",                    lambda v: _sign(v, 0.05)),
    ("underlying_tick_imbalance_20","Tick imbalance (20)",         lambda v: _sign(v, 0.1)),
    ("underlying_ofi_5",            "OFI short (5)",               lambda v: _sign(v, 0.0)),
    ("underlying_ofi_20",           "OFI medium (20)",             lambda v: _sign(v, 0.0)),
    ("opt_0_ce_bid_ask_imbalance",  "ATM call bid/ask imbal",      lambda v: _sign(v, 0.1)),
    ("opt_m1_ce_bid_ask_imbalance", "ITM call bid/ask imbal",      lambda v: _sign(v, 0.1)),
    ("chain_pcr_atm",               "PCR ATM  (< 0.8 = bull)",     lambda v: (1 if v is not None and v < 0.8 else (-1 if v is not None and v > 1.2 else 0))),
    ("chain_oi_imbalance_atm",      "OI imbalance ATM",            lambda v: _sign(v, 0.05)),
    ("regime",                      "Regime",                      lambda v: (1 if v == "TRENDING" else (-1 if v == "DEAD" else 0))),
    ("volatility_compression",      "Vol compression (> 0.6)",     lambda v: (1 if v is not None and v > 0.6 else 0)),
    ("breakout_readiness",          "Breakout readiness (> 0.6)",  lambda v: (1 if v is not None and v > 0.6 else 0)),
]

def _signal_str(sig: int, v) -> str:
    val = fmt_val("", v)
    if sig == 1:
        return f"{val:<12}  BULL"
    if sig == -1:
        return f"{val:<12}  BEAR"
    return f"{val:<12}  --"


def print_call_setup(row):
    bull = bear = neutral = 0
    lines = []
    for field, label, fn in _CALL_SIGNALS:
        v   = row.get(field)
        sig = fn(v)
        if sig == 1:   bull    += 1
        elif sig == -1: bear   += 1
        else:           neutral += 1
        lines.append((label, v, sig))

    total = bull + bear
    score = f"{bull}/{total}" if total else "0/0"
    bar_w = 20
    filled = int(bull / total * bar_w) if total else 0
    bar = "[" + "#" * filled + "-" * (bar_w - filled) + "]"

    print(f"\n  [CALL SETUP]  score: {score} bull  {bar}")
    print(f"  {'':2}  BULL={bull}  BEAR={bear}  NEUTRAL={neutral}")
    print()
    for label, v, sig in lines:
        print(f"    {label:<36}  {_signal_str(sig, v)}")

    # ATM call LTP for reference
    ce_ltp = row.get("opt_0_ce_ltp")
    pe_ltp = row.get("opt_0_pe_ltp")
    print(f"\n    {'ATM call LTP':<36}  {fmt_val('', ce_ltp)}")
    print(f"    {'ATM put  LTP':<36}  {fmt_val('', pe_ltp)}")


def print_summary(row):
    for group_name, keys in GROUPS:
        if group_name == "CALL SETUP":
            print_call_setup(row)
            continue
        print(f"\n  [{group_name}]")
        for k in keys:
            v = row.get(k)
            if k in _DIRECTION_KEYS:
                disp = direction_arrow(v)
            else:
                disp = fmt_val(k, v)
            print(f"    {k:<42} {disp}")


def print_full(row):
    """Print all columns grouped by prefix."""
    # Collect all keys in insertion order
    all_keys = list(row.keys())

    # Group by prefix for readability
    sections: dict[str, list] = {}
    for k in all_keys:
        prefix = k.split("_")[0] if "_" in k else k
        sections.setdefault(prefix, []).append(k)

    col = 0
    LINE_W = 48

    for prefix, keys in sections.items():
        print(f"\n  [{prefix.upper()}]")
        for k in keys:
            v = row.get(k)
            disp = direction_arrow(v) if k in _DIRECTION_KEYS else fmt_val(k, v)
            print(f"    {k:<42} {disp}")


# ── Main loop ─────────────────────────────────────────────────────────────────

last_row  = None
row_count = 0
_prev_ltp = None

mode_label = "FULL (370 cols)" if full_mode else "SUMMARY  [--full for all cols]"

while True:
    try:
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                lines = f.readlines()
            if lines:
                row_count = len(lines)
                last_row  = json.loads(lines[-1])
    except Exception:
        pass

    clear()
    now_ist = datetime.now(_IST).strftime("%H:%M:%S IST")
    print(f"  TFA Live — {instrument.upper()}   [{now_ist}]   rows: {row_count}   mode: {mode_label}")
    print("  " + "─" * 64)

    if last_row is None:
        print("\n  Waiting for first feature row …\n")
    else:
        ltp = last_row.get("spot_price") or 0
        if _prev_ltp is not None and ltp != _prev_ltp:
            arrow = "▲" if ltp > _prev_ltp else "▼"
            print(f"\n  spot: {ltp}  {arrow}  (prev: {_prev_ltp})")
        else:
            print(f"\n  spot: {ltp}")
        _prev_ltp = ltp

        if full_mode:
            print_full(last_row)
        else:
            print_summary(last_row)

    print()
    print("  Press Ctrl+C to exit.")
    time.sleep(interval)