#!/usr/bin/env python3
"""
Execution Module v2
-------------------
Reads enhanced AI decisions, manages paper/live trades with real option prices,
monitors SL/TP exits, and pushes position updates to the dashboard.

Supports both the enhanced AI format (trade_direction, trade_setup) and
legacy format (decision, trade_type) for backward compatibility.
"""

import json
import os
import time
import sys
import requests
import pandas as pd
from datetime import datetime

# --- Configuration ---
CLIENT_ID = "1101615161"
ACCESS_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzc0MzE4MjEwLCJpYXQiOjE3NzQyMzE4MTAsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTAxNjE1MTYxIn0.AQbyCLWX9HC-eLr5WLhpdjIn8a5ADiSox5hpIBalegzTDyzXjp0_zn9iDvhhWkqgH_z-rlWqQLosQlpGppqexg"

BASE_URL = "https://api.dhan.co/v2"
DATA_DIR = os.path.dirname(os.path.abspath(__file__))

# Dashboard URL for active instruments polling and position push
DASHBOARD_URL = os.environ.get('DASHBOARD_URL', 'http://localhost:3000').strip()

# Trading mode: False = paper trading, True = live trading
LIVE_TRADING = False

# Default quantity per instrument
DEFAULT_QUANTITIES = {
    "NIFTY_50": 75,      # 1 lot NIFTY options
    "BANKNIFTY": 30,     # 1 lot BANKNIFTY options
    "CRUDEOIL": 100,     # 1 lot CRUDEOIL options
    "NATURALGAS": 1250,  # 1 lot NATURALGAS options
}

# Minimum confidence to take a trade
MIN_CONFIDENCE = 0.40

# Minimum risk:reward ratio
MIN_RISK_REWARD = 1.0

# Scrip master for looking up option security IDs
SCRIP_MASTER_PATH = os.path.join(DATA_DIR, "dhan_scrip_master.csv")
SCRIP_MASTER_DF = None

# Headers for Dhan API
HEADERS = {
    "access-token": ACCESS_TOKEN,
    "client-id": CLIENT_ID,
    "Content-Type": "application/json",
    "Accept": "application/json"
}

# Instrument key mapping (dashboard uses underscores, files use underscores in lowercase)
INSTRUMENTS = ["NIFTY_50", "BANKNIFTY", "CRUDEOIL", "NATURALGAS"]

# Map instrument keys to scrip master symbol names
SYMBOL_MAP = {
    "NIFTY_50": "NIFTY",
    "BANKNIFTY": "BANKNIFTY",
    "CRUDEOIL": "CRUDEOIL",
    "NATURALGAS": "NATURALGAS",
}

EXCHANGE_MAP = {
    "NIFTY_50": "NSE_FNO",
    "BANKNIFTY": "NSE_FNO",
    "CRUDEOIL": "MCX_COMM",
    "NATURALGAS": "MCX_COMM",
}

# --- Global State ---
# Track open positions: {instrument: position_dict}
OPEN_POSITIONS = {}

# Track position ID counter
position_id_counter = 0


def log(message):
    """Custom logging with timestamp."""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {message}")
    sys.stdout.flush()


def get_active_instruments():
    """Polls the dashboard to get the list of active instruments."""
    try:
        resp = requests.get(f"{DASHBOARD_URL}/api/trading/active-instruments", timeout=3)
        if resp.status_code == 200:
            data = resp.json()
            return set(data.get("instruments", []))
    except Exception:
        pass
    return set(INSTRUMENTS)


