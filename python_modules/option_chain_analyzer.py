
import json
import os
import time
import sys
import requests
from datetime import datetime

# --- Configuration ---
INSTRUMENTS = [
    "NIFTY_50",
    "BANKNIFTY",
    "CRUDEOIL",
    "NATURALGAS"
]

DATA_DIR = os.path.dirname(__file__)

# Dashboard URL for active instruments polling
DASHBOARD_URL = os.environ.get('DASHBOARD_URL', 'http://localhost:3000').strip()

def get_active_instruments():
    """Polls the dashboard to get the list of active instruments.
    Falls back to all instruments if the dashboard is unreachable."""
    try:
        resp = requests.get(f"{DASHBOARD_URL}/api/trading/active-instruments", timeout=3)
        if resp.status_code == 200:
            data = resp.json()
            return set(data.get("instruments", []))
    except Exception:
        pass
    # Fallback: process all instruments if dashboard is unreachable
    return set(INSTRUMENTS)

# Stores previous option chain data for comparison
previous_option_chain_data = {}

# --- Opening OI Snapshot ---
# Stores the first option chain data of the day (captured at ~9:15 AM for NSE, ~9:00 AM for MCX)
# Key: instrument_name, Value: {"date": "YYYY-MM-DD", "data": option_chain_data, "captured_at": "HH:MM:SS"}
opening_oi_snapshots = {}

# Opening snapshot file path for persistence across restarts
OPENING_SNAPSHOT_DIR = os.path.join(DATA_DIR, "opening_snapshots")
os.makedirs(OPENING_SNAPSHOT_DIR, exist_ok=True)

def get_market_open_time(instrument):
    """Returns the market open hour for the instrument."""
    if instrument in ("CRUDEOIL", "NATURALGAS"):
        return 9  # MCX opens at 9:00 AM
    return 9  # NSE opens at 9:15 AM

def load_opening_snapshot(instrument):
    """Load today's opening snapshot from disk if available."""
    today = datetime.now().strftime("%Y-%m-%d")
    filepath = os.path.join(OPENING_SNAPSHOT_DIR, f"opening_{instrument.lower()}_{today}.json")
    if os.path.exists(filepath):
        try:
            with open(filepath, 'r') as f:
                snapshot = json.load(f)
            if snapshot.get("date") == today:
                return snapshot
        except Exception:
            pass
    return None

def save_opening_snapshot(instrument, data):
    """Save opening snapshot to disk for persistence."""
    today = datetime.now().strftime("%Y-%m-%d")
    captured_at = datetime.now().strftime("%H:%M:%S")
    snapshot = {
        "date": today,
        "captured_at": captured_at,
        "last_price": data.get("last_price", 0),
        "data": data
    }
    filepath = os.path.join(OPENING_SNAPSHOT_DIR, f"opening_{instrument.lower()}_{today}.json")
    with open(filepath, 'w') as f:
        json.dump(snapshot, f)
    opening_oi_snapshots[instrument] = snapshot
    print(f"  [Opening Snapshot] Captured for {instrument} at {captured_at} (LTP: {data.get('last_price', 0)})")
    return snapshot

def capture_opening_snapshot_if_needed(instrument, current_data):
    """Capture the opening OI snapshot if it's the first data of the day.
    Returns the snapshot (existing or newly captured)."""
    today = datetime.now().strftime("%Y-%m-%d")
    
    # Check in-memory cache first
    if instrument in opening_oi_snapshots:
        cached = opening_oi_snapshots[instrument]
        if cached.get("date") == today:
            return cached
    
    # Check disk
    disk_snapshot = load_opening_snapshot(instrument)
    if disk_snapshot:
        opening_oi_snapshots[instrument] = disk_snapshot
        return disk_snapshot
    
    # No snapshot for today — capture now
    now = datetime.now()
    market_open = get_market_open_time(instrument)
    
    # Only capture if we're within market hours (9 AM to 4 PM IST)
    if 9 <= now.hour <= 16:
        return save_opening_snapshot(instrument, current_data)
    
    return None

