#!/usr/bin/env python3
"""
Dashboard Data Pusher
---------------------
This script runs alongside your 4 trading modules and pushes their
JSON output to the web dashboard via REST API.

It watches for changes in the JSON files produced by:
  - dhan_option_chain_fetcher.py  -> option_chain_*.json
  - option_chain_analyzer.py      -> analyzer_output_*.json
  - ai_decision_engine.py         -> ai_decision_*.json
  - execution_module.py           -> (positions via heartbeat)

Usage:
  python3 dashboard_data_pusher.py

Configuration:
  Set DASHBOARD_URL to your dashboard's base URL.
  Set DATA_DIR to the directory where your Python modules save JSON files.
"""

import env_loader  # noqa: F401 — load .env from project root

import json
import os
import time
import sys
import requests
from datetime import datetime

# --- Configuration ---
# Change this to your deployed dashboard URL (or localhost for local dev)
DASHBOARD_URL = os.environ.get('DASHBOARD_URL', 'http://localhost:3000').strip()

# Directory where the Python modules save their JSON output files
# This should be the same directory as your trading_system scripts
DATA_DIR = os.path.dirname(os.path.abspath(__file__))

# Instruments to monitor
INSTRUMENTS = ['NIFTY_50', 'BANKNIFTY', 'CRUDEOIL', 'NATURALGAS']

# Polling interval in seconds
POLL_INTERVAL = 3

# Track file modification times to detect changes
file_mtimes = {}


def get_active_instruments():
    """Polls the dashboard to get the list of active instruments.
    Falls back to all instruments if the dashboard is unreachable."""
    try:
        resp = requests.get(f'{DASHBOARD_URL}/api/trading/active-instruments', timeout=3)
        if resp.status_code == 200:
            data = resp.json()
            return set(data.get('instruments', []))
    except Exception:
        pass
    # Fallback: push all instruments if dashboard is unreachable
    return set(INSTRUMENTS)


def log(msg):
    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    print(f'[{ts}] {msg}')


def get_file_mtime(filepath):
    try:
        return os.path.getmtime(filepath)
    except OSError:
        return 0


def has_file_changed(filepath):
    current_mtime = get_file_mtime(filepath)
    previous_mtime = file_mtimes.get(filepath, 0)
    if current_mtime > previous_mtime:
        file_mtimes[filepath] = current_mtime
        return True
    return False


def load_json(filepath):
    try:
        with open(filepath, 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        return None


def push_data(endpoint, payload):
    url = f'{DASHBOARD_URL}/api/trading/{endpoint}'
    try:
        resp = requests.post(url, json=payload, timeout=5)
        if resp.status_code == 200:
            return True
        else:
            log(f'  [WARN] {endpoint}: HTTP {resp.status_code} - {resp.text[:100]}')
            return False
    except requests.exceptions.ConnectionError:
        return False
    except Exception as e:
        log(f'  [ERROR] {endpoint}: {str(e)}')
        return False


def send_heartbeat(module, message):
    push_data('heartbeat', {'module': module, 'message': message})


def main():
    log('=' * 60)
    log('Dashboard Data Pusher - Starting')
    log(f'Dashboard URL: {DASHBOARD_URL}')
    log(f'Data Directory: {DATA_DIR}')
    log(f'Instruments: {INSTRUMENTS}')
    log(f'Poll Interval: {POLL_INTERVAL}s')
    log('=' * 60)

    # Check dashboard connectivity
    try:
        resp = requests.get(f'{DASHBOARD_URL}/api/trading/health', timeout=5)
        if resp.status_code == 200:
            log('[OK] Dashboard is reachable.')
        else:
            log(f'[WARN] Dashboard returned HTTP {resp.status_code}')
    except requests.exceptions.ConnectionError:
        log('[WARN] Cannot reach dashboard. Will retry on each push.')
    except Exception as e:
        log(f'[WARN] Dashboard health check failed: {e}')

    cycle = 0
    while True:
        cycle += 1
        pushed_any = False

        active_instruments = get_active_instruments()
        for instrument in INSTRUMENTS:
            if instrument not in active_instruments:
                if cycle % 10 == 0:  # Only log skips every 10 cycles to reduce noise
                    log(f'  [SKIP] {instrument} (disabled in dashboard)')
                continue
            inst_lower = instrument.lower()

            # 1. Push Option Chain data
            oc_file = os.path.join(DATA_DIR, f'option_chain_{inst_lower}.json')
            if has_file_changed(oc_file):
                data = load_json(oc_file)
                if data:
                    success = push_data('option-chain', {
                        'instrument': instrument,
                        'data': data
                    })
                    if success:
                        log(f'  [PUSH] Option Chain: {instrument}')
                        pushed_any = True

            # 2. Push Analyzer Output
            analyzer_file = os.path.join(DATA_DIR, f'analyzer_output_{inst_lower}.json')
            if has_file_changed(analyzer_file):
                data = load_json(analyzer_file)
                if data:
                    success = push_data('analyzer', {
                        'instrument': instrument,
                        'data': data
                    })
                    if success:
                        log(f'  [PUSH] Analyzer: {instrument}')
                        pushed_any = True

            # 3. Push AI Decision
            ai_file = os.path.join(DATA_DIR, f'ai_decision_{inst_lower}.json')
            if has_file_changed(ai_file):
                data = load_json(ai_file)
                if data:
                    success = push_data('ai-decision', {
                        'instrument': instrument,
                        'data': data
                    })
                    if success:
                        log(f'  [PUSH] AI Decision: {instrument}')
                        pushed_any = True

        # Send heartbeats every cycle
        send_heartbeat('FETCHER', 'Data pusher active')

        # Log status every 10 cycles
        if cycle % 10 == 0:
            log(f'--- Cycle {cycle} complete ---')

        time.sleep(POLL_INTERVAL)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        log('Data Pusher stopped by user.')
        sys.exit(0)
