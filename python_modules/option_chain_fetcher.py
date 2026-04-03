#!/usr/bin/env python3
"""
Option Chain Fetcher v2
-----------------------
Fetches option chain data via the Broker Service REST API instead of
calling Dhan directly. This ensures all market data flows through the
unified broker abstraction layer.

Endpoints used:
  GET  /api/broker/token/status                — Validate auth
  GET  /api/broker/scrip-master/mcx-futcom     — Resolve MCX commodity security IDs
  GET  /api/broker/option-chain/expiry-list     — Fetch expiry dates
  GET  /api/broker/option-chain                 — Fetch option chain data
  GET  /api/trading/active-instruments          — Poll dashboard for active instruments
"""

import env_loader  # noqa: F401 — load .env from project root

import json
import time
import os
import sys
from datetime import datetime

import requests

# --- Configuration ---

# Broker Service base URL (same server)
BROKER_URL = os.environ.get("BROKER_URL", "http://localhost:3000").strip()

# Dashboard URL for active instruments polling
DASHBOARD_URL = os.environ.get("DASHBOARD_URL", "http://localhost:3000").strip()

# Output directory for option chain JSON files
DATA_DIR = os.path.dirname(os.path.abspath(__file__))

# Static instrument config
# NIFTY 50 and BANKNIFTY use fixed index IDs (resolved by broker service).
# MCX commodities use the nearest-month futures security_id, resolved at startup
# via the broker service's scrip master.
INSTRUMENTS = {
    "NIFTY 50": {
        "underlying": "13",
        "exchange_segment": "IDX_I",
        "auto_resolve": False,
    },
    "BANKNIFTY": {
        "underlying": "25",
        "exchange_segment": "IDX_I",
        "auto_resolve": False,
    },
    "CRUDEOIL": {
        "underlying": None,
        "exchange_segment": "MCX_COMM",
        "auto_resolve": True,
        "symbol_name": "CRUDEOIL",
    },
    "NATURALGAS": {
        "underlying": None,
        "exchange_segment": "MCX_COMM",
        "auto_resolve": True,
        "symbol_name": "NATURALGAS",
    },
}

# Polling intervals
FETCH_INTERVAL = 5       # seconds between full cycles
RATE_LIMIT_DELAY = 3     # seconds between individual instrument fetches


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
                log("Broker token is valid.")
                return True
            else:
                msg = data.get("data", {}).get("message", "Unknown")
                log(f"Broker token invalid: {msg}")
                return False
        elif resp.status_code == 503:
            log("Broker service not ready (no active adapter). Waiting...")
            return False
        else:
            log(f"Token status check failed: HTTP {resp.status_code}")
            return False
    except requests.exceptions.ConnectionError:
        log(f"Cannot connect to broker service at {BROKER_URL}. Is the server running?")
        return False
    except Exception as e:
        log(f"Error checking broker auth: {e}")
        return False


def resolve_mcx_security_ids():
    """
    Resolve MCX commodity security IDs via the Broker Service scrip master.
    Replaces the old direct-download of Dhan's scrip master CSV.
    """
    log("Resolving MCX commodity security IDs via Broker Service...")
    for inst_key, inst_cfg in INSTRUMENTS.items():
        if not inst_cfg.get("auto_resolve"):
            continue

        symbol = inst_cfg["symbol_name"]
        url = f"{BROKER_URL}/api/broker/scrip-master/mcx-futcom"
        try:
            resp = requests.get(url, params={"symbol": symbol}, timeout=15)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("success") and data.get("data"):
                    security_id = data["data"]["securityId"]
                    expiry = data["data"].get("expiryDate", "unknown")
                    INSTRUMENTS[inst_key]["underlying"] = str(security_id)
                    log(f"  {inst_key}: security_id = {security_id} (expires {expiry})")
                else:
                    log(f"  [WARN] {inst_key}: Broker returned no data for MCX FUTCOM")
            elif resp.status_code == 404:
                log(f"  [WARN] {inst_key}: No active FUTCOM contract found")
            elif resp.status_code == 501:
                log(f"  [WARN] {inst_key}: Scrip master not supported by active adapter")
            else:
                log(f"  [WARN] {inst_key}: HTTP {resp.status_code} from scrip master")
        except Exception as e:
            log(f"  [ERROR] {inst_key}: Failed to resolve MCX FUTCOM: {e}")