def compute_intraday_oi_changes(current_data, opening_snapshot, support_levels, resistance_levels, current_ltp):
    """Compute intraday OI changes at S/R levels compared to opening snapshot.
    Returns a list of sr_level dicts with opening_oi, current_oi, intraday_change, etc."""
    sr_levels = []
    
    if not opening_snapshot or "data" not in opening_snapshot:
        return sr_levels
    
    opening_data = opening_snapshot["data"]
    opening_oc = opening_data.get("oc", {})
    current_oc = current_data.get("oc", {})
    
    # Combine all S/R levels with their types
    all_levels = []
    for level in support_levels:
        all_levels.append((level, "support"))
    for level in resistance_levels:
        all_levels.append((level, "resistance"))
    
    # Add ATM strike
    # Find nearest strike to current LTP
    all_strikes = sorted([float(s) for s in current_oc.keys()])
    atm_strike = None
    if all_strikes and current_ltp > 0:
        atm_strike = min(all_strikes, key=lambda s: abs(s - current_ltp))
        # Only add ATM if not already in support/resistance
        if atm_strike not in support_levels and atm_strike not in resistance_levels:
            all_levels.append((atm_strike, "atm"))
    
    for level, level_type in all_levels:
        strike_str = f"{level:.6f}"
        
        # Get opening OI
        opening_ce_oi = opening_oc.get(strike_str, {}).get("ce", {}).get("oi", 0)
        opening_pe_oi = opening_oc.get(strike_str, {}).get("pe", {}).get("oi", 0)
        
        # Get current OI
        current_ce_oi = current_oc.get(strike_str, {}).get("ce", {}).get("oi", 0)
        current_pe_oi = current_oc.get(strike_str, {}).get("pe", {}).get("oi", 0)
        
        # Compute intraday changes
        ce_intraday_change = current_ce_oi - opening_ce_oi
        pe_intraday_change = current_pe_oi - opening_pe_oi
        
        # Compute percentage changes
        ce_change_pct = (ce_intraday_change / opening_ce_oi * 100) if opening_ce_oi > 0 else 0
        pe_change_pct = (pe_intraday_change / opening_pe_oi * 100) if opening_pe_oi > 0 else 0
        
        # Determine activity labels
        ce_activity = classify_oi_activity(ce_intraday_change, ce_change_pct, "call")
        pe_activity = classify_oi_activity(pe_intraday_change, pe_change_pct, "put")
        
        # Determine wall strength (0-100 scale based on OI relative to max)
        # This will be normalized later
        relevant_oi = current_pe_oi if level_type == "support" else current_ce_oi
        
        sr_level = {
            "strike": level,
            "type": level_type,
            "call_oi": current_ce_oi,
            "put_oi": current_pe_oi,
            "opening_call_oi": opening_ce_oi,
            "opening_put_oi": opening_pe_oi,
            "call_oi_intraday_change": ce_intraday_change,
            "put_oi_intraday_change": pe_intraday_change,
            "call_change_pct": round(ce_change_pct, 1),
            "put_change_pct": round(pe_change_pct, 1),
            "call_activity": ce_activity,
            "put_activity": pe_activity,
            "relevant_oi": relevant_oi,
            "is_atm": level == atm_strike,
        }
        sr_levels.append(sr_level)
    
    # Normalize wall strength (0-100 based on max relevant OI)
    max_oi = max((s["relevant_oi"] for s in sr_levels), default=1) or 1
    for s in sr_levels:
        s["wall_strength"] = round(s["relevant_oi"] / max_oi * 100)
    
    return sr_levels

def classify_oi_activity(oi_change, change_pct, option_type):
    """Classify OI activity into human-readable labels.
    option_type: 'call' or 'put'"""
    if abs(change_pct) < 2:
        return "Holding Steady"
    
    if option_type == "call":
        if oi_change > 0 and change_pct > 10:
            return "Heavy Call Writing"  # Resistance strengthening
        elif oi_change > 0:
            return "Sellers Entering"  # Mild resistance buildup
        elif oi_change < 0 and change_pct < -10:
            return "Short Covering"  # Resistance weakening fast
        elif oi_change < 0:
            return "Sellers Exiting"  # Mild resistance weakening
    else:  # put
        if oi_change > 0 and change_pct > 10:
            return "Heavy Put Writing"  # Support strengthening
        elif oi_change > 0:
            return "Sellers Entering"  # Mild support buildup
        elif oi_change < 0 and change_pct < -10:
            return "Short Covering"  # Support weakening fast
        elif oi_change < 0:
            return "Sellers Exiting"  # Mild support weakening
    
    return "Holding Steady"

def load_option_chain_data(instrument_name):
    """Loads the latest option chain data for a given instrument from a JSON file."""
    filepath = os.path.join(DATA_DIR, f"option_chain_{instrument_name.lower()}.json")
    if os.path.exists(filepath):
        try:
            with open(filepath, 'r') as f:
                content = f.read().strip()
                if not content:
                    print(f"  [WARNING] Option chain file is empty: {filepath}")
                    return None
                return json.loads(content)
        except json.JSONDecodeError as e:
            print(f"  [ERROR] Invalid JSON in option chain {filepath}: {e}")
            return None
        except Exception as e:
            print(f"  [ERROR] Failed to read option chain {filepath}: {e}")
            return None
    else:
        print(f"  [WARNING] Option chain file not found: {filepath}")
    return None

