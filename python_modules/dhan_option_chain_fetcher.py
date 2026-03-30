import requests
import json
import time
import csv
import io
from datetime import datetime
import os

# --- Configuration ---
CLIENT_ID = "1101615161"
ACCESS_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzc0MzE4MjEwLCJpYXQiOjE3NzQyMzE4MTAsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTAxNjE1MTYxIn0.AQbyCLWX9HC-eLr5WLhpdjIn8a5ADiSox5hpIBalegzTDyzXjp0_zn9iDvhhWkqgH_z-rlWqQLosQlpGppqexg"

# Static instrument config — NIFTY 50 uses a fixed index ID (13),
# while MCX commodities use the nearest-month futures security_id
# which changes every month and is resolved automatically at startup.
INSTRUMENTS = {
    "NIFTY 50": {"security_id": 13, "exchange_segment": "IDX_I", "auto_resolve": False},
    "BANKNIFTY": {"security_id": 25, "exchange_segment": "IDX_I", "auto_resolve": False},
    "CRUDEOIL": {"security_id": None, "exchange_segment": "MCX_COMM", "auto_resolve": True, "symbol_name": "CRUDEOIL"},
    "NATURALGAS": {"security_id": None, "exchange_segment": "MCX_COMM", "auto_resolve": True, "symbol_name": "NATURALGAS"}
}

SCRIP_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master.csv"
BASE_URL = "https://api.dhan.co/v2"

# Dashboard URL for active instruments polling
DASHBOARD_URL = os.environ.get('DASHBOARD_URL', 'http://localhost:3000').strip()

# Headers exactly as per successful curl/postman
HEADERS = {
    "access-token": ACCESS_TOKEN,
    "client-id": CLIENT_ID,
    "Content-Type": "application/json",
    "Accept": "application/json"
}

DATA_DIR = os.path.dirname(os.path.abspath(__file__))


def resolve_security_ids():
    """
    Downloads the Dhan scrip master CSV and finds the nearest-month
    FUTCOM (futures) security_id for each MCX commodity instrument.
    This ensures we always use the active contract, even after monthly expiry.
    """
    print("Resolving MCX commodity security IDs from Dhan scrip master...")
    try:
        resp = requests.get(SCRIP_MASTER_URL, timeout=60)
        resp.raise_for_status()
    except Exception as e:
        print(f"[ERROR] Failed to download scrip master: {e}")
        print("[WARN] MCX instruments will not work until security IDs are resolved.")
        return

    reader = csv.DictReader(io.StringIO(resp.text))
    now = datetime.now()

    # Collect all FUTCOM rows for our target symbols
    futures_by_symbol = {}  # symbol_name -> list of (expiry_date, security_id)
    for row in reader:
        instrument_name = row.get("SEM_INSTRUMENT_NAME", "")
        symbol_name = row.get("SM_SYMBOL_NAME", "")
        if instrument_name != "FUTCOM":
            continue
        for inst_key, inst_cfg in INSTRUMENTS.items():
            if not inst_cfg.get("auto_resolve"):
                continue
            if symbol_name == inst_cfg["symbol_name"]:
                expiry_str = row.get("SEM_EXPIRY_DATE", "")
                sec_id = row.get("SEM_SMST_SECURITY_ID", "")
                if expiry_str and sec_id:
                    try:
                        # Parse "2026-04-20 23:30:00" format
                        expiry_dt = datetime.strptime(expiry_str.split(" ")[0], "%Y-%m-%d")
                        if expiry_dt >= now:  # Only future/current expiries
                            if symbol_name not in futures_by_symbol:
                                futures_by_symbol[symbol_name] = []
                            futures_by_symbol[symbol_name].append((expiry_dt, int(sec_id)))
                    except (ValueError, TypeError):
                        pass

    # For each instrument, pick the nearest-month futures contract
    for inst_key, inst_cfg in INSTRUMENTS.items():
        if not inst_cfg.get("auto_resolve"):
            continue
        symbol = inst_cfg["symbol_name"]
        candidates = futures_by_symbol.get(symbol, [])
        if candidates:
            # Sort by expiry date ascending, pick the nearest
            candidates.sort(key=lambda x: x[0])
            nearest_expiry, nearest_id = candidates[0]
            INSTRUMENTS[inst_key]["security_id"] = nearest_id
            expiry_label = nearest_expiry.strftime("%Y-%m-%d")
            print(f"  {inst_key}: security_id = {nearest_id} (expires {expiry_label})")
        else:
            print(f"  [WARN] {inst_key}: No active FUTCOM contract found in scrip master!")


def test_profile_api():
    """Tests the Profile API to verify authentication."""
    url = f"{BASE_URL}/profile"
    try:
        response = requests.get(url, headers=HEADERS)
        print(f"Profile API Status Code: {response.status_code}")
        if response.status_code == 200:
            print("Profile API authentication successful.")
            return True
        else:
            print(f"Profile API failed: {response.text}")
            return False
    except Exception as e:
        print(f"Exception testing Profile API: {e}")
        return False


