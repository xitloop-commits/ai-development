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

# Phase 3 imports: WebSocket feed + Momentum Engine
try:
    from websocket_feed import TickFeed, get_feed, start_feed
    from momentum_engine import MomentumEngine
    WS_FEED_AVAILABLE = True
except ImportError:
    WS_FEED_AVAILABLE = False
    print("[WARN] websocket_feed / momentum_engine not available. Real-time features disabled.")

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

# --- v2.4 Phase 3 Configuration ---

# Risk Manager: Hard limits
HARD_STOP_LOSS_PCT = -5.0        # -5% from entry
EARLY_EXIT_LOSS_PCT = -2.0       # -2% if momentum weak early
TARGET_PROFIT_PCT = 10.0         # +10% default target

# Profit Exit Engine
PROFIT_PARTIAL_EXIT_PCT = 6.0    # +6% triggers partial exit
PROFIT_FULL_EXIT_PCT = 10.0      # +10% triggers full exit (unless momentum > 70)
PARTIAL_EXIT_FRACTION = 0.5      # Sell 50% on partial exit

# Trade Age Monitor
TRADE_AGE_NO_MOVE_EXIT = 120     # 2 minutes — exit if no move in direction
TRADE_AGE_WEAK_PARTIAL = 300     # 3-5 minutes — partial exit if weak momentum
TRADE_AGE_NO_PROGRESS = 300      # 5 minutes — exit if no progress
TRADE_AGE_FORCE_EXIT = 600       # 10 minutes — force exit regardless

# Adaptive Exit
ADAPTIVE_EXIT_MOMENTUM_FLOOR = 30   # Full exit if momentum drops below this
ADAPTIVE_PARTIAL_MOMENTUM = 50      # Partial exit if momentum below this while in profit

# Pyramiding Engine
PYRAMID_MOMENTUM_THRESHOLD = 70     # Add only if momentum > 70
PYRAMID_ADD_FRACTION = 0.5          # Add 50% of original quantity
PYRAMID_MAX_ADDS = 1                # Maximum number of pyramid additions per position

# Execution Timing Engine
ENTRY_TIMING_TIMEOUT = 300          # 5 minutes to confirm entry conditions
ENTRY_VOLUME_SPIKE_RATIO = 1.5      # 1-min volume must be > 1.5x average
ENTRY_MOMENTUM_THRESHOLD = 50       # Momentum Score must be > 50 to enter

# Profit Orchestrator (Position Sizing)
DAILY_PROFIT_TARGET_PCT = 5.0       # 5% of capital as daily profit target
RISK_MULTIPLIER_MIN = 0.25
RISK_MULTIPLIER_MAX = 1.0

# --- Global State ---
# Track open positions: {instrument: position_dict}
OPEN_POSITIONS = {}

# Track position ID counter
position_id_counter = 0

# WebSocket feed and Momentum Engine instances
_tick_feed = None
_momentum_engine = None

# Pending entries waiting for timing confirmation
# {instrument: {decision, oc, signal_time, ...}}
PENDING_ENTRIES = {}


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


# --- v2.4 Phase 3: Advanced Exit Engines ---

def get_position_age_seconds(position):
    """Calculate how many seconds a position has been open."""
    try:
        entry_time = datetime.strptime(position["entryTime"], "%Y-%m-%d %H:%M:%S")
        return (datetime.now() - entry_time).total_seconds()
    except (ValueError, KeyError):
        return 0


def get_momentum_for_position(position):
    """
    Get the Momentum Score for an open position's security.
    Returns the momentum result dict, or None if unavailable.
    """
    global _momentum_engine, _tick_feed
    if not _momentum_engine or not _tick_feed or not _tick_feed.connected:
        return None

    security_id = position.get("securityId", "")
    if not security_id:
        return None

    direction = "CALL" if position["type"] == "CALL_BUY" else "PUT"
    return _momentum_engine.calculate(security_id, direction)


