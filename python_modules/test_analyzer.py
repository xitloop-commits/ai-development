import json
import os
import time
from datetime import datetime

# --- Configuration ---
INSTRUMENTS = [
    "NIFTY_50",
    "BANKNIFTY",
    "CRUDEOIL",
    "NATURALGAS"
]

DATA_DIR = "/home/ubuntu/"

# Stores previous option chain data for comparison
previous_option_chain_data = {}

def load_option_chain_data(instrument_name):
    """Loads the latest option chain data for a given instrument from a JSON file."""
    filepath = os.path.join(DATA_DIR, f"option_chain_{instrument_name.lower()}.json")
    if os.path.exists(filepath):
        try:
            with open(filepath, 'r') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading {filepath}: {e}")
    return None

def get_option_metrics(option_data, previous_option_data):
    """Helper to get OI, OI Change, Volume, Volume Change for an option type."""
    current_oi = option_data.get("oi", 0)
    previous_oi = previous_option_data.get("oi", 0)
    oi_change = current_oi - previous_oi
    current_volume = option_data.get("volume", 0)
    previous_volume = previous_option_data.get("volume", 0) # Fixed from previous_volume to volume
    volume_change = current_volume - previous_volume
    return current_oi, oi_change, current_volume, volume_change

def identify_active_strikes(current_data, previous_data, top_n=3):
    """Identifies active strikes based on high OI, high OI Change, and high Volume."""
    active_strikes = {"call": [], "put": []}
    if not current_data or "oc" not in current_data or not previous_data or "oc" not in previous_data:
        return active_strikes

    strikes_data = current_data["oc"]
    previous_strikes_data = previous_data["oc"]

    call_oi_list = []
    call_oi_change_list = []
    call_volume_list = []

    put_oi_list = []
    put_oi_change_list = []
    put_volume_list = []

    for strike_str, data in strikes_data.items():
        strike_price = float(strike_str)
        prev_data = previous_strikes_data.get(strike_str, {})

        if "ce" in data and data["ce"]:
            current_oi, oi_change, current_volume, _ = get_option_metrics(data["ce"], prev_data.get("ce", {}))
            call_oi_list.append((strike_price, current_oi))
            call_oi_change_list.append((strike_price, oi_change))
            call_volume_list.append((strike_price, current_volume))

        if "pe" in data and data["pe"]:
            current_oi, oi_change, current_volume, _ = get_option_metrics(data["pe"], prev_data.get("pe", {}))
            put_oi_list.append((strike_price, current_oi))
            put_oi_change_list.append((strike_price, oi_change))
            put_volume_list.append((strike_price, current_volume))

    # Sort and get top N
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

    active_strikes["call"] = sorted(list(top_call_oi_strikes.intersection(top_call_oi_change_strikes).intersection(top_call_volume_strikes)))
    active_strikes["put"] = sorted(list(top_put_oi_strikes.intersection(top_put_oi_change_strikes).intersection(top_put_volume_strikes)))

    return active_strikes

def identify_support_resistance(current_data, previous_data, current_ltp, top_n=5):
    """Identifies top N support and resistance levels."""
    main_resistance = None
    main_support = None
    support_levels = []
    resistance_levels = []

    if not current_data or "oc" not in current_data:
        return main_support, main_resistance, support_levels, resistance_levels

    strikes_data = current_data["oc"]
    previous_strikes_data = previous_data["oc"] if previous_data and "oc" in previous_data else {}

    put_oi_info = []
    call_oi_info = []

    for strike_str, data in strikes_data.items():
        strike_price = float(strike_str)
        distance_from_ltp = abs(strike_price - current_ltp)
        prev_data = previous_strikes_data.get(strike_str, {})

        if "pe" in data and data["pe"]:
            current_oi, oi_change, _, _ = get_option_metrics(data["pe"], prev_data.get("pe", {}))
            put_oi_info.append((strike_price, current_oi, oi_change, distance_from_ltp))

        if "ce" in data and data["ce"]:
            current_oi, oi_change, _, _ = get_option_metrics(data["ce"], prev_data.get("ce", {}))
            call_oi_info.append((strike_price, current_oi, oi_change, distance_from_ltp))

    if call_oi_info:
        main_resistance = max(call_oi_info, key=lambda x: x[1])[0]
    if put_oi_info:
        main_support = max(put_oi_info, key=lambda x: x[1])[0]

    put_oi_info.sort(key=lambda x: (x[1], x[2], -x[3]), reverse=True)
    support_levels = sorted([s[0] for s in put_oi_info[:top_n]])

    call_oi_info.sort(key=lambda x: (x[1], x[2], -x[3]), reverse=True)
    resistance_levels = sorted([r[0] for r in call_oi_info[:top_n]])

    return main_support, main_resistance, support_levels, resistance_levels

def identify_market_bias(current_data):
    """Identifies overall market bias."""
    total_call_oi = 0
    total_put_oi = 0

    if not current_data or "oc" not in current_data:
        return "Neutral"

    for strike_str, data in current_data["oc"].items():
        if "ce" in data and data["ce"] and "oi" in data["ce"]:
            total_call_oi += data["ce"]["oi"]
        if "pe" in data and data["pe"] and "oi" in data["pe"]:
            total_put_oi += data["pe"]["oi"]

    if total_call_oi > total_put_oi * 1.2:
        return "Bearish"
    elif total_put_oi > total_call_oi * 1.2:
        return "Bullish"
    else:
        return "Range-bound"

def main():
    print("Starting Option Chain Analyzer Test...")
    
    for instrument in INSTRUMENTS:
        print(f"\n--- Analyzing {instrument} ---")
        current_data = load_option_chain_data(instrument)

        if current_data:
            current_ltp = current_data.get("last_price", 0)
            print(f"  Last Price: {current_ltp}")
            
            # For testing, we'll use current_data as previous_data to see static analysis
            previous_data = current_data 

            # 1. Market Bias
            market_bias = identify_market_bias(current_data)
            print(f"  Market Bias: {market_bias}")

            # 2. S&R Levels
            main_support, main_resistance, support_levels, resistance_levels = identify_support_resistance(current_data, previous_data, current_ltp)
            print(f"  Main Support: {main_support}, Main Resistance: {main_resistance}")
            print(f"  Top 5 Support Levels: {support_levels}")
            print(f"  Top 5 Resistance Levels: {resistance_levels}")

            # 3. Active Strikes
            active_strikes = identify_active_strikes(current_data, previous_data)
            print(f"  Active Call Strikes: {active_strikes['call']}")
            print(f"  Active Put Strikes: {active_strikes['put']}")

        else:
            print(f"  Could not load data for {instrument}.")

if __name__ == "__main__":
    main()