def get_option_metrics(option_data, previous_option_data):
    """Helper to get OI, OI Change, Volume, Volume Change for an option type."""
    current_oi = option_data.get("oi", 0)
    previous_oi = previous_option_data.get("oi", 0)
    oi_change = current_oi - previous_oi
    current_volume = option_data.get("volume", 0)
    previous_volume = previous_option_data.get("previous_volume", 0) # Assuming previous_volume is available
    volume_change = current_volume - previous_volume
    return current_oi, oi_change, current_volume, volume_change

def identify_active_strikes(current_data, previous_data, top_n=3, volume_threshold_multiplier=1.5):
    """Identifies active strikes based on high OI, high OI Change, and high Volume."""
    active_strikes = {"call": [], "put": []}
    if not current_data or "oc" not in current_data or not previous_data or "oc" not in previous_data:
        return active_strikes

    strikes_data = current_data["oc"]
    previous_strikes_data = previous_data["oc"]

    call_oi_list = [] # (strike, oi)
    call_oi_change_list = [] # (strike, oi_change)
    call_volume_list = [] # (strike, volume)

    put_oi_list = [] # (strike, oi)
    put_oi_change_list = [] # (strike, oi_change)
    put_volume_list = [] # (strike, volume)

    for strike_str, data in strikes_data.items():
        strike_price = float(strike_str)
        prev_data = previous_strikes_data.get(strike_str, {})

        if "ce" in data and data["ce"] and "oi" in data["ce"]:
            current_oi, oi_change, current_volume, _ = get_option_metrics(data["ce"], prev_data.get("ce", {}))
            call_oi_list.append((strike_price, current_oi))
            call_oi_change_list.append((strike_price, oi_change))
            call_volume_list.append((strike_price, current_volume))

        if "pe" in data and data["pe"] and "oi" in data["pe"]:
            current_oi, oi_change, current_volume, _ = get_option_metrics(data["pe"], prev_data.get("pe", {}))
            put_oi_list.append((strike_price, current_oi))
            put_oi_change_list.append((strike_price, oi_change))
            put_volume_list.append((strike_price, current_volume))

    # Sort and get top N for each category
    call_oi_list.sort(key=lambda x: x[1], reverse=True)
    call_oi_change_list.sort(key=lambda x: abs(x[1]), reverse=True)
    call_volume_list.sort(key=lambda x: x[1], reverse=True)

    put_oi_list.sort(key=lambda x: x[1], reverse=True)
    put_oi_change_list.sort(key=lambda x: abs(x[1]), reverse=True)
    put_volume_list.sort(key=lambda x: x[1], reverse=True)

    top_call_oi_strikes = {s[0] for s in call_oi_list[:top_n]}
    top_call_oi_change_strikes = {s[0] for s in call_oi_change_list[:top_n]}
    top_call_volume_strikes = {s[0] for s in call_volume_list[:top_n]}

    top_put_oi_strikes = {s[0] for s in put_oi_list[:top_n]}
    top_put_oi_change_strikes = {s[0] for s in put_oi_change_list[:top_n]}
    top_put_volume_strikes = {s[0] for s in put_volume_list[:top_n]}

    # Active Call Strikes: intersection of top OI, OI Change, and Volume
    active_call_strikes_set = top_call_oi_strikes.intersection(top_call_oi_change_strikes).intersection(top_call_volume_strikes)
    active_strikes["call"] = sorted(list(active_call_strikes_set))

    # Active Put Strikes: intersection of top OI, OI Change, and Volume
    active_put_strikes_set = top_put_oi_strikes.intersection(top_put_oi_change_strikes).intersection(top_put_volume_strikes)
    active_strikes["put"] = sorted(list(active_put_strikes_set))

    return active_strikes

