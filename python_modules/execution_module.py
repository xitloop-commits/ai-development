#!/usr/bin/env python3
"""
Execution Module v3
-------------------
Reads enhanced AI decisions, manages paper/live trades via the Broker Service
REST API, monitors SL/TP exits, and pushes position updates to the dashboard.

All order placement and security lookups now go through the Broker Service
abstraction layer instead of calling Dhan directly.

Endpoints used:
  GET  /api/broker/token/status              — Validate auth
  POST /api/broker/orders                    — Place order
  GET  /api/broker/positions                 — Get positions
  GET  /api/broker/scrip-master/lookup       — Lookup security ID
  POST /api/broker/kill-switch               — Emergency kill switch
  GET  /api/trading/active-instruments       — Poll dashboard
  POST /api/trpc/discipline.validate         — Pre-trade discipline check
  POST /api/trpc/discipline.onTradePlaced    — Post-entry notification
  POST /api/trpc/discipline.onTradeClosed    — Post-exit notification
  POST /api/trpc/capital.state               — Get current capital state

Supports both the enhanced AI format (trade_direction, trade_setup) and
legacy format (decision, trade_type) for backward compatibility.
"""

import env_loader  # noqa: F401 — load .env from project root

import json
import os
import time
import sys
from datetime import datetime

import requests

# --- Configuration ---

# Broker Service base URL (same server)
BROKER_URL = os.environ.get("BROKER_URL", "http://localhost:3000").strip()

# Dashboard URL for active instruments polling and position push
DASHBOARD_URL = os.environ.get("DASHBOARD_URL", "http://localhost:3000").strip()

DATA_DIR = os.path.dirname(os.path.abspath(__file__))

# Trading mode: False = paper trading, True = live trading
LIVE_TRADING = os.environ.get("LIVE_TRADING", "false").lower() == "true"

# Default quantity per instrument
DEFAULT_QUANTITIES = {
    "NIFTY_50": 75,       # 1 lot NIFTY options
    "BANKNIFTY": 30,      # 1 lot BANKNIFTY options
    "CRUDEOIL": 100,      # 1 lot CRUDEOIL options
    "NATURALGAS": 1250,   # 1 lot NATURALGAS options
}

# Minimum confidence to take a trade (local fallback; Discipline Engine is primary gate)
MIN_CONFIDENCE = 0.40

# Minimum risk:reward ratio (local fallback; Discipline Engine is primary gate)
MIN_RISK_REWARD = 1.0

# Capital workspace for tRPC queries
CAPITAL_WORKSPACE = os.environ.get("CAPITAL_WORKSPACE", "paper").strip()

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


# --- Broker Service Helpers ---

def check_broker_auth():
    """Validate the broker token via the Broker Service REST API."""
    url = f"{BROKER_URL}/api/broker/token/status"
    try:
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success") and data.get("data", {}).get("valid"):
                return True
            else:
                msg = data.get("data", {}).get("message", "Unknown")
                log(f"Broker token invalid: {msg}")
                return False
        elif resp.status_code == 503:
            log("Broker service not ready (no active adapter).")
            return False
        else:
            log(f"Token status check failed: HTTP {resp.status_code}")
            return False
    except requests.exceptions.ConnectionError:
        log(f"Cannot connect to broker service at {BROKER_URL}.")
        return False
    except Exception as e:
        log(f"Error checking broker auth: {e}")
        return False


