#!/usr/bin/env python3
"""
Session Manager (Module 6)
--------------------------
Manages daily trading limits, tracks cumulative P&L, and handles
end-of-day carry forward decisions.

Operates at a higher level than individual trades — monitors the overall
health of the trading day and enforces strict capital protection rules
that override all other modules.

Key features:
  1. Daily Session Manager: Tracks cumulative realized P&L, enforces
     daily profit cap (+5%) and loss cap (-2%).
  2. Carry Forward Engine: At 15:15, evaluates open positions for
     overnight hold vs forced close.

Usage:
    from session_manager import SessionManager
    sm = SessionManager()
    sm.start()  # starts background monitoring thread

    # Before each trade:
    status = sm.get_session_status()
    if status["trading_halted"]:
        print(f"Trading halted: {status['halt_reason']}")

    # After each trade closes:
    sm.record_trade_pnl(pnl_amount)

    sm.stop()
"""

import env_loader  # noqa: F401

import json
import os
import sys
import threading
import time
from datetime import datetime, timedelta

import requests


# --- Configuration ---

DASHBOARD_URL = os.environ.get("DASHBOARD_URL", "http://localhost:3000").strip()
CAPITAL_WORKSPACE = os.environ.get("CAPITAL_WORKSPACE", "paper").strip()
DATA_DIR = os.path.dirname(os.path.abspath(__file__))

# Daily P&L Caps (as percentage of account capital)
DAILY_PROFIT_CAP_PCT = 5.0    # +5% → stop trading for the day
DAILY_LOSS_CAP_PCT = -2.0     # -2% → stop trading for the day

# Carry Forward timing
CARRY_FORWARD_EVAL_TIME = "15:15"   # 3:15 PM
CARRY_FORWARD_CLOSE_TIME = "15:20"  # 3:20 PM — force close deadline

# Carry Forward conditions
CF_MIN_PROFIT_PCT = 15.0     # Position must be >= +15% profit
CF_MIN_MOMENTUM = 70         # Momentum Score must be > 70
CF_MAX_IV_ASSESSMENT = ["FAIR", "CHEAP"]  # IV must not be EXPENSIVE
CF_MIN_DTE = 2               # Days to expiry must be > 2

# Session state file
SESSION_STATE_FILE = os.path.join(DATA_DIR, "session_state.json")


# --- Helpers ---

def _log(message):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [SESSION] {message}")
    sys.stdout.flush()


def _get_capital_state():
    """Fetch current capital from tRPC."""
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
            return result.get("tradingPool", 0)
    except Exception as e:
        _log(f"Failed to fetch capital state: {e}")
    return None


# --- Session Manager ---