def identify_support_resistance(current_data, previous_data, current_ltp, top_n=5):
    """Identifies top N support and resistance levels based on Open Interest and OI Change, prioritizing proximity to LTP."""
    main_resistance = None
    main_support = None
    support_levels = []
    resistance_levels = []

    if not current_data or "oc" not in current_data:
        return main_support, main_resistance, support_levels, resistance_levels

    strikes_data = current_data["oc"]
    previous_strikes_data = previous_data["oc"] if previous_data and "oc" in previous_data else {}

    put_oi_info = [] # (strike, oi, oi_change, distance_from_ltp)
    call_oi_info = [] # (strike, oi, oi_change, distance_from_ltp)

    for strike_str, data in strikes_data.items():
        strike_price = float(strike_str)
        distance_from_ltp = abs(strike_price - current_ltp)
        prev_data = previous_strikes_data.get(strike_str, {})

        # Process Put Options for Support
        if "pe" in data and data["pe"]:
            current_oi, oi_change, _, _ = get_option_metrics(data["pe"], prev_data.get("pe", {}))
            put_oi_info.append((strike_price, current_oi, oi_change, distance_from_ltp))

        # Process Call Options for Resistance
        if "ce" in data and data["ce"]:
            current_oi, oi_change, _, _ = get_option_metrics(data["ce"], prev_data.get("ce", {}))
            call_oi_info.append((strike_price, current_oi, oi_change, distance_from_ltp))

    # Sort for Main Resistance (Highest Call OI)
    if call_oi_info:
        main_resistance = max(call_oi_info, key=lambda x: x[1])[0]

    # Sort for Main Support (Highest Put OI)
    if put_oi_info:
        main_support = max(put_oi_info, key=lambda x: x[1])[0]

    # Sort for Top N Support: prioritize by OI, then OI Change, then proximity to LTP
    put_oi_info.sort(key=lambda x: (x[1], x[2], -x[3]), reverse=True)
    support_levels = sorted([s[0] for s in put_oi_info[:top_n]])

    # Sort for Top N Resistance: prioritize by OI, then OI Change, then proximity to LTP
    call_oi_info.sort(key=lambda x: (x[1], x[2], -x[3]), reverse=True)
    resistance_levels = sorted([r[0] for r in call_oi_info[:top_n]])

    return main_support, main_resistance, support_levels, resistance_levels

def identify_market_bias(current_data):
    """Identifies overall market bias based on Call vs Put OI."""
    total_call_oi = 0
    total_put_oi = 0

    if not current_data or "oc" not in current_data:
        return "Neutral"

    for strike_str, data in current_data["oc"].items():
        if "ce" in data and data["ce"] and "oi" in data["ce"]:
            total_call_oi += data["ce"]["oi"]
        if "pe" in data and data["pe"] and "oi" in data["pe"]:
            total_put_oi += data["pe"]["oi"]

    if total_call_oi > total_put_oi * 1.2: # Arbitrary threshold for 'significantly higher'
        return "Bearish"
    elif total_put_oi > total_call_oi * 1.2:
        return "Bullish"
    else:
        return "Range-bound"

def analyze_signals(current_data, previous_data):
    """Analyzes option chain data to generate trading signals based on Price, OI, and Volume changes."""
    signals = []

    if not previous_data or "oc" not in previous_data or "oc" not in current_data:
        return signals

    current_ltp = current_data.get("last_price", 0)
    previous_ltp = previous_data.get("last_price", 0)

    price_change = current_ltp - previous_ltp
    price_up = price_change > 0
    price_down = price_change < 0

    call_long_buildup_strikes = []
    put_short_buildup_strikes = []

    for strike_str, current_strike_data in current_data["oc"].items():
        previous_strike_data = previous_data["oc"].get(strike_str, {})
        strike_price = float(strike_str)

        current_ce_oi, ce_oi_change, current_ce_volume, ce_volume_change = get_option_metrics(current_strike_data.get("ce", {}), previous_strike_data.get("ce", {}))
        current_pe_oi, pe_oi_change, current_pe_volume, pe_volume_change = get_option_metrics(current_strike_data.get("pe", {}), previous_strike_data.get("pe", {}))

        # Call Side Signals
        if ce_oi_change > 0 and price_up: # Price ↑, OI ↑
            signals.append(f"Call Long Buildup at {strike_str} (OI Change: {ce_oi_change}, Price Change: {price_change:.2f})")
            call_long_buildup_strikes.append(strike_str)
        elif ce_oi_change > 0 and price_down: # Price ↓, OI ↑
            signals.append(f"Call Short Buildup at {strike_str} (OI Change: {ce_oi_change}, Price Change: {price_change:.2f})")
        elif ce_oi_change < 0 and price_up: # Price ↑, OI ↓
            signals.append(f"Call Short Covering at {strike_str} (OI Change: {ce_oi_change}, Price Change: {price_change:.2f})")
        elif ce_oi_change < 0 and price_down: # Price ↓, OI ↓
            signals.append(f"Call Long Unwinding at {strike_str} (OI Change: {ce_oi_change}, Price Change: {price_change:.2f})")

        # Put Side Signals
        if pe_oi_change > 0 and price_up: # Price ↑, OI ↑ (Put Short Buildup)
            signals.append(f"Put Short Buildup at {strike_str} (OI Change: {pe_oi_change}, Price Change: {price_change:.2f})")
            put_short_buildup_strikes.append(strike_str)
        elif pe_oi_change > 0 and price_down: # Price ↓, OI ↑ (Put Long Buildup)
            signals.append(f"Put Long Buildup at {strike_str} (OI Change: {pe_oi_change}, Price Change: {price_change:.2f})")
        elif pe_oi_change < 0 and price_down: # Price ↓, OI ↓ (Put Short Covering)
            signals.append(f"Put Short Covering at {strike_str} (OI Change: {pe_oi_change}, Price Change: {price_change:.2f})")
        elif pe_oi_change < 0 and price_up: # Price ↑, OI ↓ (Put Long Unwinding)
            signals.append(f"Put Long Unwinding at {strike_str} (OI Change: {pe_oi_change}, Price Change: {price_change:.2f})")

        # Call Writing (Resistance Creation)
        if ce_oi_change > 0 and abs(strike_price - current_ltp) / current_ltp < 0.005: # Price near strike (0.5% threshold)
            signals.append(f"Call Writing (Resistance Creation) at {strike_str} (OI Change: {ce_oi_change})")

        # Put Writing (Support Creation)
        if pe_oi_change > 0 and abs(strike_price - current_ltp) / current_ltp < 0.005: # Price near strike (0.5% threshold)
            signals.append(f"Put Writing (Support Creation) at {strike_str} (OI Change: {pe_oi_change})")

    # Trap Situation (Danger Zone)
    for strike in call_long_buildup_strikes:
        if strike in put_short_buildup_strikes:
            signals.append(f"Trap Situation (Danger Zone) at {strike}")

    return signals

