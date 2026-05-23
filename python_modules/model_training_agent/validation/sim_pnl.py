"""
sim_pnl.py — Single-number promotion gate for the trainer.

Per V2_MASTER_SPEC §2.3.4 (Option C, locked 2026-05-16): replay every
gate-fired signal across the held-out window, fill at the disadvantageous
side of the bid/ask each leg, subtract charges, sum. The resulting
`sim_pnl_total` decides "is this new model better than the old one"
(spec §2.3.4 + Sugg #5 Option B: promote iff mean across folds ≥
baseline × 1.20 AND per-trade expectancy ≥ +8 pts).

WHY
---
AUC and RMSE measure prediction quality but not money. A model can be
good at sorting winners from losers (high AUC) yet net negative once
slippage, spread, and charges eat the edge. Sim-PnL is the single
rupee-denominated metric the spec uses for promotion.

ARCHITECTURE (T26 v1, 2026-05-23)
---------------------------------
This first version runs on the SINGLE-SPLIT val set (matches today's
`.lgbm` source — see T24b spec deviation). Per-fold sim-PnL aggregation
is a follow-up; for v1 the trainer calls this once after the main loop
+ T25 calibration, writes `sim_pnl_scorecard.json` next to the
training manifest, and surfaces three scalars on the manifest itself
for the Saturday-automation gate (T27) to read.

GATE
----
First version uses the existing scalp gate
`signal_engine_agent.thresholds.decide_action_v2` (Wave 1 / Wave 2
60s-window logic). Once T29 ships the v2 multi-head router, swap the
gate fn at call site — the `gate_fn` parameter is the seam.

EXIT POLICY
-----------
Time-stop only in v1: hold for `exit_horizon_seconds` (default 60s,
matches scalp head horizon) then close at the bid/ask seen at the
horizon tick. TP/SL exit triggers (V2_MASTER_SPEC §2.5) are the
upgrade path — explicit TODO at the call site once L5 ladder is
implementation-ready.

CHARGES
-------
Placeholder constant per round-trip (`PLACEHOLDER_CHARGES_INR`) — the
real Charges_Spec module that breaks out brokerage / STT / GST /
exchange / SEBI is locked in spec but not yet implemented here.
Documented as a TODO; numbers are conservative-enough to be useful
without being a precise truth.

DATA REQUIREMENTS
-----------------
A val row participates in sim-PnL only when ALL these columns are
present and finite:
  - `opt_atm_ce_bid`, `opt_atm_ce_ask`  (for LONG_CE entry/exit)
  - `opt_atm_pe_bid`, `opt_atm_pe_ask`  (for LONG_PE entry/exit)
  - `tick_ts_ns`                          (for horizon-based exit)
Rows missing these are silently SKIPPED (counted in `n_skipped_no_data`
on the scorecard). Synthetic test fixtures don't carry option bid/ask
columns → scorecard reflects zero trades.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd


# Placeholder per-trade charges in INR — TODO: replace with real
# Charges_Spec.compute_total_cost() once that module lands. The spec's
# worked example (§2.3.4) uses ₹125 for an ATM NIFTY round-trip with
# 75-lot quantity, so this is a conservative average across instruments.
PLACEHOLDER_CHARGES_INR: float = 125.0

# Per-instrument round-lot defaults (NSE / MCX as of 2026-05). Kept
# here for the v1 scorecard; long-term these come from instrument
# profiles.
DEFAULT_LOT_SIZE: dict[str, int] = {
    "nifty50": 75,
    "banknifty": 30,
    "crudeoil": 100,
    "naturalgas": 1250,
}

# Exit horizon in seconds. 60s matches the shortest scalp head horizon
# and the spec's worked-example time-stop. Spec §2.5 will replace this
# with the TP/SL ladder once L5 lands.
DEFAULT_EXIT_HORIZON_SEC: float = 60.0


@dataclass(frozen=True)
class Trade:
    """One simulated round-trip."""

    signal_idx: int
    """Row index in the val DataFrame where the gate fired."""

    side: str
    """'LONG_CE' or 'LONG_PE' — extend to SHORT_* when shorts ship."""

    entry_price: float
    """The ask we paid (for longs) — spec §2.3.4."""

    exit_price: float
    """The bid we sold into at the horizon tick."""

    exit_reason: str
    """'time_stop' in v1; 'tp_hit' / 'sl_hit' once L5 ladder lands."""

    lot_size: int
    """Per-instrument round lot."""

    charges_inr: float
    """Round-trip charges; placeholder in v1, real Charges_Spec later."""

    @property
    def gross_pnl_inr(self) -> float:
        """(exit − entry) × lot, ignoring charges."""
        return (self.exit_price - self.entry_price) * self.lot_size

    @property
    def net_pnl_inr(self) -> float:
        """Gross minus charges — the per-signal contribution to sim_pnl_total."""
        return self.gross_pnl_inr - self.charges_inr

    @property
    def is_win(self) -> bool:
        """Boolean for win-rate aggregation."""
        return self.net_pnl_inr > 0.0


@dataclass
class Scorecard:
    """Aggregated sim-PnL scorecard for one model on one holdout window.

    Mirrors spec §2.3.4 + Sugg #5 promotion-gate thresholds. The fields
    that go into `manifest["sim_pnl_*"]` are listed in `manifest_summary()`.
    """

    n_signals: int = 0
    n_wins: int = 0
    n_skipped_no_data: int = 0
    n_skipped_other: int = 0
    total_pnl_inr: float = 0.0
    expectancy_inr: float = 0.0
    """Mean net PnL per signal — promotion gate uses ≥ ₹8/pt × lot_size."""

    win_rate: float = 0.0
    max_drawdown_inr: float = 0.0
    """Largest peak-to-trough drop in the cumulative-PnL curve."""

    trades: list[Trade] = field(default_factory=list)

    def manifest_summary(self) -> dict:
        """The compact dict the trainer copies into the manifest."""
        return {
            "sim_pnl_total_inr": float(self.total_pnl_inr),
            "sim_pnl_signals": int(self.n_signals),
            "sim_pnl_wins": int(self.n_wins),
            "sim_pnl_win_rate": float(self.win_rate),
            "sim_pnl_expectancy_inr": float(self.expectancy_inr),
            "sim_pnl_max_drawdown_inr": float(self.max_drawdown_inr),
            "sim_pnl_skipped_no_data": int(self.n_skipped_no_data),
            "sim_pnl_skipped_other": int(self.n_skipped_other),
        }

    def to_dict(self) -> dict:
        """Full scorecard incl. per-trade list — for the JSON sidecar."""
        return {
            **self.manifest_summary(),
            "trades": [asdict(t) for t in self.trades],
        }


def compute_scorecard(
    trades: list[Trade],
    *,
    n_skipped_no_data: int = 0,
    n_skipped_other: int = 0,
) -> Scorecard:
    """Pure aggregation: trades → scorecard. No side effects, no DataFrame.

    `n_skipped_no_data` / `n_skipped_other` are passed through so the
    caller can surface "how many gate fires didn't produce a trade
    because the row lacked required columns" alongside the executed
    trades.
    """
    sc = Scorecard(
        n_signals=len(trades),
        n_skipped_no_data=n_skipped_no_data,
        n_skipped_other=n_skipped_other,
        trades=list(trades),
    )
    if not trades:
        return sc

    pnls = np.array([t.net_pnl_inr for t in trades], dtype=np.float64)
    sc.n_wins = int(np.sum(pnls > 0.0))
    sc.total_pnl_inr = float(np.sum(pnls))
    sc.expectancy_inr = float(np.mean(pnls))
    sc.win_rate = float(sc.n_wins / sc.n_signals)

    # Max drawdown on the cumulative-PnL curve (signal-ordered).
    cum = np.cumsum(pnls)
    running_peak = np.maximum.accumulate(cum)
    drawdowns = running_peak - cum
    sc.max_drawdown_inr = float(np.max(drawdowns)) if len(drawdowns) else 0.0

    return sc


# Required option-price columns per side; rows missing any are skipped.
_REQUIRED_LONG_CE_COLS = ("opt_atm_ce_bid", "opt_atm_ce_ask")
_REQUIRED_LONG_PE_COLS = ("opt_atm_pe_bid", "opt_atm_pe_ask")


def _row_has_finite(row: pd.Series, cols: tuple[str, ...]) -> bool:
    """True iff every name in `cols` is present in `row` and finite."""
    for c in cols:
        if c not in row.index:
            return False
        v = row[c]
        if v is None or (isinstance(v, float) and not np.isfinite(v)):
            return False
    return True


def _find_horizon_row(
    df: pd.DataFrame,
    start_idx: int,
    horizon_sec: float,
    ts_col: str = "tick_ts_ns",
) -> int | None:
    """Locate the first row at or after `start_idx` whose timestamp
    advances by `horizon_sec` from `start_idx`'s timestamp. Returns
    `None` when the window runs off the end of `df` (signal at the
    very end of the val day → no exit available → skip the trade).
    """
    if ts_col not in df.columns or start_idx >= len(df):
        return None
    t0_ns = df.iloc[start_idx][ts_col]
    if not isinstance(t0_ns, (int, float, np.integer, np.floating)) or not np.isfinite(t0_ns):
        return None
    target_ns = float(t0_ns) + horizon_sec * 1e9
    # Linear forward scan; val sets are O(N) ticks per session so this
    # is fine. If profiling shows it as a hot path, swap for np.searchsorted.
    for j in range(start_idx + 1, len(df)):
        ts = df.iloc[j][ts_col]
        if isinstance(ts, (int, float, np.integer, np.floating)) and ts >= target_ns:
            return j
    return None


def simulate_trades(
    val_df: pd.DataFrame,
    *,
    signal_action_fn,
    instrument: str,
    exit_horizon_sec: float = DEFAULT_EXIT_HORIZON_SEC,
    charges_inr: float = PLACEHOLDER_CHARGES_INR,
    lot_size: int | None = None,
) -> Scorecard:
    """Replay-simulate every gate-fired signal in `val_df`.

    Args:
        val_df: the held-out validation rows, in tick order. Must carry
            the option-side columns named in `_REQUIRED_LONG_*` and a
            `tick_ts_ns` column for horizon resolution. Other columns
            are passed through to `signal_action_fn`.
        signal_action_fn: callable(row: pd.Series) -> str | None.
            Returns `"LONG_CE"`, `"LONG_PE"`, or None / `"SKIP"`. This
            is the seam the future T29 v2 gate plugs into; today it's
            invoked with a partially-applied wrapper around
            `decide_action_v2`.
        instrument: per-instrument lookup for default `lot_size`.
        exit_horizon_sec: hold time before time-stop exit.
        charges_inr: placeholder per-trade round-trip charges.
        lot_size: override; defaults to DEFAULT_LOT_SIZE[instrument].

    Returns a Scorecard. Rows where the gate didn't fire are ignored;
    rows where the gate fired but data is missing are counted in
    `n_skipped_no_data`.
    """
    lot = int(lot_size if lot_size is not None else DEFAULT_LOT_SIZE.get(instrument, 1))

    trades: list[Trade] = []
    n_skipped_no_data = 0
    n_skipped_other = 0

    for i in range(len(val_df)):
        row = val_df.iloc[i]
        action = signal_action_fn(row)
        if action in (None, "SKIP", ""):
            continue
        if action not in ("LONG_CE", "LONG_PE"):
            # Unknown action — count and skip rather than crash.
            n_skipped_other += 1
            continue

        cols = (
            _REQUIRED_LONG_CE_COLS if action == "LONG_CE"
            else _REQUIRED_LONG_PE_COLS
        )
        if not _row_has_finite(row, cols):
            n_skipped_no_data += 1
            continue

        exit_idx = _find_horizon_row(val_df, i, exit_horizon_sec)
        if exit_idx is None:
            n_skipped_other += 1
            continue
        exit_row = val_df.iloc[exit_idx]
        if not _row_has_finite(exit_row, cols):
            n_skipped_no_data += 1
            continue

        if action == "LONG_CE":
            entry = float(row["opt_atm_ce_ask"])
            exit_price = float(exit_row["opt_atm_ce_bid"])
        else:
            entry = float(row["opt_atm_pe_ask"])
            exit_price = float(exit_row["opt_atm_pe_bid"])

        trades.append(Trade(
            signal_idx=int(i),
            side=action,
            entry_price=entry,
            exit_price=exit_price,
            exit_reason="time_stop",
            lot_size=lot,
            charges_inr=float(charges_inr),
        ))

    return compute_scorecard(
        trades,
        n_skipped_no_data=n_skipped_no_data,
        n_skipped_other=n_skipped_other,
    )


def write_scorecard_json(scorecard: Scorecard, path: Path) -> None:
    """Write the full scorecard (incl. per-trade list) to `path` as JSON."""
    path.write_text(json.dumps(scorecard.to_dict(), indent=2), encoding="utf-8")