def check_adaptive_exit(position, momentum_result, pnl_pct):
    """
    Adaptive Exit Engine: Overrides static targets based on real-time conditions.
    Returns (exit_type, reason) or (None, None).

    Rules:
    - If momentum < 30: FULL_EXIT (dying momentum)
    - If momentum < 50 and in profit: PARTIAL_EXIT (weak momentum while profitable)
    """
    if not momentum_result:
        return None, None

    score = momentum_result["score"]

    if score < ADAPTIVE_EXIT_MOMENTUM_FLOOR:
        return "FULL_EXIT", f"ADAPTIVE_EXIT: Momentum {score:.0f} < {ADAPTIVE_EXIT_MOMENTUM_FLOOR} (dying)"

    if score < ADAPTIVE_PARTIAL_MOMENTUM and pnl_pct > 0:
        return "PARTIAL_EXIT", f"ADAPTIVE_EXIT: Momentum {score:.0f} < {ADAPTIVE_PARTIAL_MOMENTUM} while in profit ({pnl_pct:+.1f}%)"

    return None, None


def check_trade_age_exit(position, momentum_result, pnl_pct):
    """
    Trade Age Monitor: Prevents capital from being stuck in dead trades.
    Returns (exit_type, reason) or (None, None).

    Rules:
    - < 2 min: If no move in direction, EXIT
    - 3-5 min: If weak momentum, PARTIAL_EXIT
    - > 5 min: If no progress, EXIT
    - > 10 min: FORCE EXIT regardless
    """
    age = get_position_age_seconds(position)
    momentum_score = momentum_result["score"] if momentum_result else 50

    # Force exit after 10 minutes
    if age >= TRADE_AGE_FORCE_EXIT:
        return "FULL_EXIT", f"TRADE_AGE: Force exit after {age/60:.1f} min (limit: {TRADE_AGE_FORCE_EXIT/60:.0f} min)"

    # No progress after 5 minutes
    if age >= TRADE_AGE_NO_PROGRESS and pnl_pct <= 1.0:
        return "FULL_EXIT", f"TRADE_AGE: No progress after {age/60:.1f} min (P&L: {pnl_pct:+.1f}%)"

    # Weak momentum at 3-5 minutes
    if age >= TRADE_AGE_WEAK_PARTIAL and momentum_score < 50:
        return "PARTIAL_EXIT", f"TRADE_AGE: Weak momentum ({momentum_score:.0f}) at {age/60:.1f} min"

    # No move in direction within 2 minutes
    if age >= TRADE_AGE_NO_MOVE_EXIT and pnl_pct <= 0:
        return "FULL_EXIT", f"TRADE_AGE: No move in direction after {age/60:.1f} min (P&L: {pnl_pct:+.1f}%)"

    return None, None


def check_profit_exit(position, momentum_result, pnl_pct):
    """
    Profit Exit Engine: Manages profit taking dynamically.
    Returns (exit_type, reason) or (None, None).

    Rules:
    - +6% profit: PARTIAL_EXIT (sell 50%)
    - +10% profit: FULL_EXIT (unless Momentum > 70, then HOLD beyond target)
    """
    momentum_score = momentum_result["score"] if momentum_result else 50

    # Check if already partially exited
    already_partial = position.get("partialExitDone", False)

    # +10% profit: full exit unless strong momentum
    if pnl_pct >= PROFIT_FULL_EXIT_PCT:
        if momentum_score > PYRAMID_MOMENTUM_THRESHOLD:
            # Strong momentum — hold beyond target, but tighten SL
            new_sl = position["entryPrice"] * (1 + PROFIT_PARTIAL_EXIT_PCT / 100)
            if position["slPrice"] < new_sl:
                position["slPrice"] = round(new_sl, 2)
                log(f"    [PROFIT_EXIT] Holding beyond +{PROFIT_FULL_EXIT_PCT}% (momentum {momentum_score:.0f}). SL tightened to {new_sl:.2f}")
            return None, None
        return "FULL_EXIT", f"PROFIT_EXIT: +{pnl_pct:.1f}% profit target hit (momentum {momentum_score:.0f} not strong enough to hold)"

    # +6% profit: partial exit (first time only)
    if pnl_pct >= PROFIT_PARTIAL_EXIT_PCT and not already_partial:
        return "PARTIAL_EXIT", f"PROFIT_EXIT: +{pnl_pct:.1f}% partial profit target hit"

    return None, None