class SessionManager:
    """
    Daily Session Manager with P&L caps and Carry Forward Engine.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._thread = None
        self._running = False

        # Session state
        self._session_date = datetime.now().strftime("%Y-%m-%d")
        self._account_capital = 0
        self._daily_realized_pnl = 0.0
        self._trade_count = 0
        self._trading_halted = False
        self._halt_reason = None
        self._carry_forward_evaluated = False
        self._carry_forward_results = []

        # Load persisted state if same day
        self._load_state()

    def start(self):
        """Start the session monitoring background thread."""
        if self._running:
            return

        # Fetch initial capital
        capital = _get_capital_state()
        if capital and capital > 0:
            self._account_capital = capital
            _log(f"Session started. Capital: {self._account_capital:.0f}")
        else:
            _log("Could not fetch capital. Using last known value.")

        self._running = True
        self._thread = threading.Thread(target=self._monitor_loop, daemon=True, name="SessionManager")
        self._thread.start()
        _log(f"Session Manager started for {self._session_date}")

    def stop(self):
        """Stop the session manager."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)
        self._save_state()
        _log("Session Manager stopped.")

    def get_session_status(self):
        """Get current session status. Called by Executor before each trade."""
        with self._lock:
            profit_cap = self._account_capital * (DAILY_PROFIT_CAP_PCT / 100) if self._account_capital > 0 else float('inf')
            loss_cap = self._account_capital * (DAILY_LOSS_CAP_PCT / 100) if self._account_capital > 0 else float('-inf')

            return {
                "session_date": self._session_date,
                "account_capital": self._account_capital,
                "daily_realized_pnl": round(self._daily_realized_pnl, 2),
                "daily_pnl_pct": round((self._daily_realized_pnl / self._account_capital * 100) if self._account_capital > 0 else 0, 2),
                "trade_count": self._trade_count,
                "trading_halted": self._trading_halted,
                "halt_reason": self._halt_reason,
                "profit_cap": round(profit_cap, 2),
                "loss_cap": round(loss_cap, 2),
                "carry_forward_evaluated": self._carry_forward_evaluated,
            }

    def is_trading_allowed(self):
        """Quick check: is trading allowed right now?"""
        with self._lock:
            return not self._trading_halted

    def record_trade_pnl(self, pnl_amount):
        """Record a closed trade's P&L. Called by Executor after each exit."""
        with self._lock:
            self._daily_realized_pnl += pnl_amount
            self._trade_count += 1

            pnl_pct = (self._daily_realized_pnl / self._account_capital * 100) if self._account_capital > 0 else 0

            _log(f"Trade P&L recorded: {pnl_amount:+.2f} | Daily total: {self._daily_realized_pnl:+.2f} ({pnl_pct:+.2f}%)")

            # Check caps
            self._check_daily_caps()
            self._save_state()

    def evaluate_carry_forward(self, open_positions, momentum_engine=None, tick_feed=None):
        """
        Carry Forward Engine: Evaluate open positions for overnight hold.
        Called at 15:15 PM.

        Args:
            open_positions: dict of {instrument: position_dict}
            momentum_engine: MomentumEngine instance (optional)
            tick_feed: TickFeed instance (optional)

        Returns:
            list of {instrument, action, reason} dicts
        """
        results = []

        for instrument, position in open_positions.items():
            if position.get("status") != "OPEN":
                continue

            entry_price = position.get("entryPrice", 0)
            current_price = position.get("currentPrice", 0)
            pnl_pct = position.get("pnlPercent", 0)

            # Check all carry forward conditions
            conditions = {
                "profit_ok": pnl_pct >= CF_MIN_PROFIT_PCT,
                "momentum_ok": False,
                "iv_ok": False,
                "dte_ok": False,
            }

            # Momentum check
            if momentum_engine and tick_feed and tick_feed.connected:
                security_id = position.get("securityId", "")
                if security_id:
                    direction = "CALL" if position["type"] == "CALL_BUY" else "PUT"
                    momentum = momentum_engine.calculate(security_id, direction)
                    conditions["momentum_ok"] = momentum["score"] > CF_MIN_MOMENTUM
            else:
                # If no momentum data, fail this condition
                conditions["momentum_ok"] = False

            # IV check (from the AI decision if available)
            iv_assessment = position.get("iv_assessment", "UNKNOWN")
            conditions["iv_ok"] = iv_assessment in CF_MAX_IV_ASSESSMENT

            # DTE check
            expiry_str = position.get("expiry_date") or position.get("target_expiry_date")
            if expiry_str:
                try:
                    expiry = datetime.strptime(expiry_str, "%Y-%m-%d")
                    dte = (expiry - datetime.now()).days
                    conditions["dte_ok"] = dte > CF_MIN_DTE
                except (ValueError, TypeError):
                    conditions["dte_ok"] = False

            # Decision
            all_ok = all(conditions.values())
            failed = [k for k, v in conditions.items() if not v]

            if all_ok:
                action = "CARRY_FORWARD"
                reason = f"All conditions met: profit {pnl_pct:+.1f}% >= {CF_MIN_PROFIT_PCT}%"
            else:
                action = "FORCE_CLOSE"
                reason = f"Failed conditions: {', '.join(failed)} | profit: {pnl_pct:+.1f}%"

            result = {
                "instrument": instrument,
                "action": action,
                "reason": reason,
                "conditions": conditions,
                "pnl_pct": pnl_pct,
            }
            results.append(result)

            _log(f"  [CARRY_FORWARD] {instrument}: {action} — {reason}")

        with self._lock:
            self._carry_forward_evaluated = True
            self._carry_forward_results = results

        self._save_state()
        return results

    def reset_for_new_day(self):
        """Reset session state for a new trading day."""
        with self._lock:
            new_date = datetime.now().strftime("%Y-%m-%d")
            if new_date != self._session_date:
                _log(f"New trading day detected: {self._session_date} → {new_date}")
                self._session_date = new_date
                self._daily_realized_pnl = 0.0
                self._trade_count = 0
                self._trading_halted = False
                self._halt_reason = None
                self._carry_forward_evaluated = False
                self._carry_forward_results = []

                # Refresh capital
                capital = _get_capital_state()
                if capital and capital > 0:
                    self._account_capital = capital

                self._save_state()
                _log(f"Session reset. Capital: {self._account_capital:.0f}")

    # --- Internal ---

    def _check_daily_caps(self):
        """Check if daily P&L caps have been hit."""
        if self._account_capital <= 0:
            return

        pnl_pct = self._daily_realized_pnl / self._account_capital * 100

        if pnl_pct >= DAILY_PROFIT_CAP_PCT:
            self._trading_halted = True
            self._halt_reason = f"DAILY_PROFIT_CAP: {pnl_pct:+.2f}% >= +{DAILY_PROFIT_CAP_PCT}%"
            _log(f"TRADING HALTED: {self._halt_reason}")

        elif pnl_pct <= DAILY_LOSS_CAP_PCT:
            self._trading_halted = True
            self._halt_reason = f"DAILY_LOSS_CAP: {pnl_pct:+.2f}% <= {DAILY_LOSS_CAP_PCT}%"
            _log(f"TRADING HALTED: {self._halt_reason}")

    def _monitor_loop(self):
        """Background thread: checks for day rollover and carry forward timing."""
        while self._running:
            try:
                now = datetime.now()
                current_time = now.strftime("%H:%M")

                # Check for new day
                current_date = now.strftime("%Y-%m-%d")
                if current_date != self._session_date:
                    self.reset_for_new_day()

                # Check for carry forward evaluation time
                if current_time == CARRY_FORWARD_EVAL_TIME and not self._carry_forward_evaluated:
                    _log("Carry Forward evaluation time reached (15:15).")
                    # The actual evaluation is triggered by the Executor,
                    # which has access to open_positions and momentum_engine.
                    # We just set a flag here.
                    self._notify_carry_forward_time()

            except Exception as e:
                _log(f"Monitor loop error: {e}")

            time.sleep(30)  # Check every 30 seconds

    def _notify_carry_forward_time(self):
        """Notify the dashboard that carry forward evaluation is due."""
        try:
            requests.post(
                f"{DASHBOARD_URL}/api/trading/heartbeat",
                json={
                    "module": "SESSION_MANAGER",
                    "message": "Carry Forward evaluation time (15:15). Evaluating open positions.",
                },
                timeout=3,
            )
        except Exception:
            pass

    def _save_state(self):
        """Persist session state to disk."""
        state = {
            "session_date": self._session_date,
            "account_capital": self._account_capital,
            "daily_realized_pnl": self._daily_realized_pnl,
            "trade_count": self._trade_count,
            "trading_halted": self._trading_halted,
            "halt_reason": self._halt_reason,
            "carry_forward_evaluated": self._carry_forward_evaluated,
            "carry_forward_results": self._carry_forward_results,
            "saved_at": datetime.now().isoformat(),
        }
        try:
            with open(SESSION_STATE_FILE, "w") as f:
                json.dump(state, f, indent=2)
        except Exception as e:
            _log(f"Failed to save session state: {e}")

    def _load_state(self):
        """Load persisted session state if it's from today."""
        try:
            if os.path.exists(SESSION_STATE_FILE):
                with open(SESSION_STATE_FILE, "r") as f:
                    state = json.load(f)
                if state.get("session_date") == self._session_date:
                    self._account_capital = state.get("account_capital", 0)
                    self._daily_realized_pnl = state.get("daily_realized_pnl", 0)
                    self._trade_count = state.get("trade_count", 0)
                    self._trading_halted = state.get("trading_halted", False)
                    self._halt_reason = state.get("halt_reason")
                    self._carry_forward_evaluated = state.get("carry_forward_evaluated", False)
                    self._carry_forward_results = state.get("carry_forward_results", [])
                    _log(f"Resumed session state from {state.get('saved_at', 'unknown')}")
                else:
                    _log(f"Session state is from {state.get('session_date')} (today: {self._session_date}). Starting fresh.")
        except Exception as e:
            _log(f"Failed to load session state: {e}")


# --- Standalone test ---

if __name__ == "__main__":
    print("=== Session Manager Test ===")
    sm = SessionManager()
    sm._account_capital = 100000  # ₹1,00,000

    # Simulate trades
    print(f"\nStatus: {sm.get_session_status()}")

    sm.record_trade_pnl(2000)   # +2000
    print(f"After +2000: halted={sm.is_trading_allowed()}")

    sm.record_trade_pnl(1500)   # +1500 (total +3500 = 3.5%)
    print(f"After +1500: halted={sm.is_trading_allowed()}")

    sm.record_trade_pnl(2000)   # +2000 (total +5500 = 5.5% → HALTED)
    print(f"After +2000: allowed={sm.is_trading_allowed()}")
    print(f"Status: {sm.get_session_status()}")