def find_option_security_id(instrument, expiry_date, strike_price, option_type):
    """
    Find the security_id for an option contract via the Broker Service
    scrip master lookup endpoint.
    """
    sm_symbol = SYMBOL_MAP.get(instrument)
    if not sm_symbol:
        return None

    exchange = "NSE" if instrument in ("NIFTY_50", "BANKNIFTY") else "MCX"

    url = f"{BROKER_URL}/api/broker/scrip-master/lookup"
    params = {
        "symbol": sm_symbol,
        "expiry": expiry_date,
        "strike": strike_price,
        "optionType": option_type,
        "exchange": exchange,
    }

    try:
        resp = requests.get(url, params=params, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success") and data.get("data"):
                security_id = data["data"]["securityId"]
                log(f"  [LOOKUP] {sm_symbol} {expiry_date} {strike_price} {option_type} -> {security_id}")
                return str(security_id)
        elif resp.status_code == 404:
            log(f"  [LOOKUP] No match: {sm_symbol} {expiry_date} {strike_price} {option_type}")
        elif resp.status_code == 501:
            log(f"  [LOOKUP] Scrip master not supported by active adapter")
        else:
            log(f"  [LOOKUP] HTTP {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        log(f"  [LOOKUP] Error: {e}")
    return None


def place_broker_order(instrument, transaction_type, security_id, quantity):
    """
    Place an order via the Broker Service REST API.
    Uses the unified /api/broker/orders endpoint.
    """
    exchange_segment = EXCHANGE_MAP.get(instrument, "NSE_FNO")
    ts = datetime.now().strftime("%Y%m%d%H%M%S%f")
    correlation_id = f"TRD-{instrument[:5]}-{transaction_type[:3]}-{ts}"

    payload = {
        "instrument": {
            "securityId": str(security_id),
            "exchange": exchange_segment,
            "tradingSymbol": f"{SYMBOL_MAP.get(instrument, instrument)}-{security_id}",
        },
        "transactionType": transaction_type,
        "productType": "INTRADAY",
        "orderType": "MARKET",
        "validity": "DAY",
        "quantity": quantity,
        "correlationId": correlation_id,
    }

    url = f"{BROKER_URL}/api/broker/orders"
    log(f"  Placing {transaction_type} order via Broker Service (Security: {security_id}, Qty: {quantity})...")

    try:
        resp = requests.post(url, json=payload, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success") and data.get("data"):
                order_data = data["data"]
                order_id = order_data.get("orderId")
                order_status = order_data.get("status", "UNKNOWN")
                log(f"  Order Response: orderId={order_id}, status={order_status}")
                return order_id, order_status
            else:
                error = data.get("error", "Unknown error")
                log(f"  Order rejected: {error}")
                return None, "REJECTED"
        elif resp.status_code == 403:
            log(f"  Order blocked: Kill switch is active.")
            return None, "BLOCKED"
        elif resp.status_code == 503:
            log(f"  Order failed: No active broker adapter.")
            return None, "NO_BROKER"
        else:
            log(f"  Order failed: HTTP {resp.status_code} - {resp.text[:200]}")
            return None, "FAILED"
    except Exception as e:
        log(f"  Order exception: {e}")
        return None, "FAILED"


# --- Dashboard Helpers ---

def get_active_instruments():
    """Polls the dashboard to get the list of active instruments."""
    try:
        resp = requests.get(
            f"{DASHBOARD_URL}/api/trading/active-instruments", timeout=3
        )
        if resp.status_code == 200:
            data = resp.json()
            return set(data.get("instruments", []))
    except Exception:
        pass
    return set(INSTRUMENTS)


def load_json(filepath):
    """Load a JSON file safely."""
    try:
        with open(filepath, "r") as f:
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
    Get the current last_price for a specific strike and option type
    from option chain data.
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
            timeout=5,
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
            timeout=3,
        )
    except Exception:
        pass


# --- Discipline Engine Helpers ---

def get_capital_state():
    """
    Fetch current capital state via tRPC.
    Returns (currentCapital, currentExposure) or (None, None) on failure.
    """
    url = f"{DASHBOARD_URL}/api/trpc/capital.state"
    try:
        resp = requests.get(
            url,
            params={"input": json.dumps({"json": {"workspace": CAPITAL_WORKSPACE}})},
            timeout=5,
        )
        if resp.status_code == 200:
            data = resp.json()
            result = data.get("result", {}).get("data", {}).get("json", {})
            trading_pool = result.get("tradingPool", 0)
            open_margin = result.get("openPositionMargin", 0)
            return trading_pool, open_margin
    except Exception as e:
        log(f"  [DISCIPLINE] Failed to fetch capital state: {e}")
    return None, None


def check_discipline_engine(instrument, option_type, strike, entry_price, quantity, confidence, risk_reward, stop_loss, target_price):
    """
    Call the Discipline Engine pre-trade validation via tRPC.
    Returns (allowed, blocked_by, warnings) or (True, [], []) if the engine is unreachable
    (fail-open to avoid blocking trades when the server is down).
    """
    current_capital, current_exposure = get_capital_state()
    if current_capital is None:
        log("  [DISCIPLINE] Capital state unavailable. Skipping discipline check (fail-open).")
        return True, [], []

    exchange = "NSE" if instrument in ("NIFTY_50", "BANKNIFTY") else "MCX"
    estimated_value = entry_price * quantity

    payload = {
        "json": {
            "instrument": instrument,
            "exchange": exchange,
            "transactionType": "BUY",
            "optionType": option_type,
            "strike": float(strike),
            "entryPrice": float(entry_price),
            "quantity": int(quantity),
            "estimatedValue": float(estimated_value),
            "aiConfidence": float(confidence),
            "aiRiskReward": float(risk_reward),
            "emotionalState": "calm",
            "planAligned": True,
            "checklistDone": True,
            "stopLoss": float(stop_loss) if stop_loss else None,
            "target": float(target_price) if target_price else None,
            "currentCapital": float(current_capital),
            "currentExposure": float(current_exposure),
        }
    }

    url = f"{DASHBOARD_URL}/api/trpc/discipline.validate"
    try:
        resp = requests.post(url, json=payload, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            result = data.get("result", {}).get("data", {}).get("json", {})
            allowed = result.get("allowed", True)
            blocked_by = result.get("blockedBy", [])
            warnings = result.get("warnings", [])

            if not allowed:
                log(f"  [DISCIPLINE] Trade BLOCKED by: {', '.join(blocked_by)}")
            if warnings:
                log(f"  [DISCIPLINE] Warnings: {', '.join(warnings)}")

            return allowed, blocked_by, warnings
        else:
            log(f"  [DISCIPLINE] HTTP {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        log(f"  [DISCIPLINE] Validation error: {e}")

    # Fail-open: if discipline engine is unreachable, allow the trade
    log("  [DISCIPLINE] Engine unreachable. Allowing trade (fail-open).")
    return True, [], []


def notify_trade_placed():
    """
    Notify the Discipline Engine that a trade was placed.
    Increments trade counters and open position count.
    """
    url = f"{DASHBOARD_URL}/api/trpc/discipline.onTradePlaced"
    try:
        resp = requests.post(url, json={"json": {}}, timeout=5)
        if resp.status_code == 200:
            log("  [DISCIPLINE] Trade placed notification sent.")
        else:
            log(f"  [DISCIPLINE] onTradePlaced failed: HTTP {resp.status_code}")
    except Exception as e:
        log(f"  [DISCIPLINE] onTradePlaced error: {e}")


def notify_trade_closed(pnl, trade_id=None):
    """
    Notify the Discipline Engine that a trade was closed.
    Updates P&L, cooldowns, and streak tracking.
    """
    current_capital, _ = get_capital_state()
    if current_capital is None:
        log("  [DISCIPLINE] Capital state unavailable. Skipping onTradeClosed.")
        return

    payload = {
        "json": {
            "pnl": float(pnl),
            "openCapital": float(current_capital),
        }
    }
    if trade_id:
        payload["json"]["tradeId"] = trade_id

    url = f"{DASHBOARD_URL}/api/trpc/discipline.onTradeClosed"
    try:
        resp = requests.post(url, json=payload, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            result = data.get("result", {}).get("data", {}).get("json", {})
            if result.get("cooldownStarted"):
                log("  [DISCIPLINE] Cooldown started after loss.")
            if result.get("circuitBreakerTriggered"):
                log("  [DISCIPLINE] CIRCUIT BREAKER TRIGGERED — no more trades today.")
        else:
            log(f"  [DISCIPLINE] onTradeClosed failed: HTTP {resp.status_code}")
    except Exception as e:
        log(f"  [DISCIPLINE] onTradeClosed error: {e}")


# --- Parse AI Decision (supports both old and new format) ---

def parse_ai_decision(decision):
    """
    Parse the AI decision and extract trade parameters.
    Supports both enhanced format (trade_direction, trade_setup) and
    legacy format (decision, trade_type).
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
        result["option_type"] = trade_setup.get(
            "option_type", "CE" if trade_direction == "GO_CALL" else "PE"
        )
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

    # --- Discipline Engine Pre-Trade Check ---
    allowed, blocked_by, warnings = check_discipline_engine(
        instrument=instrument,
        option_type=option_type,
        strike=strike,
        entry_price=entry_price,
        quantity=quantity,
        confidence=parsed["confidence"],
        risk_reward=parsed["risk_reward"],
        stop_loss=stop_loss,
        target_price=target_price,
    )
    if not allowed:
        log(f"    Discipline Engine blocked trade for {instrument}: {', '.join(blocked_by)}")
        return False

    pos_id = next_position_id()
    pos_type = "CALL_BUY" if direction == "GO_CALL" else "PUT_BUY"

    log("")
    log(f"  ╔══════════════════════════════════════════════════════════╗")
    log(f"  ║  NEW ENTRY: {instrument}")
    log(f"  ║  Direction: {direction} | {option_type} {strike}")
    log(f"  ║  Entry: {entry_price:.2f} | Target: {target_price:.2f} | SL: {stop_loss:.2f}")
    log(f"  ║  Quantity: {quantity} | Confidence: {parsed['confidence']*100:.0f}%")
    log(f"  ║  R:R = 1:{parsed['risk_reward']}")
    log(f"  ╚══════════════════════════════════════════════════════════╝")

    if LIVE_TRADING:
        # Find security ID via Broker Service and place order
        expiry_date = parsed["expiry_date"] or get_expiry_date(oc)
        if expiry_date:
            security_id = find_option_security_id(instrument, expiry_date, strike, option_type)
            if security_id:
                order_id, order_status = place_broker_order(
                    instrument, "BUY", security_id, quantity
                )
                if order_status not in ("TRADED", "TRANSIT", "PENDING"):
                    log(f"    Order not accepted. Status: {order_status}. Skipping position tracking.")
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

    # Notify Discipline Engine of new trade
    notify_trade_placed()

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
        option_type = position.get(
            "option_type", "CE" if position["type"] == "CALL_BUY" else "PE"
        )

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
            log("")
            log(f"  ╔══════════════════════════════════════════════════════════╗")
            log(f"  ║  STOP LOSS HIT: {instrument}")
            log(f"  ║  {option_type} {strike} | Entry: {entry_price:.2f} → Exit: {current_price:.2f}")
            log(f"  ║  P&L: {pnl:.2f} ({pnl_pct:+.1f}%)")
            log(f"  ╚══════════════════════════════════════════════════════════╝")

        # Check Target Profit
        elif current_price >= tp_price:
            exit_reason = "TARGET_PROFIT"
            log("")
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
                # Place sell order via Broker Service to close
                expiry_date = get_expiry_date(option_chains.get(instrument))
                if expiry_date:
                    security_id = find_option_security_id(
                        instrument, expiry_date, strike, option_type
                    )
                    if security_id:
                        place_broker_order(
                            instrument, "SELL", security_id, position["quantity"]
                        )
            else:
                log(f"  *** PAPER TRADE: Simulated exit at {current_price:.2f} ***")

            # Notify Discipline Engine of trade closure
            notify_trade_closed(
                pnl=round(pnl, 2),
                trade_id=str(position["id"]),
            )

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
    log("Execution Module v3 — Broker Service Mode")
    log(f"Broker URL: {BROKER_URL}")
    log(f"Dashboard URL: {DASHBOARD_URL}")
    log(f"Trading Mode: {'LIVE' if LIVE_TRADING else 'PAPER'}")
    log(f"Min Confidence: {MIN_CONFIDENCE*100:.0f}%")
    log(f"Min Risk:Reward: 1:{MIN_RISK_REWARD}")
    log(f"Instruments: {INSTRUMENTS}")
    log("=" * 60)

    # Step 1: Wait for broker service to be ready (only needed for live trading)
    if LIVE_TRADING:
        log("Waiting for broker service to be ready...")
        while True:
            if check_broker_auth():
                log("Broker service authenticated. Starting execution loop.")
                break
            log("Retrying in 10 seconds...")
            time.sleep(10)
    else:
        log("Paper trading mode — broker auth not required.")

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
                trade_dir = decision.get(
                    "trade_direction", decision.get("decision", "WAIT")
                )
                conf = decision.get("confidence_score", 0)
                log(f"  {instrument}: {trade_dir} ({conf*100:.0f}%)")

                # Try entry if we don't have an open position
                if (
                    instrument not in OPEN_POSITIONS
                    or OPEN_POSITIONS[instrument]["status"] != "OPEN"
                ):
                    try_entry(instrument, decision, oc)
                else:
                    pos = OPEN_POSITIONS[instrument]
                    log(
                        f"    Position open: {pos['type']} {pos['strike']} | "
                        f"Entry: {pos['entryPrice']} | Current: {pos['currentPrice']} | "
                        f"P&L: {pos['pnl']:+.2f} ({pos['pnlPercent']:+.1f}%)"
                    )
            else:
                log(f"  {instrument}: No AI decision available")

        # Monitor all open positions (including for instruments that might have been disabled)
        monitor_positions(option_chains)

        # Send heartbeat
        open_count = sum(1 for p in OPEN_POSITIONS.values() if p["status"] == "OPEN")
        closed_count = sum(
            1 for p in OPEN_POSITIONS.values() if p["status"] == "CLOSED"
        )
        mode = "live" if LIVE_TRADING else "paper"
        send_heartbeat(f"{open_count} open, {closed_count} closed ({mode})")

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
            log(
                f"  {instrument}: {pos['type']} {pos['strike']} | "
                f"Status: {status} | P&L: {pnl:+.2f} | Exit: {reason}"
            )
        sys.exit(0)