def assess_sr_strength(current_data, previous_data, support_levels, resistance_levels):
    """Assesses the strengthening or weakening of S&R levels."""
    sr_strength_signals = []

    if not previous_data or "oc" not in previous_data or "oc" not in current_data:
        return sr_strength_signals

    for level in support_levels:
        strike_str = f"{level:.6f}" # Ensure strike format matches JSON keys
        current_pe_oi = current_data["oc"].get(strike_str, {}).get("pe", {}).get("oi", 0)
        previous_pe_oi = previous_data["oc"].get(strike_str, {}).get("pe", {}).get("oi", 0)
        oi_change = current_pe_oi - previous_pe_oi

        if oi_change > 0:
            sr_strength_signals.append(f"Support at {level} is strengthening (Put OI increased by {oi_change})")
        elif oi_change < 0:
            sr_strength_signals.append(f"Support at {level} is weakening (Put OI decreased by {oi_change})")

    for level in resistance_levels:
        strike_str = f"{level:.6f}"
        current_ce_oi = current_data["oc"].get(strike_str, {}).get("ce", {}).get("oi", 0)
        previous_ce_oi = previous_data["oc"].get(strike_str, {}).get("ce", {}).get("oi", 0)
        oi_change = current_ce_oi - previous_ce_oi

        if oi_change > 0:
            sr_strength_signals.append(f"Resistance at {level} is strengthening (Call OI increased by {oi_change})")
        elif oi_change < 0:
            sr_strength_signals.append(f"Resistance at {level} is weakening (Call OI decreased by {oi_change})")

    return sr_strength_signals

