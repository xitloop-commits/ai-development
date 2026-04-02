#!/usr/bin/env python3
"""
Performance Feedback Loop (Module 7)
-------------------------------------
Tracks trade outcomes and makes small, bounded adjustments to specific
system parameters at the start of each trading day.

Designed to be transparent, auditable, and safe — no black-box ML.
Uses historical trade data to optimize system performance over time.

Key features:
  1. Trade Journal: Logs every closed trade with full context.
  2. Daily Analysis: Calculates win rate, avg profit/loss, hold times.
  3. Parameter Tuning: Adjusts MIN_CONFIDENCE, PROFIT_PARTIAL_EXIT_PCT,
     and TRADE_AGE_FORCE_EXIT within strict bounds.
  4. Adjustment Logging: Every change is logged for full transparency.

Usage:
    from performance_feedback import FeedbackLoop, log_trade_to_journal

    # After each trade closes:
    log_trade_to_journal(trade_record)

    # Pre-market (once per day):
    fb = FeedbackLoop()
    adjustments = fb.run_daily_analysis()
"""

import env_loader  # noqa: F401

import json
import os
import sys
from datetime import datetime, timedelta
from copy import deepcopy


# --- Configuration ---

DATA_DIR = os.path.dirname(os.path.abspath(__file__))

# File paths
TRADE_JOURNAL_FILE = os.path.join(DATA_DIR, "trade_journal.json")
FEEDBACK_ADJUSTMENTS_FILE = os.path.join(DATA_DIR, "feedback_adjustments.json")
TUNED_PARAMS_FILE = os.path.join(DATA_DIR, "tuned_params.json")

# Feature toggle
FEEDBACK_ENABLED = os.environ.get("FEEDBACK_ENABLED", "false").lower() == "true"
FEEDBACK_LOOKBACK_DAYS = int(os.environ.get("FEEDBACK_LOOKBACK_DAYS", "5"))

# Tunable parameters with strict bounds
TUNABLE_PARAMS = {
    "MIN_CONFIDENCE": {
        "default": 0.65,
        "min": 0.60,
        "max": 0.75,
        "step": 0.02,
        "description": "Minimum AI confidence to take a trade",
    },
    "PROFIT_PARTIAL_EXIT_PCT": {
        "default": 6.0,
        "min": 4.0,
        "max": 8.0,
        "step": 1.0,
        "description": "Profit % at which partial exit is triggered",
    },
    "TRADE_AGE_FORCE_EXIT": {
        "default": 600,  # 10 minutes in seconds
        "min": 420,       # 7 minutes
        "max": 900,       # 15 minutes
        "step": 60,       # 1 minute
        "description": "Max trade age before forced exit (seconds)",
    },
}

# Non-tunable parameters (hardcoded for safety)
NON_TUNABLE = {
    "HARD_STOP_LOSS_PCT": -5.0,
    "DAILY_PROFIT_CAP_PCT": 5.0,
    "DAILY_LOSS_CAP_PCT": -2.0,
    "MAX_TRADES_PER_DAY": 3,
}


# --- Helpers ---

def _log(message):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [FEEDBACK] {message}")
    sys.stdout.flush()


# --- Trade Journal ---

def log_trade_to_journal(trade_record):
    """
    Log a closed trade to the trade journal.

    Args:
        trade_record: dict with fields:
            - date: str (YYYY-MM-DD)
            - instrument: str
            - direction: str (GO_CALL or GO_PUT)
            - entry_price: float
            - exit_price: float
            - pnl_pct: float
            - result: str (WIN or LOSS)
            - hold_time_seconds: int
            - exit_reason: str
            - confidence_at_entry: float
            - momentum_at_entry: float (optional)
            - peak_profit_pct: float (optional)
    """
    # Validate required fields
    required = ["date", "instrument", "direction", "entry_price", "exit_price",
                "pnl_pct", "result", "hold_time_seconds", "exit_reason"]
    for field in required:
        if field not in trade_record:
            _log(f"Warning: Missing field '{field}' in trade record. Skipping journal entry.")
            return

    # Load existing journal
    journal = _load_journal()

    # Add timestamp
    trade_record["logged_at"] = datetime.now().isoformat()

    # Append and save
    journal.append(trade_record)
    _save_journal(journal)

    result = trade_record["result"]
    pnl = trade_record["pnl_pct"]
    _log(f"Trade logged: {trade_record['instrument']} {trade_record['direction']} "
         f"→ {result} ({pnl:+.1f}%) | Hold: {trade_record['hold_time_seconds']}s | "
         f"Exit: {trade_record['exit_reason']}")