def load_json(filepath):
    """Load a JSON file safely."""
    try:
        with open(filepath, 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def load_ai_decision(instrument):
    """Load the latest AI decision for an instrument."""
    filepath = os.path.join(DATA_DIR, f"ai_decision_{instrument.lower()}.json")
    return load_json(filepath)


def load_option_chain(instrument):
    """Load the latest option chain data for an instrument."""
    filepath = os.path.join(DATA_DIR, f"option_chain_{instrument.lower()}.json")
    return load_json(filepath)


def get_option_price(oc, strike, option_type):
    """
    Get the current last_price for a specific strike and option type from option chain data.
    option_type: 'CE' or 'PE'
    """
    if not oc or "oc" not in oc:
        return 0

    oc_data = oc["oc"]
    strike_str = str(int(strike))

    # Try exact match first
    if strike_str in oc_data:
        strike_data = oc_data[strike_str]
        side = "ce" if option_type == "CE" else "pe"
        if side in strike_data and strike_data[side]:
            return strike_data[side].get("last_price", 0)

    # Try float key format
    strike_float = f"{float(strike)}"
    if strike_float in oc_data:
        strike_data = oc_data[strike_float]
        side = "ce" if option_type == "CE" else "pe"
        if side in strike_data and strike_data[side]:
            return strike_data[side].get("last_price", 0)

    return 0


def get_expiry_date(oc):
    """Extract the expiry date from option chain data."""
    if oc and "expiry_date" in oc:
        return oc["expiry_date"]
    if oc and "target_expiry_date" in oc:
        return oc["target_expiry_date"]
    return None


def next_position_id():
    """Generate a unique position ID."""
    global position_id_counter
    position_id_counter += 1
    ts = datetime.now().strftime("%Y%m%d%H%M%S")
    return f"POS-{ts}-{position_id_counter}"


def push_position_to_dashboard(position_data):
    """Push a position update to the dashboard."""
    try:
        resp = requests.post(
            f"{DASHBOARD_URL}/api/trading/position",
            json={"position": position_data},
            timeout=5
        )
        if resp.status_code == 200:
            log(f"  [DASHBOARD] Position pushed: {position_data['id']} ({position_data['status']})")
            return True
        else:
            log(f"  [DASHBOARD] Push failed: HTTP {resp.status_code}")
            return False
    except Exception as e:
        log(f"  [DASHBOARD] Push error: {e}")
        return False


def send_heartbeat(message):
    """Send executor heartbeat to dashboard."""
    try:
        requests.post(
            f"{DASHBOARD_URL}/api/trading/heartbeat",
            json={"module": "EXECUTOR", "message": message},
            timeout=3
        )
    except Exception:
        pass


def load_scrip_master():
    """Load the scrip master CSV for security ID lookup."""
    global SCRIP_MASTER_DF
    if SCRIP_MASTER_DF is None:
        log(f"Loading scrip master from {SCRIP_MASTER_PATH}...")
        try:
            SCRIP_MASTER_DF = pd.read_csv(SCRIP_MASTER_PATH)
            log(f"Scrip master loaded: {len(SCRIP_MASTER_DF)} records")
        except Exception as e:
            log(f"Error loading scrip master: {e}")
            SCRIP_MASTER_DF = pd.DataFrame()
    return SCRIP_MASTER_DF


def find_option_security_id(instrument, expiry_date, strike_price, option_type):
    """Find the security_id for an option contract from the scrip master."""
    scrip_df = load_scrip_master()
    if scrip_df.empty:
        return None

    sm_symbol = SYMBOL_MAP.get(instrument)
    if not sm_symbol:
        return None

    try:
        target_expiry_dt = datetime.strptime(expiry_date, "%Y-%m-%d")
        filtered = scrip_df[
            (scrip_df["SM_SYMBOL_NAME"] == sm_symbol) &
            (pd.to_datetime(scrip_df["SEM_EXPIRY_DATE"]).dt.date == target_expiry_dt.date()) &
            (scrip_df["SEM_STRIKE_PRICE"] == strike_price) &
            (scrip_df["SEM_OPTION_TYPE"] == option_type)
        ]
        if not filtered.empty:
            return str(filtered.iloc[0]["SEM_SMST_SECURITY_ID"])
    except Exception as e:
        log(f"  Error finding security ID: {e}")
    return None


def place_live_order(instrument, trade_type, security_id, quantity):
    """Place a live order via Dhan API."""
    exchange_segment = EXCHANGE_MAP.get(instrument, "NSE_FNO")
    ts = datetime.now().strftime("%Y%m%d%H%M%S%f")
    correlation_id = f"TRD-{instrument[:5]}-{trade_type[:3]}-{ts}"

    payload = {
        "dhanClientId": CLIENT_ID,
        "correlationId": correlation_id,
        "transactionType": trade_type,
        "exchangeSegment": exchange_segment,
        "productType": "INTRADAY",
        "orderType": "MARKET",
        "validity": "DAY",
        "securityId": str(security_id),
        "quantity": str(quantity),
    }

    log(f"  Placing LIVE {trade_type} order (Security: {security_id}, Qty: {quantity})...")
    try:
        response = requests.post(f"{BASE_URL}/orders", headers=HEADERS, json=payload)
        if response.status_code == 200:
            order_data = response.json()
            order_id = order_data.get("orderId")
            order_status = order_data.get("orderStatus")
            log(f"  LIVE Order Response: {order_data}")
            return order_id, order_status
        else:
            log(f"  LIVE Order Failed: {response.status_code} - {response.text}")
            return None, "FAILED"
    except Exception as e:
        log(f"  LIVE Order Exception: {e}")
        return None, "FAILED"


# --- Parse AI Decision (supports both old and new format) ---

def parse_ai_decision(decision):
    """
    Parse the AI decision and extract trade parameters.
    Supports both enhanced format (trade_direction, trade_setup) and
    legacy format (decision, trade_type).
    Returns: dict with keys: should_trade, direction, option_type, strike,
             entry_price, target_price, stop_loss, confidence, risk_reward, rationale
    """
    result = {
        "should_trade": False,
        "direction": "WAIT",
        "option_type": None,
        "strike": None,
        "entry_price": 0,
        "target_price": 0,
        "stop_loss": 0,
        "confidence": 0,
        "risk_reward": 0,
        "rationale": "",
        "expiry_date": None,
    }

    if not decision:
        return result

    # Try enhanced format first
    trade_direction = decision.get("trade_direction")
    trade_setup = decision.get("trade_setup")
    confidence = decision.get("confidence_score", 0)

    if trade_direction and trade_direction in ("GO_CALL", "GO_PUT") and trade_setup:
        result["direction"] = trade_direction
        result["option_type"] = trade_setup.get("option_type", "CE" if trade_direction == "GO_CALL" else "PE")
        result["strike"] = trade_setup.get("strike")
        result["entry_price"] = trade_setup.get("entry_price", 0)
        result["target_price"] = trade_setup.get("target_price", 0)
        result["stop_loss"] = trade_setup.get("stop_loss", 0)
        result["confidence"] = confidence
        result["risk_reward"] = trade_setup.get("risk_reward", 0)
        result["rationale"] = decision.get("rationale", "")
        result["expiry_date"] = decision.get("target_expiry_date")

        # Validate: must have a strike and reasonable prices
        if result["strike"] and result["entry_price"] > 0:
            if result["confidence"] >= MIN_CONFIDENCE:
                if result["risk_reward"] >= MIN_RISK_REWARD:
                    result["should_trade"] = True
                else:
                    log(f"    Risk:Reward {result['risk_reward']} < {MIN_RISK_REWARD} minimum. Skipping.")
            else:
                log(f"    Confidence {result['confidence']*100:.0f}% < {MIN_CONFIDENCE*100:.0f}% minimum. Skipping.")
        else:
            log(f"    Missing strike or entry_price in trade_setup. Skipping.")

        return result

    # Fallback: legacy format
    legacy_decision = decision.get("decision")
    legacy_trade_type = decision.get("trade_type")

    if legacy_decision == "GO" and legacy_trade_type in ("CALL_BUY", "PUT_BUY"):
        result["direction"] = "GO_CALL" if legacy_trade_type == "CALL_BUY" else "GO_PUT"
        result["option_type"] = "CE" if legacy_trade_type == "CALL_BUY" else "PE"
        result["strike"] = decision.get("target_strike")
        result["confidence"] = confidence
        result["rationale"] = decision.get("rationale", "")
        result["expiry_date"] = decision.get("target_expiry_date")

        # Legacy format doesn't have trade_setup prices, so we'll get them from option chain
        if result["strike"] and result["confidence"] >= MIN_CONFIDENCE:
            result["should_trade"] = True

    return result


# --- Entry Logic ---

def try_entry(instrument, decision, oc):
    """
    Attempt to open a new position based on the AI decision.
    Returns True if a position was opened.
    """
    parsed = parse_ai_decision(decision)

    if not parsed["should_trade"]:
        return False

    # Skip if we already have an open position for this instrument
    if instrument in OPEN_POSITIONS and OPEN_POSITIONS[instrument]["status"] == "OPEN":
        log(f"    Already have open position for {instrument}. Skipping entry.")
        return False

    strike = parsed["strike"]
    option_type = parsed["option_type"]
    direction = parsed["direction"]

    # Get real entry price from option chain
    entry_price = parsed["entry_price"]
    if entry_price <= 0 and oc:
        entry_price = get_option_price(oc, strike, option_type)

    if entry_price <= 0:
        log(f"    Cannot determine entry price for {instrument} {strike} {option_type}. Skipping.")
        return False

    # Get target and stop loss
    target_price = parsed["target_price"]
    stop_loss = parsed["stop_loss"]

    # If no target/SL from AI, use default percentages
    if target_price <= 0:
        target_price = entry_price * 1.30  # 30% target
    if stop_loss <= 0:
        stop_loss = entry_price * 0.85  # 15% stop loss

    quantity = DEFAULT_QUANTITIES.get(instrument, 50)
    pos_id = next_position_id()
    pos_type = "CALL_BUY" if direction == "GO_CALL" else "PUT_BUY"

    log(f"")
    log(f"  ╔══════════════════════════════════════════════════════════╗")
    log(f"  ║  NEW ENTRY: {instrument}")
    log(f"  ║  Direction: {direction} | {option_type} {strike}")
    log(f"  ║  Entry: {entry_price:.2f} | Target: {target_price:.2f} | SL: {stop_loss:.2f}")
    log(f"  ║  Quantity: {quantity} | Confidence: {parsed['confidence']*100:.0f}%")
    log(f"  ║  R:R = 1:{parsed['risk_reward']}")
    log(f"  ╚══════════════════════════════════════════════════════════╝")

    if LIVE_TRADING:
        # Find security ID and place live order
        expiry_date = parsed["expiry_date"] or get_expiry_date(oc)
        if expiry_date:
            security_id = find_option_security_id(instrument, expiry_date, strike, option_type)
            if security_id:
                order_id, order_status = place_live_order(instrument, "BUY", security_id, quantity)
                if order_status != "TRADED":
                    log(f"    LIVE order not filled. Status: {order_status}. Skipping position tracking.")
                    return False
            else:
                log(f"    Could not find security ID for {instrument} {expiry_date} {strike} {option_type}")
                return False
        else:
            log(f"    No expiry date available. Cannot place live order.")
            return False
    else:
        log(f"  *** PAPER TRADE: Simulated entry at {entry_price:.2f} ***")

    # Record the position
    position = {
        "id": pos_id,
        "instrument": instrument,
        "type": pos_type,
        "strike": strike,
        "option_type": option_type,
        "entryPrice": round(entry_price, 2),
        "currentPrice": round(entry_price, 2),
        "quantity": quantity,
        "pnl": 0,
        "pnlPercent": 0,
        "slPrice": round(stop_loss, 2),
        "tpPrice": round(target_price, 2),
        "status": "OPEN",
        "entryTime": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "exitTime": None,
        "exitPrice": None,
        "exitReason": None,
    }

    OPEN_POSITIONS[instrument] = position

    # Push to dashboard
    dashboard_position = {
        "id": pos_id,
        "instrument": instrument,
        "type": pos_type,
        "strike": strike,
        "entryPrice": round(entry_price, 2),
        "currentPrice": round(entry_price, 2),
        "quantity": quantity,
        "pnl": 0,
        "pnlPercent": 0,
        "slPrice": round(stop_loss, 2),
        "tpPrice": round(target_price, 2),
        "status": "OPEN",
        "entryTime": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    push_position_to_dashboard(dashboard_position)

    return True


# --- Position Monitoring ---

def monitor_positions(option_chains):
    """
    Check all open positions against current prices.
    Trigger SL/TP exits when hit.
    """
    for instrument, position in list(OPEN_POSITIONS.items()):
        if position["status"] != "OPEN":
            continue

        oc = option_chains.get(instrument)
        if not oc:
            continue

        strike = position["strike"]
        option_type = position.get("option_type", "CE" if position["type"] == "CALL_BUY" else "PE")

        # Get current price from live option chain
        current_price = get_option_price(oc, strike, option_type)
        if current_price <= 0:
            continue

        # Update position with current price
        entry_price = position["entryPrice"]
        pnl_per_unit = current_price - entry_price
        pnl = pnl_per_unit * position["quantity"]
        pnl_pct = (pnl_per_unit / entry_price) * 100 if entry_price > 0 else 0

        position["currentPrice"] = round(current_price, 2)
        position["pnl"] = round(pnl, 2)
        position["pnlPercent"] = round(pnl_pct, 1)

        sl_price = position["slPrice"]
        tp_price = position["tpPrice"]

        exit_reason = None

        # Check Stop Loss
        if current_price <= sl_price:
            exit_reason = "STOP_LOSS"
            log(f"")
            log(f"  ╔══════════════════════════════════════════════════════════╗")
            log(f"  ║  STOP LOSS HIT: {instrument}")
            log(f"  ║  {option_type} {strike} | Entry: {entry_price:.2f} → Exit: {current_price:.2f}")
            log(f"  ║  P&L: {pnl:.2f} ({pnl_pct:+.1f}%)")
            log(f"  ╚══════════════════════════════════════════════════════════╝")

        # Check Target Profit
        elif current_price >= tp_price:
            exit_reason = "TARGET_PROFIT"
            log(f"")
            log(f"  ╔══════════════════════════════════════════════════════════╗")
            log(f"  ║  TARGET HIT: {instrument}")
            log(f"  ║  {option_type} {strike} | Entry: {entry_price:.2f} → Exit: {current_price:.2f}")
            log(f"  ║  P&L: {pnl:.2f} ({pnl_pct:+.1f}%)")
            log(f"  ╚══════════════════════════════════════════════════════════╝")

        if exit_reason:
            # Close the position
            position["status"] = "CLOSED"
            position["exitTime"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            position["exitPrice"] = round(current_price, 2)
            position["exitReason"] = exit_reason

            if LIVE_TRADING:
                # Place sell order to close
                expiry_date = get_expiry_date(option_chains.get(instrument))
                if expiry_date:
                    security_id = find_option_security_id(instrument, expiry_date, strike, option_type)
                    if security_id:
                        place_live_order(instrument, "SELL", security_id, position["quantity"])
            else:
                log(f"  *** PAPER TRADE: Simulated exit at {current_price:.2f} ***")

            # Push closed position to dashboard
            dashboard_position = {
                "id": position["id"],
                "instrument": instrument,
                "type": position["type"],
                "strike": strike,
                "entryPrice": position["entryPrice"],
                "currentPrice": round(current_price, 2),
                "quantity": position["quantity"],
                "pnl": round(pnl, 2),
                "pnlPercent": round(pnl_pct, 1),
                "slPrice": sl_price,
                "tpPrice": tp_price,
                "status": "CLOSED",
                "entryTime": position["entryTime"],
            }
            push_position_to_dashboard(dashboard_position)

        else:
            # Push updated position (with current price) to dashboard every cycle
            dashboard_position = {
                "id": position["id"],
                "instrument": instrument,
                "type": position["type"],
                "strike": strike,
                "entryPrice": position["entryPrice"],
                "currentPrice": round(current_price, 2),
                "quantity": position["quantity"],
                "pnl": round(pnl, 2),
                "pnlPercent": round(pnl_pct, 1),
                "slPrice": sl_price,
                "tpPrice": tp_price,
                "status": "OPEN",
                "entryTime": position["entryTime"],
            }
            push_position_to_dashboard(dashboard_position)


# --- Main Loop ---

def main():
    log("=" * 60)
    log("Execution Module v2 - Starting")
    log(f"Dashboard URL: {DASHBOARD_URL}")
    log(f"Trading Mode: {'LIVE' if LIVE_TRADING else 'PAPER'}")
    log(f"Min Confidence: {MIN_CONFIDENCE*100:.0f}%")
    log(f"Min Risk:Reward: 1:{MIN_RISK_REWARD}")
    log(f"Instruments: {INSTRUMENTS}")
    log("=" * 60)

    load_scrip_master()

    cycle = 0
    while True:
        cycle += 1
        log(f"\n--- Execution Cycle {cycle} at {datetime.now().strftime('%H:%M:%S')} ---")

        active_instruments = get_active_instruments()
        log(f"Active instruments: {list(active_instruments)}")

        # Load all option chains for position monitoring
        option_chains = {}
        for instrument in INSTRUMENTS:
            oc = load_option_chain(instrument)
            if oc:
                option_chains[instrument] = oc

        # Process each active instrument
        for instrument in INSTRUMENTS:
            if instrument not in active_instruments:
                log(f"  SKIPPING {instrument} (disabled)")
                continue

            decision = load_ai_decision(instrument)
            oc = option_chains.get(instrument)

            if decision:
                trade_dir = decision.get("trade_direction", decision.get("decision", "WAIT"))
                conf = decision.get("confidence_score", 0)
                log(f"  {instrument}: {trade_dir} ({conf*100:.0f}%)")

                # Try entry if we don't have an open position
                if instrument not in OPEN_POSITIONS or OPEN_POSITIONS[instrument]["status"] != "OPEN":
                    try_entry(instrument, decision, oc)
                else:
                    pos = OPEN_POSITIONS[instrument]
                    log(f"    Position open: {pos['type']} {pos['strike']} | Entry: {pos['entryPrice']} | Current: {pos['currentPrice']} | P&L: {pos['pnl']:+.2f} ({pos['pnlPercent']:+.1f}%)")
            else:
                log(f"  {instrument}: No AI decision available")

        # Monitor all open positions (including for instruments that might have been disabled)
        monitor_positions(option_chains)

        # Send heartbeat
        open_count = sum(1 for p in OPEN_POSITIONS.values() if p["status"] == "OPEN")
        closed_count = sum(1 for p in OPEN_POSITIONS.values() if p["status"] == "CLOSED")
        send_heartbeat(f"{open_count} open, {closed_count} closed (paper)")

        time.sleep(5)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("Execution Module stopped by user.")
        # Print summary
        log("\n=== SESSION SUMMARY ===")
        for instrument, pos in OPEN_POSITIONS.items():
            status = pos["status"]
            pnl = pos.get("pnl", 0)
            reason = pos.get("exitReason", "N/A")
            log(f"  {instrument}: {pos['type']} {pos['strike']} | Status: {status} | P&L: {pnl:+.2f} | Exit: {reason}")
        sys.exit(0)