def get_expiry_dates(security_id, exchange_segment):
    """Fetches the expiry dates for a given instrument."""
    url = f"{BASE_URL}/optionchain/expirylist"
    payload = {
        "UnderlyingScrip": security_id,
        "UnderlyingSeg": exchange_segment
    }
    try:
        response = requests.post(url, headers=HEADERS, json=payload)
        if response.status_code == 200:
            data = response.json()
            if data.get("status") == "success":
                return data.get("data")
        print(f"Failed to fetch expiry list for {security_id}. Status: {response.status_code}, Response: {response.text}")
        return None
    except Exception as e:
        print(f"Exception fetching expiry list for {security_id}: {e}")
        return None


def get_option_chain(security_id, exchange_segment, expiry_date):
    """Fetches the option chain for a given instrument and expiry date."""
    url = f"{BASE_URL}/optionchain"
    payload = {
        "UnderlyingScrip": security_id,
        "UnderlyingSeg": exchange_segment,
        "Expiry": expiry_date
    }
    try:
        response = requests.post(url, headers=HEADERS, json=payload)
        if response.status_code == 200:
            data = response.json()
            if data.get("status") == "success":
                return data.get("data")
        print(f"Failed to fetch option chain for {security_id} on {expiry_date}. Status: {response.status_code}, Response: {response.text}")
        return None
    except Exception as e:
        print(f"Exception fetching option chain for {security_id}: {e}")
        return None


def get_active_instruments():
    """Polls the dashboard to get the list of active instruments.
    Falls back to all instruments if the dashboard is unreachable."""
    url = f"{DASHBOARD_URL}/api/trading/active-instruments"
    try:
        resp = requests.get(url, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            active = data.get("instruments", [])
            # Map dashboard keys to fetcher instrument names
            key_map = {"NIFTY_50": "NIFTY 50", "BANKNIFTY": "BANKNIFTY", "CRUDEOIL": "CRUDEOIL", "NATURALGAS": "NATURALGAS"}
            mapped = [key_map.get(k, k) for k in active if k in key_map]
            print(f"[Dashboard] Active instruments API returned: {active} -> mapped: {mapped}")
            return mapped
        else:
            print(f"[Dashboard] Active instruments API returned HTTP {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        print(f"[Dashboard] Failed to reach {url}: {e}")
    # Fallback: process all instruments if dashboard is unreachable
    print("[Dashboard] Using FALLBACK: all instruments")
    return list(INSTRUMENTS.keys())


def main():
    print("=" * 60)
    print("Starting Dhan Option Chain Fetcher...")
    print("=" * 60)

    # Step 1: Auto-resolve MCX commodity security IDs
    resolve_security_ids()

    # Verify all instruments have valid security IDs
    for inst_key, inst_cfg in INSTRUMENTS.items():
        if inst_cfg["security_id"] is None:
            print(f"[WARN] {inst_key} has no security_id — it will be skipped.")

    # Step 2: Verify authentication
    if not test_profile_api():
        print("Aborting: Authentication check failed.")
        return

    print("\nInstrument Configuration:")
    for inst_key, inst_cfg in INSTRUMENTS.items():
        sid = inst_cfg["security_id"]
        seg = inst_cfg["exchange_segment"]
        print(f"  {inst_key}: security_id={sid}, exchange_segment={seg}")
    print()

    # Step 3: Main polling loop
    while True:
        print(f"\n--- Fetching Data at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ---")
        active_instruments = get_active_instruments()
        print(f"Active instruments: {active_instruments}")
        for instrument, details in INSTRUMENTS.items():
            if instrument not in active_instruments:
                print(f"{instrument} | SKIPPED (disabled in dashboard)")
                continue
            if details["security_id"] is None:
                print(f"{instrument} | SKIPPED (no security_id resolved)")
                continue
            expiry_dates = get_expiry_dates(details["security_id"], details["exchange_segment"])
            if expiry_dates:
                current_expiry = expiry_dates[0]
                print(f"{instrument} | Current Expiry: {current_expiry}")
                option_chain_data = get_option_chain(details["security_id"], details["exchange_segment"], current_expiry)
                if option_chain_data:
                    strikes = option_chain_data.get("oc", {})
                    print(f"{instrument} | Option Chain fetched successfully. Strikes found: {len(strikes)}")
                    # Save to file for downstream components
                    filename = os.path.join(DATA_DIR, f"option_chain_{instrument.replace(' ', '_').lower()}.json")
                    with open(filename, 'w') as f:
                        json.dump(option_chain_data, f)
                else:
                    print(f"{instrument} | Failed to fetch option chain.")
            else:
                print(f"{instrument} | Failed to fetch expiry dates.")
            time.sleep(3)  # Rate limit: 1 request per 3 seconds

        print("Waiting 5 seconds for next poll...")
        time.sleep(5)


if __name__ == "__main__":
    main()