def check_risk_manager_exit(position, momentum_result, pnl_pct):
    """
    Risk Manager: Enforces strict capital protection.
    Returns (exit_type, reason) or (None, None).

    Rules:
    - Hard SL: -5% from entry
    - Early exit: -2% if momentum weak early in trade
    """
    age = get_position_age_seconds(position)
    momentum_score = momentum_result["score"] if momentum_result else 50

    # Hard stop loss
    if pnl_pct <= HARD_STOP_LOSS_PCT:
        return "FULL_EXIT", f"RISK_MANAGER: Hard SL hit ({pnl_pct:+.1f}% <= {HARD_STOP_LOSS_PCT}%)"

    # Early exit: -2% with weak momentum in first 2 minutes
    if pnl_pct <= EARLY_EXIT_LOSS_PCT and age < 120 and momentum_score < 50:
        return "FULL_EXIT", f"RISK_MANAGER: Early exit ({pnl_pct:+.1f}%) with weak momentum ({momentum_score:.0f}) at {age:.0f}s"

    return None, None


def execute_partial_exit(instrument, position, option_chains, reason):
    """
    Execute a partial exit: sell PARTIAL_EXIT_FRACTION of the position.
    Updates position quantity in-place.
    """
    exit_qty = max(1, int(position["quantity"] * PARTIAL_EXIT_FRACTION))
    remaining_qty = position["quantity"] - exit_qty

    if remaining_qty <= 0:
        # If partial would close everything, just do a full exit
        return execute_full_exit(instrument, position, option_chains, reason)

    current_price = position["currentPrice"]
    entry_price = position["entryPrice"]
    pnl_partial = (current_price - entry_price) * exit_qty

    log("")
    log(f"  ╔══════════════════════════════════════════════════════════╗")
    log(f"  ║  PARTIAL EXIT: {instrument}")
    log(f"  ║  Selling {exit_qty} of {position['quantity']} | Remaining: {remaining_qty}")
    log(f"  ║  Reason: {reason}")
    log(f"  ║  Partial P&L: {pnl_partial:.2f}")
    log(f"  ╚══════════════════════════════════════════════════════════╝")

    if LIVE_TRADING:
        strike = position["strike"]
        option_type = position.get("option_type", "CE" if position["type"] == "CALL_BUY" else "PE")
        expiry_date = get_expiry_date(option_chains.get(instrument))
        if expiry_date:
            security_id = find_option_security_id(instrument, expiry_date, strike, option_type)
            if security_id:
                place_broker_order(instrument, "SELL", security_id, exit_qty)
    else:
        log(f"  *** PAPER TRADE: Simulated partial exit of {exit_qty} at {current_price:.2f} ***")

    # Update position
    position["quantity"] = remaining_qty
    position["partialExitDone"] = True
    position["partialExitQty"] = position.get("partialExitQty", 0) + exit_qty
    position["partialExitPnl"] = position.get("partialExitPnl", 0) + round(pnl_partial, 2)

    return True