def _load_journal():
    """Load the trade journal from disk."""
    try:
        if os.path.exists(TRADE_JOURNAL_FILE):
            with open(TRADE_JOURNAL_FILE, "r") as f:
                return json.load(f)
    except Exception as e:
        _log(f"Failed to load trade journal: {e}")
    return []


def _save_journal(journal):
    """Save the trade journal to disk."""
    try:
        with open(TRADE_JOURNAL_FILE, "w") as f:
            json.dump(journal, f, indent=2)
    except Exception as e:
        _log(f"Failed to save trade journal: {e}")


def get_recent_trades(lookback_days=None):
    """Get trades from the last N trading days."""
    if lookback_days is None:
        lookback_days = FEEDBACK_LOOKBACK_DAYS

    journal = _load_journal()
    if not journal:
        return []

    cutoff = (datetime.now() - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    return [t for t in journal if t.get("date", "") >= cutoff]


# --- Daily Analysis ---

def calculate_metrics(trades):
    """
    Calculate performance metrics from a list of trades.

    Returns dict with:
        - total_trades: int
        - win_rate: float (0-1)
        - avg_profit_pct: float (for wins)
        - avg_loss_pct: float (for losses)
        - avg_hold_time: float (seconds)
        - peak_vs_exit: float (avg of peak_profit - actual_exit for wins)
    """
    if not trades:
        return {
            "total_trades": 0,
            "win_rate": 0,
            "avg_profit_pct": 0,
            "avg_loss_pct": 0,
            "avg_hold_time": 0,
            "peak_vs_exit": 0,
        }

    total = len(trades)
    wins = [t for t in trades if t.get("result") == "WIN"]
    losses = [t for t in trades if t.get("result") == "LOSS"]

    win_rate = len(wins) / total if total > 0 else 0

    avg_profit = (
        sum(t["pnl_pct"] for t in wins) / len(wins)
        if wins else 0
    )

    avg_loss = (
        sum(t["pnl_pct"] for t in losses) / len(losses)
        if losses else 0
    )

    avg_hold = (
        sum(t.get("hold_time_seconds", 0) for t in trades) / total
        if total > 0 else 0
    )

    # Peak profit vs actual exit (how much profit was left on the table)
    peak_diffs = []
    for t in wins:
        peak = t.get("peak_profit_pct", t["pnl_pct"])
        actual = t["pnl_pct"]
        peak_diffs.append(peak - actual)
    peak_vs_exit = sum(peak_diffs) / len(peak_diffs) if peak_diffs else 0

    return {
        "total_trades": total,
        "win_rate": round(win_rate, 4),
        "avg_profit_pct": round(avg_profit, 2),
        "avg_loss_pct": round(avg_loss, 2),
        "avg_hold_time": round(avg_hold, 1),
        "peak_vs_exit": round(peak_vs_exit, 2),
    }


# --- Parameter Tuning ---

def load_current_params():
    """Load current tuned parameters, or defaults if none exist."""
    try:
        if os.path.exists(TUNED_PARAMS_FILE):
            with open(TUNED_PARAMS_FILE, "r") as f:
                params = json.load(f)
                # Validate bounds
                for key, spec in TUNABLE_PARAMS.items():
                    if key in params:
                        params[key] = max(spec["min"], min(spec["max"], params[key]))
                    else:
                        params[key] = spec["default"]
                return params
    except Exception as e:
        _log(f"Failed to load tuned params: {e}")

    # Return defaults
    return {key: spec["default"] for key, spec in TUNABLE_PARAMS.items()}


def save_tuned_params(params):
    """Save tuned parameters to disk."""
    try:
        params["updated_at"] = datetime.now().isoformat()
        with open(TUNED_PARAMS_FILE, "w") as f:
            json.dump(params, f, indent=2)
    except Exception as e:
        _log(f"Failed to save tuned params: {e}")


def tune_parameters(metrics, current_params):
    """
    Apply tuning logic based on metrics. Returns (new_params, adjustments_list).

    Tuning rules:
    1. MIN_CONFIDENCE:
       - Win rate > 60% → lower by 0.02 (take more trades)
       - Win rate < 40% → raise by 0.02 (be more selective)

    2. PROFIT_PARTIAL_EXIT_PCT:
       - If avg peak profit close to current threshold (within 1%) → keep
       - If winners peak at 4-5% → lower to match
       - If winners consistently run past 10% → raise

    3. TRADE_AGE_FORCE_EXIT:
       - If trades hitting time limit often recover → extend by 1 min
       - If they almost never recover → shorten by 1 min
    """
    new_params = deepcopy(current_params)
    adjustments = []

    # --- 1. MIN_CONFIDENCE ---
    spec = TUNABLE_PARAMS["MIN_CONFIDENCE"]
    old_val = current_params.get("MIN_CONFIDENCE", spec["default"])

    if metrics["total_trades"] >= 5:  # Need minimum sample size
        if metrics["win_rate"] > 0.60:
            new_val = max(spec["min"], old_val - spec["step"])
            if new_val != old_val:
                adjustments.append({
                    "parameter": "MIN_CONFIDENCE",
                    "previous": old_val,
                    "new": new_val,
                    "reason": f"Win rate {metrics['win_rate']*100:.0f}% > 60%, reducing confidence to take more trades",
                })
                new_params["MIN_CONFIDENCE"] = new_val
        elif metrics["win_rate"] < 0.40:
            new_val = min(spec["max"], old_val + spec["step"])
            if new_val != old_val:
                adjustments.append({
                    "parameter": "MIN_CONFIDENCE",
                    "previous": old_val,
                    "new": new_val,
                    "reason": f"Win rate {metrics['win_rate']*100:.0f}% < 40%, raising confidence to be more selective",
                })
                new_params["MIN_CONFIDENCE"] = new_val

    # --- 2. PROFIT_PARTIAL_EXIT_PCT ---
    spec = TUNABLE_PARAMS["PROFIT_PARTIAL_EXIT_PCT"]
    old_val = current_params.get("PROFIT_PARTIAL_EXIT_PCT", spec["default"])

    if metrics["total_trades"] >= 5 and metrics["avg_profit_pct"] > 0:
        avg_peak = metrics["avg_profit_pct"] + metrics["peak_vs_exit"]

        if avg_peak >= 10.0:
            # Winners consistently run past 10% → raise threshold
            new_val = min(spec["max"], old_val + spec["step"])
            if new_val != old_val:
                adjustments.append({
                    "parameter": "PROFIT_PARTIAL_EXIT_PCT",
                    "previous": old_val,
                    "new": new_val,
                    "reason": f"Avg peak profit {avg_peak:.1f}% > 10%, raising partial exit to capture more upside",
                })
                new_params["PROFIT_PARTIAL_EXIT_PCT"] = new_val
        elif avg_peak <= 5.0:
            # Winners peak at 4-5% → lower threshold
            new_val = max(spec["min"], old_val - spec["step"])
            if new_val != old_val:
                adjustments.append({
                    "parameter": "PROFIT_PARTIAL_EXIT_PCT",
                    "previous": old_val,
                    "new": new_val,
                    "reason": f"Avg peak profit {avg_peak:.1f}% <= 5%, lowering partial exit to lock in profits earlier",
                })
                new_params["PROFIT_PARTIAL_EXIT_PCT"] = new_val

    # --- 3. TRADE_AGE_FORCE_EXIT ---
    spec = TUNABLE_PARAMS["TRADE_AGE_FORCE_EXIT"]
    old_val = current_params.get("TRADE_AGE_FORCE_EXIT", spec["default"])

    # Check trades that hit the time limit
    time_limit_trades = [
        t for t in get_recent_trades()
        if "TRADE_AGE" in t.get("exit_reason", "") or "force exit" in t.get("exit_reason", "").lower()
    ]

    if len(time_limit_trades) >= 3:
        # Check if these trades would have recovered (positive peak after exit)
        recovered = sum(1 for t in time_limit_trades if t.get("peak_profit_pct", 0) > t.get("pnl_pct", 0) + 2)
        recovery_rate = recovered / len(time_limit_trades)

        if recovery_rate > 0.5:
            # More than half would have recovered → extend time
            new_val = min(spec["max"], old_val + spec["step"])
            if new_val != old_val:
                adjustments.append({
                    "parameter": "TRADE_AGE_FORCE_EXIT",
                    "previous": old_val,
                    "new": new_val,
                    "reason": f"Recovery rate {recovery_rate*100:.0f}% > 50% for time-limit exits, extending by 1 min",
                })
                new_params["TRADE_AGE_FORCE_EXIT"] = new_val
        elif recovery_rate < 0.2:
            # Almost never recover → shorten time
            new_val = max(spec["min"], old_val - spec["step"])
            if new_val != old_val:
                adjustments.append({
                    "parameter": "TRADE_AGE_FORCE_EXIT",
                    "previous": old_val,
                    "new": new_val,
                    "reason": f"Recovery rate {recovery_rate*100:.0f}% < 20% for time-limit exits, shortening by 1 min",
                })
                new_params["TRADE_AGE_FORCE_EXIT"] = new_val

    return new_params, adjustments


# --- Feedback Loop Runner ---

class FeedbackLoop:
    """
    Main Feedback Loop class. Run once pre-market.
    """

    def __init__(self, lookback_days=None):
        self.lookback_days = lookback_days or FEEDBACK_LOOKBACK_DAYS

    def run_daily_analysis(self):
        """
        Run the full daily analysis and parameter tuning.
        Returns the adjustment report dict.
        """
        _log("=" * 50)
        _log("Performance Feedback Loop — Daily Analysis")
        _log("=" * 50)

        if not FEEDBACK_ENABLED:
            _log("Feedback Loop is DISABLED. Set FEEDBACK_ENABLED=true to enable.")
            return {"status": "disabled"}

        # 1. Get recent trades
        trades = get_recent_trades(self.lookback_days)
        _log(f"Analyzing {len(trades)} trades from last {self.lookback_days} days")

        if len(trades) < 5:
            _log(f"Insufficient trade history ({len(trades)} < 5). Skipping tuning.")
            return {"status": "insufficient_data", "trade_count": len(trades)}

        # 2. Calculate metrics
        metrics = calculate_metrics(trades)
        _log(f"Metrics:")
        _log(f"  Win rate: {metrics['win_rate']*100:.1f}%")
        _log(f"  Avg profit (wins): {metrics['avg_profit_pct']:+.2f}%")
        _log(f"  Avg loss (losses): {metrics['avg_loss_pct']:+.2f}%")
        _log(f"  Avg hold time: {metrics['avg_hold_time']:.0f}s")
        _log(f"  Peak vs exit (left on table): {metrics['peak_vs_exit']:+.2f}%")

        # 3. Load current params
        current_params = load_current_params()
        _log(f"Current params: {current_params}")

        # 4. Tune parameters
        new_params, adjustments = tune_parameters(metrics, current_params)

        if adjustments:
            _log(f"Adjustments made:")
            for adj in adjustments:
                _log(f"  {adj['parameter']}: {adj['previous']} → {adj['new']} ({adj['reason']})")
            save_tuned_params(new_params)
        else:
            _log("No adjustments needed.")

        # 5. Log the adjustment report
        report = {
            "date": datetime.now().strftime("%Y-%m-%d"),
            "lookback_days": self.lookback_days,
            "metrics": metrics,
            "adjustments": adjustments,
            "previous_params": current_params,
            "new_params": {k: v for k, v in new_params.items() if k != "updated_at"},
        }
        self._log_adjustment(report)

        _log("=" * 50)
        return report

    def _log_adjustment(self, report):
        """Append adjustment report to the adjustments log file."""
        try:
            log = []
            if os.path.exists(FEEDBACK_ADJUSTMENTS_FILE):
                with open(FEEDBACK_ADJUSTMENTS_FILE, "r") as f:
                    log = json.load(f)

            log.append(report)

            with open(FEEDBACK_ADJUSTMENTS_FILE, "w") as f:
                json.dump(log, f, indent=2)
        except Exception as e:
            _log(f"Failed to log adjustment: {e}")


# --- Utility: Create trade record from position ---

def create_trade_record(instrument, position, exit_reason, momentum_at_entry=None):
    """
    Helper to create a trade journal record from a closed position dict.
    Called by the Executor after closing a position.
    """
    entry_price = position.get("entryPrice", 0)
    exit_price = position.get("exitPrice", position.get("currentPrice", 0))
    pnl_pct = position.get("pnlPercent", 0)

    # Calculate hold time
    hold_time = 0
    try:
        entry_time = datetime.strptime(position["entryTime"], "%Y-%m-%d %H:%M:%S")
        exit_time_str = position.get("exitTime", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        exit_time = datetime.strptime(exit_time_str, "%Y-%m-%d %H:%M:%S")
        hold_time = int((exit_time - entry_time).total_seconds())
    except (ValueError, KeyError):
        pass

    direction = "GO_CALL" if position.get("type") == "CALL_BUY" else "GO_PUT"

    return {
        "date": datetime.now().strftime("%Y-%m-%d"),
        "instrument": instrument,
        "direction": direction,
        "entry_price": entry_price,
        "exit_price": exit_price,
        "pnl_pct": round(pnl_pct, 2),
        "result": "WIN" if pnl_pct > 0 else "LOSS",
        "hold_time_seconds": hold_time,
        "exit_reason": exit_reason,
        "confidence_at_entry": position.get("confidence_at_entry", 0),
        "momentum_at_entry": momentum_at_entry or position.get("momentum_at_entry", 0),
        "peak_profit_pct": position.get("peak_profit_pct", max(0, pnl_pct)),
    }


# --- Standalone test ---

if __name__ == "__main__":
    print("=== Performance Feedback Loop Test ===\n")

    # Create some test trades
    test_trades = [
        {"date": datetime.now().strftime("%Y-%m-%d"), "instrument": "NIFTY_50",
         "direction": "GO_CALL", "entry_price": 100, "exit_price": 107,
         "pnl_pct": 7.0, "result": "WIN", "hold_time_seconds": 180,
         "exit_reason": "TARGET_PROFIT", "confidence_at_entry": 0.72,
         "momentum_at_entry": 75, "peak_profit_pct": 8.5},
        {"date": datetime.now().strftime("%Y-%m-%d"), "instrument": "NIFTY_50",
         "direction": "GO_PUT", "entry_price": 100, "exit_price": 96,
         "pnl_pct": -4.0, "result": "LOSS", "hold_time_seconds": 300,
         "exit_reason": "STOP_LOSS", "confidence_at_entry": 0.66,
         "momentum_at_entry": 45, "peak_profit_pct": 1.0},
        {"date": datetime.now().strftime("%Y-%m-%d"), "instrument": "BANKNIFTY",
         "direction": "GO_CALL", "entry_price": 200, "exit_price": 216,
         "pnl_pct": 8.0, "result": "WIN", "hold_time_seconds": 240,
         "exit_reason": "PROFIT_EXIT", "confidence_at_entry": 0.70,
         "momentum_at_entry": 80, "peak_profit_pct": 11.0},
        {"date": datetime.now().strftime("%Y-%m-%d"), "instrument": "BANKNIFTY",
         "direction": "GO_PUT", "entry_price": 150, "exit_price": 159,
         "pnl_pct": 6.0, "result": "WIN", "hold_time_seconds": 150,
         "exit_reason": "PARTIAL_EXIT", "confidence_at_entry": 0.68,
         "momentum_at_entry": 65, "peak_profit_pct": 7.5},
        {"date": datetime.now().strftime("%Y-%m-%d"), "instrument": "NIFTY_50",
         "direction": "GO_CALL", "entry_price": 120, "exit_price": 125,
         "pnl_pct": 4.2, "result": "WIN", "hold_time_seconds": 200,
         "exit_reason": "ADAPTIVE_EXIT", "confidence_at_entry": 0.71,
         "momentum_at_entry": 55, "peak_profit_pct": 5.0},
    ]

    # Log test trades
    for t in test_trades:
        log_trade_to_journal(t)

    # Calculate metrics
    metrics = calculate_metrics(test_trades)
    print(f"\nMetrics: {json.dumps(metrics, indent=2)}")

    # Test tuning
    current = load_current_params()
    print(f"\nCurrent params: {json.dumps(current, indent=2)}")

    new_params, adjustments = tune_parameters(metrics, current)
    print(f"\nNew params: {json.dumps(new_params, indent=2)}")
    print(f"Adjustments: {json.dumps(adjustments, indent=2)}")
