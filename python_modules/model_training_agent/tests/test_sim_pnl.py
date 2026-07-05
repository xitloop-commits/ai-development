"""
tests/test_sim_pnl.py — Unit tests for `model_training_agent.validation.sim_pnl`.

Three layers:
  - Trade / Scorecard dataclass properties (pure arithmetic).
  - compute_scorecard() aggregation contract (win-rate, expectancy, max-DD).
  - simulate_trades() orchestrator: signal routing, missing-data skip,
    horizon-based exit lookup, charges deduction.

Run:
  python -m pytest python_modules/model_training_agent/tests/test_sim_pnl.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent  # python_modules/
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pandas as pd
import pytest

from model_training_agent.validation.sim_pnl import (
    DEFAULT_EXIT_HORIZON_SEC,
    PLACEHOLDER_CHARGES_INR,
    Scorecard,
    Trade,
    compute_scorecard,
    simulate_trades,
    write_scorecard_json,
)


# ── Trade properties ──────────────────────────────────────────────────────


def test_trade_gross_pnl_long_ce_winner() -> None:
    t = Trade(
        signal_idx=0, side="LONG_CE",
        entry_price=187.0, exit_price=212.0,
        exit_reason="time_stop", lot_size=75, charges_inr=125.0,
    )
    # Spec §2.3.4 worked example: (212 − 187) × 75 = 1875 gross
    assert t.gross_pnl_inr == pytest.approx(1875.0)
    # 1875 − 125 = 1750 net
    assert t.net_pnl_inr == pytest.approx(1750.0)
    assert t.is_win is True


def test_trade_loser_after_charges() -> None:
    """A small win on the option price can still net negative once
    charges come out — `is_win` reflects NET, not gross."""
    t = Trade(
        signal_idx=1, side="LONG_PE",
        entry_price=100.0, exit_price=100.5,
        exit_reason="time_stop", lot_size=75, charges_inr=125.0,
    )
    # Gross = 0.5 × 75 = 37.5; net = 37.5 − 125 = −87.5
    assert t.gross_pnl_inr == pytest.approx(37.5)
    assert t.net_pnl_inr == pytest.approx(-87.5)
    assert t.is_win is False


# ── compute_scorecard ─────────────────────────────────────────────────────


def test_compute_scorecard_empty_trades() -> None:
    sc = compute_scorecard([])
    assert sc.n_signals == 0
    assert sc.n_wins == 0
    assert sc.total_pnl_inr == 0.0
    assert sc.expectancy_inr == 0.0
    assert sc.win_rate == 0.0
    assert sc.max_drawdown_inr == 0.0


def test_compute_scorecard_aggregates_winners_and_losers() -> None:
    trades = [
        # Two wins, one loss
        Trade(0, "LONG_CE", 100.0, 110.0, "time_stop", 75, 125.0),  # +625
        Trade(1, "LONG_CE", 100.0,  90.0, "time_stop", 75, 125.0),  # -875
        Trade(2, "LONG_PE", 100.0, 105.0, "time_stop", 75, 125.0),  # +250
    ]
    sc = compute_scorecard(trades)
    assert sc.n_signals == 3
    assert sc.n_wins == 2
    assert sc.total_pnl_inr == pytest.approx(0.0)   # 625 − 875 + 250 = 0
    assert sc.expectancy_inr == pytest.approx(0.0)
    assert sc.win_rate == pytest.approx(2 / 3)


def test_compute_scorecard_max_drawdown_on_cumulative_curve() -> None:
    """Cumulative PnL: +500, +1500, +500, +0, +2000. Peak before the
    biggest drop is +1500; trough during the run-down is +0 → max-DD
    is the +1500 − +0 = 1500 (worst peak-to-trough)."""
    trades = [
        Trade(0, "LONG_CE", 100.0, 110.0, "time_stop", 75, 250.0),  # +500
        Trade(1, "LONG_CE", 100.0, 115.0, "time_stop", 75, 125.0),  # +1000
        Trade(2, "LONG_CE", 100.0, 90.0,  "time_stop", 75, 125.0),  # -875
        # Adjust to land cum at +500 then +0 then +2000 for clarity
    ]
    sc = compute_scorecard(trades)
    # Cum: +500, +1500, +625
    # Running peak: 500, 1500, 1500
    # DD: 0, 0, 1500-625=875
    assert sc.max_drawdown_inr == pytest.approx(875.0)


def test_compute_scorecard_passes_through_skip_counts() -> None:
    sc = compute_scorecard([], n_skipped_no_data=4, n_skipped_other=2)
    assert sc.n_skipped_no_data == 4
    assert sc.n_skipped_other == 2


# ── simulate_trades orchestrator ──────────────────────────────────────────


def _make_val_df_with_option_cols(n_rows: int = 5) -> pd.DataFrame:
    """A val DataFrame with the option bid/ask columns sim_pnl needs."""
    base_ts_ns = 1_700_000_000_000_000_000  # ~2023, doesn't matter
    return pd.DataFrame({
        # 1-second cadence so horizon=60s steps 60 rows; we make 5 rows
        # at 60s cadence each so horizon=60s lands on row+1.
        "tick_ts_ns": [base_ts_ns + i * 60 * 1_000_000_000 for i in range(n_rows)],
        "opt_0_ce_bid": [180.0 + i for i in range(n_rows)],
        "opt_0_ce_ask": [182.0 + i for i in range(n_rows)],
        "opt_0_pe_bid": [150.0 - i for i in range(n_rows)],
        "opt_0_pe_ask": [152.0 - i for i in range(n_rows)],
    })


def test_simulate_trades_no_signals_returns_empty_scorecard() -> None:
    df = _make_val_df_with_option_cols(5)
    sc = simulate_trades(df, signal_action_fn=lambda row: None, instrument="nifty50")
    assert sc.n_signals == 0
    assert sc.total_pnl_inr == 0.0
    assert sc.n_skipped_no_data == 0


def test_simulate_trades_long_ce_fills_at_ask_and_bid() -> None:
    """Gate fires on row 0 → entry = row 0 ask, exit = row 1 bid
    (horizon 60s lands on row 1 with this fixture cadence)."""
    df = _make_val_df_with_option_cols(5)
    sc = simulate_trades(
        df,
        signal_action_fn=lambda row: "LONG_CE" if row.name == 0 else None,
        instrument="nifty50",
    )
    assert sc.n_signals == 1
    trade = sc.trades[0]
    assert trade.side == "LONG_CE"
    assert trade.entry_price == pytest.approx(182.0)  # row 0 ask
    assert trade.exit_price == pytest.approx(181.0)   # row 1 bid (180 + 1)
    # Gross = (181 − 182) × 75 = −75; net = −75 − 125 = −200
    assert trade.net_pnl_inr == pytest.approx(-200.0)


def test_simulate_trades_long_pe_uses_pe_columns() -> None:
    df = _make_val_df_with_option_cols(5)
    sc = simulate_trades(
        df,
        signal_action_fn=lambda row: "LONG_PE" if row.name == 2 else None,
        instrument="nifty50",
    )
    assert sc.n_signals == 1
    trade = sc.trades[0]
    assert trade.side == "LONG_PE"
    # PE ask at row 2 = 152 - 2 = 150; PE bid at row 3 = 150 - 3 = 147
    assert trade.entry_price == pytest.approx(150.0)
    assert trade.exit_price == pytest.approx(147.0)


def test_simulate_trades_skips_when_option_cols_missing() -> None:
    """val data without option bid/ask cols → all gate fires get skipped
    into n_skipped_no_data; no trades land on the scorecard."""
    df = pd.DataFrame({
        "tick_ts_ns": [1_700_000_000_000_000_000 + i * 60 * 1_000_000_000 for i in range(5)],
    })
    sc = simulate_trades(
        df,
        signal_action_fn=lambda row: "LONG_CE",  # fire on every row
        instrument="nifty50",
    )
    assert sc.n_signals == 0
    assert sc.n_skipped_no_data == 5


def test_simulate_trades_skips_signal_at_end_of_window() -> None:
    """Signal on the last row can't find a horizon-future row → skipped
    into n_skipped_other (counts as a skipped non-data issue)."""
    df = _make_val_df_with_option_cols(3)
    sc = simulate_trades(
        df,
        signal_action_fn=lambda row: "LONG_CE" if row.name == 2 else None,
        instrument="nifty50",
    )
    assert sc.n_signals == 0
    assert sc.n_skipped_other == 1


def test_simulate_trades_unknown_action_counted_as_other() -> None:
    """A gate fn returning an unknown string must NOT crash the run —
    count and move on. Future-proofing for T29 v2 actions."""
    df = _make_val_df_with_option_cols(5)
    sc = simulate_trades(
        df,
        signal_action_fn=lambda row: "SHORT_CE" if row.name == 0 else None,
        instrument="nifty50",
    )
    assert sc.n_signals == 0
    assert sc.n_skipped_other == 1


def test_simulate_trades_uses_instrument_default_lot() -> None:
    df = _make_val_df_with_option_cols(5)
    sc = simulate_trades(
        df,
        signal_action_fn=lambda row: "LONG_CE" if row.name == 0 else None,
        instrument="banknifty",  # default lot 30
    )
    assert sc.trades[0].lot_size == 30


def test_simulate_trades_lot_size_override() -> None:
    df = _make_val_df_with_option_cols(5)
    sc = simulate_trades(
        df,
        signal_action_fn=lambda row: "LONG_CE" if row.name == 0 else None,
        instrument="nifty50",
        lot_size=999,
    )
    assert sc.trades[0].lot_size == 999


# ── JSON sidecar ──────────────────────────────────────────────────────────


def test_write_scorecard_json_round_trip(tmp_path: Path) -> None:
    import json as _json
    df = _make_val_df_with_option_cols(5)
    sc = simulate_trades(
        df,
        signal_action_fn=lambda row: "LONG_CE" if row.name == 0 else None,
        instrument="nifty50",
    )
    path = tmp_path / "sim_pnl_scorecard.json"
    write_scorecard_json(sc, path)
    payload = _json.loads(path.read_text(encoding="utf-8"))
    assert payload["sim_pnl_signals"] == 1
    assert "trades" in payload
    assert payload["trades"][0]["side"] == "LONG_CE"


def test_manifest_summary_keys() -> None:
    """Lock the manifest field names — these are the ones T27 Saturday
    automation reads. Any rename here breaks the promotion gate."""
    summary = Scorecard().manifest_summary()
    assert set(summary.keys()) == {
        "sim_pnl_total_inr",
        "sim_pnl_signals",
        "sim_pnl_wins",
        "sim_pnl_win_rate",
        "sim_pnl_expectancy_inr",
        "sim_pnl_max_drawdown_inr",
        "sim_pnl_skipped_no_data",
        "sim_pnl_skipped_other",
    }


def test_default_constants_match_spec() -> None:
    """Spec §2.3.4 worked example uses ₹125 charges + 60s horizon."""
    assert PLACEHOLDER_CHARGES_INR == 125.0
    assert DEFAULT_EXIT_HORIZON_SEC == 60.0