def execute_full_exit(instrument, position, option_chains, reason):
    """
    Execute a full exit: close the entire position.
    """
    current_price = position["currentPrice"]
    entry_price = position["entryPrice"]
    pnl = (current_price - entry_price) * position["quantity"]
    pnl_pct = (current_price - entry_price) / entry_price * 100 if entry_price > 0 else 0

    # Include any partial exit P&L
    total_pnl = pnl + position.get("partialExitPnl", 0)

    log("")
    log(f"  ╔══════════════════════════════════════════════════════════╗")
    log(f"  ║  FULL EXIT: {instrument}")
    log(f"  ║  Reason: {reason}")
    log(f"  ║  Entry: {entry_price:.2f} → Exit: {current_price:.2f}")
    log(f"  ║  P&L: {total_pnl:.2f} ({pnl_pct:+.1f}%)")
    log(f"  ╚══════════════════════════════════════════════════════════╝")

    strike = position["strike"]
    option_type = position.get("option_type", "CE" if position["type"] == "CALL_BUY" else "PE")

    if LIVE_TRADING:
        expiry_date = get_expiry_date(option_chains.get(instrument))
        if expiry_date:
            security_id = find_option_security_id(instrument, expiry_date, strike, option_type)
            if security_id:
                place_broker_order(instrument, "SELL", security_id, position["quantity"])
    else:
        log(f"  *** PAPER TRADE: Simulated full exit at {current_price:.2f} ***")

    # Close the position
    position["status"] = "CLOSED"
    position["exitTime"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    position["exitPrice"] = round(current_price, 2)
    position["exitReason"] = reason

    # Notify Discipline Engine
    notify_trade_closed(
        pnl=round(total_pnl, 2),
        trade_id=str(position["id"]),
    )

    # Push to dashboard
    push_position_to_dashboard({
        "id": position["id"],
        "instrument": instrument,
        "type": position["type"],
        "strike": strike,
        "entryPrice": position["entryPrice"],
        "currentPrice": round(current_price, 2),
        "quantity": position["quantity"],
        "pnl": round(total_pnl, 2),
        "pnlPercent": round(pnl_pct, 1),
        "slPrice": position["slPrice"],
        "tpPrice": position["tpPrice"],
        "status": "CLOSED",
        "entryTime": position["entryTime"],
    })

    return True


# --- v2.4 Phase 3: Pyramiding Engine ---

def check_pyramiding(instrument, position, momentum_result, pnl_pct, option_chains):
    """
    Pyramiding Engine: Adds to winning positions to maximize trends.
    Conditions:
    - Position is in profit
    - Momentum Score > 70
    - Max pyramid additions not reached
    - Never average down on losing positions
    """
    if pnl_pct <= 0:
        return  # Never pyramid on losing positions

    if not momentum_result or momentum_result["score"] < PYRAMID_MOMENTUM_THRESHOLD:
        return

    pyramid_count = position.get("pyramidCount", 0)
    if pyramid_count >= PYRAMID_MAX_ADDS:
        return

    original_qty = position.get("originalQuantity", position["quantity"])
    add_qty = max(1, int(original_qty * PYRAMID_ADD_FRACTION))

    log("")
    log(f"  ╔══════════════════════════════════════════════════════════╗")
    log(f"  ║  PYRAMID ADD: {instrument}")
    log(f"  ║  Adding {add_qty} to existing {position['quantity']}")
    log(f"  ║  Momentum: {momentum_result['score']:.0f} | P&L: {pnl_pct:+.1f}%")
    log(f"  ╚══════════════════════════════════════════════════════════╝")

    if LIVE_TRADING:
        strike = position["strike"]
        option_type = position.get("option_type", "CE" if position["type"] == "CALL_BUY" else "PE")
        expiry_date = get_expiry_date(option_chains.get(instrument))
        if expiry_date:
            security_id = find_option_security_id(instrument, expiry_date, strike, option_type)
            if security_id:
                order_id, order_status = place_broker_order(instrument, "BUY", security_id, add_qty)
                if order_status not in ("TRADED", "TRANSIT", "PENDING"):
                    log(f"    Pyramid order not accepted: {order_status}")
                    return
    else:
        log(f"  *** PAPER TRADE: Simulated pyramid add of {add_qty} at {position['currentPrice']:.2f} ***")

    # Update position: recalculate average entry price
    old_qty = position["quantity"]
    old_entry = position["entryPrice"]
    new_avg_entry = (old_entry * old_qty + position["currentPrice"] * add_qty) / (old_qty + add_qty)

    position["quantity"] = old_qty + add_qty
    position["entryPrice"] = round(new_avg_entry, 2)
    position["pyramidCount"] = pyramid_count + 1
    if "originalQuantity" not in position:
        position["originalQuantity"] = old_qty

    # Recalculate SL/TP based on new entry price
    position["slPrice"] = round(new_avg_entry * (1 + HARD_STOP_LOSS_PCT / 100), 2)
    position["tpPrice"] = round(new_avg_entry * (1 + TARGET_PROFIT_PCT / 100), 2)

    log(f"    New avg entry: {new_avg_entry:.2f} | New qty: {position['quantity']} | New SL: {position['slPrice']:.2f}")


# --- v2.4 Phase 3: Execution Timing Engine ---

def check_entry_timing(instrument, decision, oc):
    """
    Execution Timing Engine: Delays entry until real-time conditions confirm the move.
    Checks:
    1. Breakout/Rejection Candle: 1-min candle closing in trade direction
    2. Volume Spike: 1-min volume > 1.5x intraday average
    3. Momentum Confirmation: Momentum Score > 50

    Returns True if conditions are met, False if still waiting.
    """
    global _momentum_engine, _tick_feed

    if not _tick_feed or not _tick_feed.connected:
        # If no WebSocket feed, skip timing checks (fail-open)
        return True

    trade_setup = decision.get("trade_setup", {})
    security_id = str(trade_setup.get("securityId", ""))
    if not security_id:
        # No security ID available for real-time check — allow entry
        return True

    direction = "CALL" if decision.get("trade_direction") == "GO_CALL" else "PUT"
    conditions_met = 0
    conditions_needed = 2  # Need at least 2 of 3 conditions

    # Check 1: Momentum confirmation
    if _momentum_engine:
        momentum = _momentum_engine.calculate(security_id, direction)
        if momentum["score"] >= ENTRY_MOMENTUM_THRESHOLD:
            conditions_met += 1
            log(f"    [TIMING] Momentum confirmed: {momentum['score']:.0f} >= {ENTRY_MOMENTUM_THRESHOLD}")
        else:
            log(f"    [TIMING] Momentum weak: {momentum['score']:.0f} < {ENTRY_MOMENTUM_THRESHOLD}")

    # Check 2: Volume spike
    history = _tick_feed.get_tick_history(security_id, 60)  # last 60 seconds
    if len(history) >= 2:
        volumes = [h.get("volume", 0) for h in history]
        vol_deltas = [volumes[i] - volumes[i-1] for i in range(1, len(volumes)) if volumes[i] > volumes[i-1]]
        if vol_deltas:
            avg_vol = sum(vol_deltas) / len(vol_deltas)
            recent_vol = vol_deltas[-1] if vol_deltas else 0
            if avg_vol > 0 and recent_vol >= avg_vol * ENTRY_VOLUME_SPIKE_RATIO:
                conditions_met += 1
                log(f"    [TIMING] Volume spike confirmed: {recent_vol:.0f} >= {avg_vol * ENTRY_VOLUME_SPIKE_RATIO:.0f}")
            else:
                log(f"    [TIMING] Volume normal: {recent_vol:.0f} < {avg_vol * ENTRY_VOLUME_SPIKE_RATIO:.0f}")

    # Check 3: Price candle in direction
    if len(history) >= 2:
        first_ltp = history[0].get("ltp", 0)
        last_ltp = history[-1].get("ltp", 0)
        if first_ltp > 0:
            price_move = (last_ltp - first_ltp) / first_ltp * 100
            if direction == "CALL" and price_move > 0.05:
                conditions_met += 1
                log(f"    [TIMING] Bullish candle confirmed: +{price_move:.2f}%")
            elif direction == "PUT" and price_move < -0.05:
                conditions_met += 1
                log(f"    [TIMING] Bearish candle confirmed: {price_move:.2f}%")
            else:
                log(f"    [TIMING] No directional candle: {price_move:+.2f}%")

    confirmed = conditions_met >= conditions_needed
    if confirmed:
        log(f"    [TIMING] Entry confirmed ({conditions_met}/{conditions_needed} conditions met)")
    else:
        log(f"    [TIMING] Entry NOT confirmed ({conditions_met}/{conditions_needed} conditions met)")

    return confirmed


# --- v2.4 Phase 3: Profit Orchestrator (Position Sizing) ---

def calculate_position_size(instrument, entry_price, target_pct):
    """
    Profit Orchestrator: Calculate dynamic position size based on capital and target.
    1. Required Profit = Capital x 5%
    2. Base Quantity = Required Profit / (Entry Price x Target %)
    3. Apply Risk Multiplier from equity curve protection
    4. Final Quantity = floor(Base x Risk Multiplier), min 1 lot
    """
    current_capital, _ = get_capital_state()
    if current_capital is None or current_capital <= 0:
        return DEFAULT_QUANTITIES.get(instrument, 50)

    required_profit = current_capital * (DAILY_PROFIT_TARGET_PCT / 100)

    if entry_price <= 0 or target_pct <= 0:
        return DEFAULT_QUANTITIES.get(instrument, 50)

    base_qty = required_profit / (entry_price * (target_pct / 100))

    # Risk Multiplier: for now use 1.0 (will be adjusted by Feedback Loop in Phase 4)
    risk_multiplier = 1.0
    final_qty = max(1, int(base_qty * risk_multiplier))

    # Ensure at least 1 lot
    min_lot = DEFAULT_QUANTITIES.get(instrument, 1)
    if final_qty < min_lot:
        final_qty = min_lot

    log(f"    [SIZING] Capital: {current_capital:.0f} | Required profit: {required_profit:.0f} | "
        f"Base qty: {base_qty:.1f} | Risk mult: {risk_multiplier} | Final: {final_qty}")

    return final_qty


# --- Position Monitoring (Enhanced with Phase 3 Engines) ---

def monitor_positions(option_chains):
    """
    Enhanced position monitoring with Phase 3 exit engines.
    Priority order:
    1. Risk Manager (hard SL, early exit)
    2. Static SL/TP
    3. Adaptive Exit (momentum-based)
    4. Trade Age Monitor
    5. Profit Exit Engine
    6. Pyramiding check (if no exit triggered)
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

        # Get current price from live option chain (or WebSocket if available)
        current_price = get_option_price(oc, strike, option_type)

        # Try WebSocket tick for more recent price
        if _tick_feed and _tick_feed.connected:
            security_id = position.get("securityId", "")
            if security_id:
                ws_tick = _tick_feed.get_tick(security_id)
                if ws_tick and ws_tick.get("ltp", 0) > 0:
                    current_price = ws_tick["ltp"]

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

        # Get momentum score for this position
        momentum_result = get_momentum_for_position(position)

        # --- Exit Engine Priority Chain ---
        exit_type = None
        exit_reason = None

        # 1. Risk Manager (highest priority)
        exit_type, exit_reason = check_risk_manager_exit(position, momentum_result, pnl_pct)

        # 2. Static SL/TP (if Risk Manager didn't trigger)
        if not exit_type:
            sl_price = position["slPrice"]
            tp_price = position["tpPrice"]
            if current_price <= sl_price:
                exit_type = "FULL_EXIT"
                exit_reason = f"STOP_LOSS: {current_price:.2f} <= {sl_price:.2f}"
            elif current_price >= tp_price:
                exit_type = "FULL_EXIT"
                exit_reason = f"TARGET_PROFIT: {current_price:.2f} >= {tp_price:.2f}"

        # 3. Adaptive Exit
        if not exit_type:
            exit_type, exit_reason = check_adaptive_exit(position, momentum_result, pnl_pct)

        # 4. Trade Age Monitor
        if not exit_type:
            exit_type, exit_reason = check_trade_age_exit(position, momentum_result, pnl_pct)

        # 5. Profit Exit Engine
        if not exit_type:
            exit_type, exit_reason = check_profit_exit(position, momentum_result, pnl_pct)

        # Execute exit if triggered
        if exit_type == "FULL_EXIT":
            execute_full_exit(instrument, position, option_chains, exit_reason)
        elif exit_type == "PARTIAL_EXIT":
            execute_partial_exit(instrument, position, option_chains, exit_reason)
        else:
            # No exit — check pyramiding opportunity
            check_pyramiding(instrument, position, momentum_result, pnl_pct, option_chains)

            # Push updated position to dashboard
            push_position_to_dashboard({
                "id": position["id"],
                "instrument": instrument,
                "type": position["type"],
                "strike": strike,
                "entryPrice": position["entryPrice"],
                "currentPrice": round(current_price, 2),
                "quantity": position["quantity"],
                "pnl": round(pnl, 2),
                "pnlPercent": round(pnl_pct, 1),
                "slPrice": position["slPrice"],
                "tpPrice": position["tpPrice"],
                "status": "OPEN",
                "entryTime": position["entryTime"],
                "momentum": momentum_result["score"] if momentum_result else None,
                "momentumAction": momentum_result["action"] if momentum_result else None,
            })


# --- Main Loop ---

def process_pending_entries(option_chains):
    """
    Process pending entries that are waiting for Execution Timing confirmation.
    Entries expire after ENTRY_TIMING_TIMEOUT seconds.
    """
    expired = []
    for instrument, pending in list(PENDING_ENTRIES.items()):
        age = time.time() - pending["signal_time"]

        if age > ENTRY_TIMING_TIMEOUT:
            log(f"    [TIMING] Signal expired for {instrument} after {age:.0f}s")
            expired.append(instrument)
            continue

        decision = pending["decision"]
        oc = option_chains.get(instrument, pending.get("oc"))

        if check_entry_timing(instrument, decision, oc):
            log(f"    [TIMING] Entry conditions met for {instrument}. Executing...")
            try_entry(instrument, decision, oc)
            expired.append(instrument)

    for instrument in expired:
        PENDING_ENTRIES.pop(instrument, None)


def main():
    global _tick_feed, _momentum_engine

    log("=" * 60)
    log("Execution Module v4 — Phase 3 Real-Time Execution")
    log(f"Broker URL: {BROKER_URL}")
    log(f"Dashboard URL: {DASHBOARD_URL}")
    log(f"Trading Mode: {'LIVE' if LIVE_TRADING else 'PAPER'}")
    log(f"WebSocket Feed: {'Available' if WS_FEED_AVAILABLE else 'Not available'}")
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

    # Step 2: Start WebSocket feed and Momentum Engine
    if WS_FEED_AVAILABLE:
        try:
            _tick_feed = start_feed()
            _momentum_engine = MomentumEngine(_tick_feed)
            log("WebSocket feed and Momentum Engine initialized.")
            # Give feed a moment to connect
            time.sleep(2)
            if _tick_feed.connected:
                log(f"WebSocket connected. {_tick_feed.store.count} instruments in store.")
            else:
                log("WebSocket not yet connected. Will retry in background.")
        except Exception as e:
            log(f"Failed to start WebSocket feed: {e}. Continuing without real-time data.")
            _tick_feed = None
            _momentum_engine = None
    else:
        log("Real-time features disabled (websocket_feed/momentum_engine not available).")

    cycle = 0
    while True:
        cycle += 1
        log(f"\n--- Execution Cycle {cycle} at {datetime.now().strftime('%H:%M:%S')} ---")

        # Log WebSocket status periodically
        if _tick_feed and cycle % 10 == 1:
            status = _tick_feed.get_status()
            log(f"  [WS] Connected: {status['connected']} | Ticks: {status['tick_count']} | Instruments: {status['subscribed_instruments']}")

        active_instruments = get_active_instruments()
        log(f"Active instruments: {list(active_instruments)}")

        # Load all option chains for position monitoring
        option_chains = {}
        for instrument in INSTRUMENTS:
            oc = load_option_chain(instrument)
            if oc:
                option_chains[instrument] = oc

        # Process pending entries (Execution Timing Engine)
        if PENDING_ENTRIES:
            process_pending_entries(option_chains)

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
                    # Check if already pending
                    if instrument in PENDING_ENTRIES:
                        log(f"    Already pending entry for {instrument}")
                    elif trade_dir in ("GO_CALL", "GO_PUT"):
                        # Use Execution Timing Engine if WebSocket is available
                        if _tick_feed and _tick_feed.connected:
                            if check_entry_timing(instrument, decision, oc):
                                try_entry(instrument, decision, oc)
                            else:
                                # Queue for timing confirmation
                                PENDING_ENTRIES[instrument] = {
                                    "decision": decision,
                                    "oc": oc,
                                    "signal_time": time.time(),
                                }
                                log(f"    [TIMING] Entry queued for {instrument}. Waiting for confirmation...")
                        else:
                            # No WebSocket — enter immediately (fail-open)
                            try_entry(instrument, decision, oc)
                else:
                    pos = OPEN_POSITIONS[instrument]
                    momentum_info = ""
                    if _momentum_engine and pos.get("securityId"):
                        direction = "CALL" if pos["type"] == "CALL_BUY" else "PUT"
                        m = _momentum_engine.calculate(pos["securityId"], direction)
                        momentum_info = f" | Momentum: {m['score']:.0f} ({m['action']})"
                    log(
                        f"    Position open: {pos['type']} {pos['strike']} | "
                        f"Entry: {pos['entryPrice']} | Current: {pos['currentPrice']} | "
                        f"P&L: {pos['pnl']:+.2f} ({pos['pnlPercent']:+.1f}%){momentum_info}"
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
        pending_count = len(PENDING_ENTRIES)
        mode = "live" if LIVE_TRADING else "paper"
        ws_status = "ws:ok" if (_tick_feed and _tick_feed.connected) else "ws:off"
        send_heartbeat(f"{open_count} open, {closed_count} closed, {pending_count} pending ({mode}, {ws_status})")

        time.sleep(5)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("Execution Module stopped by user.")
        # Stop WebSocket feed
        if _tick_feed:
            try:
                from websocket_feed import stop_feed
                stop_feed()
            except Exception:
                pass
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