def analyze_entry_strategy(current_data, previous_data, current_ltp, main_support, main_resistance):
    """Analyzes entry strategy signals based on user-defined rules."""
    entry_signals = []

    if not previous_data or "oc" not in previous_data or "oc" not in current_data:
        return entry_signals

    # Helper to check if price is near a level
    def is_price_near_level(price, level, threshold_percent=0.005):
        return abs(price - level) / level < threshold_percent

    # CALL BUY ENTRY (Bullish Trade)
    # Conditions: Price near support AND Put OI strong or increasing AND Call OI decreasing (writers exiting) AND Price starts bouncing AND Volume spike.
    # Best Confirmation: Short covering in calls OR Put writing increasing.
    if main_support and is_price_near_level(current_ltp, main_support):
        # Check Put OI increasing (strong support)
        total_put_oi_change = sum([get_option_metrics(current_data["oc"].get(s, {}).get("pe", {}), previous_data["oc"].get(s, {}).get("pe", {}))[1] for s in current_data["oc"] if "pe" in current_data["oc"].get(s, {})])
        # Check Call OI decreasing (writers exiting)
        total_call_oi_change = sum([get_option_metrics(current_data["oc"].get(s, {}).get("ce", {}), previous_data["oc"].get(s, {}).get("ce", {}))[1] for s in current_data["oc"] if "ce" in current_data["oc"].get(s, {})])

        # Simplified check for 
        # Simplified check for Put OI increasing and Call OI decreasing
        if total_put_oi_change > 0 and total_call_oi_change < 0:
            # Need to check for price bouncing and volume spike - this requires more sophisticated price action analysis
            # For now, we'll signal based on OI changes near support
            entry_signals.append(f"CALL BUY Entry Signal: Price near Support {main_support}, Put OI increasing ({total_put_oi_change}), Call OI decreasing ({total_call_oi_change})")

    # PUT BUY ENTRY (Bearish Trade)
    # Conditions: Price near resistance AND Call OI strong or increasing AND Put OI decreasing AND Price rejecting AND Volume spike.
    # Best Confirmation: Call writing increasing OR Put unwinding.
    if main_resistance and is_price_near_level(current_ltp, main_resistance):
        # Check Call OI increasing (strong resistance)
        total_call_oi_change = sum([get_option_metrics(current_data["oc"].get(s, {}).get("ce", {}), previous_data["oc"].get(s, {}).get("ce", {}))[1] for s in current_data["oc"] if "ce" in current_data["oc"].get(s, {})])
        # Check Put OI decreasing
        total_put_oi_change = sum([get_option_metrics(current_data["oc"].get(s, {}).get("pe", {}), previous_data["oc"].get(s, {}).get("pe", {}))[1] for s in current_data["oc"] if "pe" in current_data["oc"].get(s, {})])

        # Simplified check for Call OI increasing and Put OI decreasing
        if total_call_oi_change > 0 and total_put_oi_change < 0:
            # Need to check for price rejecting and volume spike
            # For now, we'll signal based on OI changes near resistance
            entry_signals.append(f"PUT BUY Entry Signal: Price near Resistance {main_resistance}, Call OI increasing ({total_call_oi_change}), Put OI decreasing ({total_put_oi_change})")

    return entry_signals

def analyze_real_time_signals(current_data, previous_data, current_ltp, main_support, main_resistance):
    """Analyzes real-time signals for strong breakouts/breakdowns."""
    real_time_signals = []

    if not previous_data or "oc" not in previous_data or "oc" not in current_data:
        return real_time_signals

    # Helper to check if price is breaking a level (simplified: current_ltp crosses the level)
    def is_price_breaking_resistance(price, resistance_level):
        return price > resistance_level

    def is_price_breaking_support(price, support_level):
        return price < support_level

    # STRONG BULLISH BREAKOUT
    # Conditions: Resistance Call OI suddenly ↓ AND Put OI ↑ AND Price breaking resistance.
    if main_resistance and is_price_breaking_resistance(current_ltp, main_resistance):
        # Check if Call OI at main_resistance is decreasing significantly
        ce_oi_change_at_resistance = get_option_metrics(current_data["oc"].get(f"{main_resistance:.6f}", {}).get("ce", {}), previous_data["oc"].get(f"{main_resistance:.6f}", {}).get("ce", {}))[1]
        # Check if Put OI (overall) is increasing
        total_put_oi_change = sum([get_option_metrics(current_data["oc"].get(s, {}).get("pe", {}), previous_data["oc"].get(s, {}).get("pe", {}))[1] for s in current_data["oc"] if "pe" in current_data["oc"].get(s, {})])

        if ce_oi_change_at_resistance < 0 and total_put_oi_change > 0:
            real_time_signals.append(f"STRONG BULLISH BREAKOUT: Price breaking Resistance {main_resistance}, Call OI at resistance decreasing ({ce_oi_change_at_resistance}), Overall Put OI increasing ({total_put_oi_change})")

    # STRONG BEARISH BREAKDOWN
    # Conditions: Support Put OI ↓ AND Call OI ↑ AND Price breaking support.
    if main_support and is_price_breaking_support(current_ltp, main_support):
        # Check if Put OI at main_support is decreasing significantly
        pe_oi_change_at_support = get_option_metrics(current_data["oc"].get(f"{main_support:.6f}", {}).get("pe", {}), previous_data["oc"].get(f"{main_support:.6f}", {}).get("pe", {}))[1]
        # Check if Call OI (overall) is increasing
        total_call_oi_change = sum([get_option_metrics(current_data["oc"].get(s, {}).get("ce", {}), previous_data["oc"].get(s, {}).get("ce", {}))[1] for s in current_data["oc"] if "ce" in current_data["oc"].get(s, {})])

        if pe_oi_change_at_support < 0 and total_call_oi_change > 0:
            real_time_signals.append(f"STRONG BEARISH BREAKDOWN: Price breaking Support {main_support}, Put OI at support decreasing ({pe_oi_change_at_support}), Overall Call OI increasing ({total_call_oi_change})")

    return real_time_signals