def get_expiry_dates(underlying, exchange_segment=None):
    """Fetch expiry dates via the Broker Service REST API."""
    url = f"{BROKER_URL}/api/broker/option-chain/expiry-list"
    try:
        params = {"underlying": underlying}
        if exchange_segment:
            params["exchangeSegment"] = exchange_segment
        resp = requests.get(url, params=params, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return data.get("data", [])
        log(f"Failed to fetch expiry list for {underlying}. "
            f"Status: {resp.status_code}, Response: {resp.text[:200]}")
        return None
    except Exception as e:
        log(f"Exception fetching expiry list for {underlying}: {e}")
        return None


def get_option_chain(underlying, expiry, exchange_segment=None):
    """Fetch option chain data via the Broker Service REST API."""
    url = f"{BROKER_URL}/api/broker/option-chain"
    try:
        params = {"underlying": underlying, "expiry": expiry}
        if exchange_segment:
            params["exchangeSegment"] = exchange_segment
        resp = requests.get(
            url,
            params=params,
            timeout=15,
        )
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return data.get("data")
        log(f"Failed to fetch option chain for {underlying} on {expiry}. "
            f"Status: {resp.status_code}, Response: {resp.text[:200]}")
        return None
    except Exception as e:
        log(f"Exception fetching option chain for {underlying}: {e}")
        return None


def get_active_instruments():
    """
    Poll the dashboard to get the list of active instruments.
    Falls back to all instruments if the dashboard is unreachable.
    """
    url = f"{DASHBOARD_URL}/api/trading/active-instruments"
    try:
        resp = requests.get(url, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            active = data.get("instruments", [])
            # Map dashboard keys to fetcher instrument names
            key_map = {
                "NIFTY_50": "NIFTY 50",
                "BANKNIFTY": "BANKNIFTY",
                "CRUDEOIL": "CRUDEOIL",
                "NATURALGAS": "NATURALGAS",
            }
            mapped = [key_map.get(k, k) for k in active if k in key_map]
            log(f"[Dashboard] Active instruments: {active} -> mapped: {mapped}")
            return mapped
        else:
            log(f"[Dashboard] Active instruments API returned HTTP {resp.status_code}")
    except Exception as e:
        log(f"[Dashboard] Failed to reach {url}: {e}")

    # Fallback: process all instruments
    log("[Dashboard] Using FALLBACK: all instruments")
    return list(INSTRUMENTS.keys())


# --- Main Loop ---

def main():
    log("=" * 60)
    log("Option Chain Fetcher v2 — Broker Service Mode")
    log(f"Broker URL: {BROKER_URL}")
    log(f"Dashboard URL: {DASHBOARD_URL}")
    log(f"Data Dir: {DATA_DIR}")
    log("=" * 60)

    # Step 1: Wait for broker service to be ready and authenticated
    log("Waiting for broker service to be ready...")
    while True:
        if check_broker_auth():
            break
        log("Retrying in 10 seconds...")
        time.sleep(10)

    # Step 2: Resolve MCX commodity security IDs via broker service
    resolve_mcx_security_ids()

    # Verify all instruments have valid underlying IDs
    for inst_key, inst_cfg in INSTRUMENTS.items():
        if inst_cfg["underlying"] is None:
            log(f"[WARN] {inst_key} has no underlying ID — it will be skipped.")

    log("\nInstrument Configuration:")
    for inst_key, inst_cfg in INSTRUMENTS.items():
        uid = inst_cfg["underlying"]
        seg = inst_cfg["exchange_segment"]
        log(f"  {inst_key}: underlying={uid}, exchange_segment={seg}")
    log("")

    # Step 3: Main polling loop
    cycle = 0
    while True:
        cycle += 1
        log(f"\n--- Fetch Cycle {cycle} at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ---")

        active_instruments = get_active_instruments()
        log(f"Active instruments: {active_instruments}")

        for instrument, details in INSTRUMENTS.items():
            if instrument not in active_instruments:
                log(f"{instrument} | SKIPPED (disabled in dashboard)")
                continue
            if details["underlying"] is None:
                log(f"{instrument} | SKIPPED (no underlying ID resolved)")
                continue

            underlying = details["underlying"]
            exchange_segment = details.get("exchange_segment")

            # Fetch expiry dates
            expiry_dates = get_expiry_dates(underlying, exchange_segment)
            if expiry_dates:
                current_expiry = expiry_dates[0]
                log(f"{instrument} | Current Expiry: {current_expiry}")

                # Fetch option chain
                option_chain_data = get_option_chain(underlying, current_expiry, exchange_segment)
                if option_chain_data:
                    # Count strikes if available
                    strikes = option_chain_data.get("oc", option_chain_data.get("strikes", {}))
                    strike_count = len(strikes) if isinstance(strikes, (dict, list)) else 0
                    log(f"{instrument} | Option chain fetched. Strikes: {strike_count}")

                    # Save to file for downstream components
                    filename = os.path.join(
                        DATA_DIR,
                        f"option_chain_{instrument.replace(' ', '_').lower()}.json",
                    )
                    with open(filename, "w") as f:
                        json.dump(option_chain_data, f)
                else:
                    log(f"{instrument} | Failed to fetch option chain.")
            else:
                log(f"{instrument} | Failed to fetch expiry dates.")

            time.sleep(RATE_LIMIT_DELAY)

        log(f"Waiting {FETCH_INTERVAL} seconds for next poll...")
        time.sleep(FETCH_INTERVAL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("Option Chain Fetcher stopped by user.")
        sys.exit(0)