def analyze_exit_strategy(current_data, previous_data):
    """Analyzes exit strategy signals."""
    exit_signals = []

    if not previous_data or "oc" not in previous_data or "oc" not in current_data:
        return exit_signals

    # Simplified checks for exit conditions
    # Opposite side OI starts increasing (This is a complex check, simplifying for now)
    # OI Change flips (Requires tracking previous OI change direction)
    # Volume drops (Requires tracking volume change)
    # Price stuck (no momentum) (Requires price action analysis)

    # For now, we'll focus on a simplified 'opposite side OI starts increasing' for a general exit signal
    # This would need to be more specific to an active trade (e.g., if long call, check put OI increasing)

    # Example: If overall Put OI starts increasing significantly after a bullish signal
    total_put_oi_change = sum([get_option_metrics(current_data["oc"].get(s, {}).get("pe", {}), previous_data["oc"].get(s, {}).get("pe", {}))[1] for s in current_data["oc"] if "pe" in current_data["oc"].get(s, {})])
    total_call_oi_change = sum([get_option_metrics(current_data["oc"].get(s, {}).get("ce", {}), previous_data["oc"].get(s, {}).get("ce", {}))[1] for s in current_data["oc"] if "ce" in current_data["oc"].get(s, {})])

    if total_put_oi_change > 0 and total_call_oi_change < 0: # Put OI increasing, Call OI decreasing
        exit_signals.append("Potential Exit Signal: Put OI increasing, Call OI decreasing (Bearish shift)")
    elif total_call_oi_change > 0 and total_put_oi_change < 0: # Call OI increasing, Put OI decreasing
        exit_signals.append("Potential Exit Signal: Call OI increasing, Put OI decreasing (Bullish shift)")

    return exit_signals

def analyze_smart_money_tracking(current_data, previous_data, current_ltp):
    """Analyzes smart money tracking signals."""
    smart_money_signals = []

    if not previous_data or "oc" not in previous_data or "oc" not in current_data:
        return smart_money_signals

    price_change = current_ltp - previous_data.get("last_price", 0)
    price_up = price_change > 0
    price_down = price_change < 0

    total_put_oi_change = sum([get_option_metrics(current_data["oc"].get(s, {}).get("pe", {}), previous_data["oc"].get(s, {}).get("pe", {}))[1] for s in current_data["oc"] if "pe" in current_data["oc"].get(s, {})])
    total_call_oi_change = sum([get_option_metrics(current_data["oc"].get(s, {}).get("ce", {}), previous_data["oc"].get(s, {}).get("ce", {}))[1] for s in current_data["oc"] if "ce" in current_data["oc"].get(s, {})])

    # Strong Bullish Setup: Put OI ↑ (writing) AND Call OI ↓ (unwinding) AND Price ↑
    if total_put_oi_change > 0 and total_call_oi_change < 0 and price_up:
        smart_money_signals.append(f"Strong Bullish Setup: Put OI increasing ({total_put_oi_change}), Call OI decreasing ({total_call_oi_change}), Price Up ({price_change:.2f})")

    # Strong Bearish Setup: Call OI ↑ (writing) AND Put OI ↓ (unwinding) AND Price ↓
    if total_call_oi_change > 0 and total_put_oi_change < 0 and price_down:
        smart_money_signals.append(f"Strong Bearish Setup: Call OI increasing ({total_call_oi_change}), Put OI decreasing ({total_put_oi_change}), Price Down ({price_change:.2f})")

    return smart_money_signals

def main():
    global previous_option_chain_data

    print("Starting Option Chain Analyzer...")

    while True:
        current_analysis_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"\n--- Analyzing Data at {current_analysis_time} ---")
        
        active_instruments = get_active_instruments()
        print(f"Active instruments: {active_instruments}")
        for instrument in INSTRUMENTS:
            if instrument not in active_instruments:
                print(f"\n--- SKIPPING {instrument} (disabled in dashboard) ---")
                continue
            print(f"\n--- Analyzing {instrument} Option Chain ---")
            current_data = load_option_chain_data(instrument)

            if current_data:
                current_ltp = current_data.get("last_price", 0)
                
                # Ensure previous data exists for comparison
                if instrument not in previous_option_chain_data:
                    previous_option_chain_data[instrument] = current_data
                    print(f"  Initializing previous data for {instrument}. No signals generated yet.")
                    continue
                previous_data = previous_option_chain_data[instrument]

                analyzer_results = {
                    "instrument": instrument,
                    "timestamp": current_analysis_time,
                    "last_price": current_ltp,
                }

                # 1. Active Strikes
                active_strikes = identify_active_strikes(current_data, previous_data)
                analyzer_results["active_strikes"] = active_strikes
                call_strikes = active_strikes["call"]
                put_strikes = active_strikes["put"]
                if call_strikes or put_strikes:
                    print(f"  Active Call Strikes: {call_strikes}")
                    print(f"  Active Put Strikes: {put_strikes}")

                # 2. S&R Levels
                main_support, main_resistance, support_levels, resistance_levels = identify_support_resistance(current_data, previous_data, current_ltp)
                analyzer_results["main_support"] = main_support
                analyzer_results["main_resistance"] = main_resistance
                analyzer_results["support_levels"] = support_levels
                analyzer_results["resistance_levels"] = resistance_levels
                print(f"  Main Support: {main_support}, Main Resistance: {main_resistance}")
                print(f"  Top 5 Support Levels: {support_levels}")
                print(f"  Top 5 Resistance Levels: {resistance_levels}")

                # 3. Market Bias
                market_bias = identify_market_bias(current_data)
                analyzer_results["market_bias"] = market_bias
                print(f"  Market Bias: {market_bias}")

                # 4. OI Change Signals (Long Buildup, Short Buildup, etc.)
                oi_change_signals = analyze_signals(current_data, previous_data)
                analyzer_results["oi_change_signals"] = oi_change_signals
                if oi_change_signals:
                    print("  OI Change Signals:")
                    for signal in oi_change_signals:
                        print(f"    - {signal}")

                # 5. Entry Strategy Signals
                entry_signals = analyze_entry_strategy(current_data, previous_data, current_ltp, main_support, main_resistance)
                analyzer_results["entry_signals"] = entry_signals
                if entry_signals:
                    print("  Entry Strategy Signals:")
                    for signal in entry_signals:
                        print(f"    - {signal}")

                # 6. Real-Time Signals (Breakouts/Breakdowns)
                real_time_signals = analyze_real_time_signals(current_data, previous_data, current_ltp, main_support, main_resistance)
                analyzer_results["real_time_signals"] = real_time_signals
                if real_time_signals:
                    print("  Real-Time Signals:")
                    for signal in real_time_signals:
                        print(f"    - {signal}")

                # 7. Exit Strategy Signals
                exit_signals = analyze_exit_strategy(current_data, previous_data)
                analyzer_results["exit_signals"] = exit_signals
                if exit_signals:
                    print("  Exit Strategy Signals:")
                    for signal in exit_signals:
                        print(f"    - {signal}")

                # 8. Smart Money Tracking
                smart_money_signals = analyze_smart_money_tracking(current_data, previous_data, current_ltp)
                analyzer_results["smart_money_signals"] = smart_money_signals
                if smart_money_signals:
                    print("  Smart Money Tracking:")
                    for signal in smart_money_signals:
                        print(f"    - {signal}")

                # 9. Opening OI Snapshot & Intraday S/R Analysis
                opening_snapshot = capture_opening_snapshot_if_needed(instrument, current_data)
                if opening_snapshot:
                    sr_intraday_levels = compute_intraday_oi_changes(
                        current_data, opening_snapshot,
                        support_levels, resistance_levels, current_ltp
                    )
                    analyzer_results["opening_snapshot"] = {
                        "captured_at": opening_snapshot.get("captured_at", "N/A"),
                        "opening_ltp": opening_snapshot.get("last_price", 0),
                    }
                    analyzer_results["sr_intraday_levels"] = sr_intraday_levels
                    if sr_intraday_levels:
                        print(f"  Opening OI Snapshot: {opening_snapshot.get('captured_at', 'N/A')} (LTP: {opening_snapshot.get('last_price', 0)})")
                        print(f"  S/R Intraday Levels: {len(sr_intraday_levels)} levels tracked")
                        for sl in sr_intraday_levels:
                            ce_chg = sl['call_oi_intraday_change']
                            pe_chg = sl['put_oi_intraday_change']
                            print(f"    {sl['strike']} ({sl['type']}): CE {'+' if ce_chg >= 0 else ''}{ce_chg} ({sl['call_activity']}), PE {'+' if pe_chg >= 0 else ''}{pe_chg} ({sl['put_activity']})")
                else:
                    analyzer_results["opening_snapshot"] = None
                    analyzer_results["sr_intraday_levels"] = []

                # Save analyzer results to a JSON file for the AI Decision Engine
                output_filepath = os.path.join(DATA_DIR, f"analyzer_output_{instrument.lower()}.json")
                with open(output_filepath, "w") as f:
                    json.dump(analyzer_results, f, indent=2)
                print(f"  Analyzer output saved to {output_filepath}")

                previous_option_chain_data[instrument] = current_data
            else:
                print(f"  Could not load current data for {instrument}.")

            print("Waiting 5 seconds for next analysis...")
            sys.stdout.flush() # Ensure all output is flushed immediately
        time.sleep(5)

if __name__ == "__main__":
    main()

