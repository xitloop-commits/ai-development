"""Claude cohort — constants, charges, and the sweepable rule parameters.

Spec: docs/systems/13_claude_cohort.md

Everything a human tuned is in `Params`. Everything statutory or empirical is a
module constant with the evidence for it written down next to it.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Iterator

# ── Lot sizes ────────────────────────────────────────────────────────────
# Derived EMPIRICALLY 2026-09-16, not copied from a stale table: every `ltq`
# in the recorded option ticks is an exact multiple of these.
#   nifty50  2026-09-11: 35,804 ticks, GCD(ltq) = 65, min = 65
#   banknifty 2026-09-04: 38,863 ticks, GCD(ltq) = 30, min = 30
# Note the repo disagreed with itself before this check:
#   blast_model/backtest.py said nifty 65  (correct)
#   model_training_agent/validation/sim_pnl.py said 75 (stale)
LOT_SIZES = {"nifty50": 65, "banknifty": 30, "crudeoil": 100, "naturalgas": 1250}

# Square-off time per instrument. No new entries after ENTRY_CUT.
EOD_CUTS = {"nifty50": "15:20", "banknifty": "15:20", "crudeoil": "23:15", "naturalgas": "23:15"}

# ── Charges ──────────────────────────────────────────────────────────────
# Mirrors production DEFAULT_CHARGES in server/userSettings.ts:204-211, which is
# the single source of truth (rates persist in Mongo and self-heal to the
# statutory values in CURRENT_STATUTORY_RATES).
#
# WARNING: python_modules/blast_model/backtest.py uses STALE rates —
# STT 0.0625% (actual: 0.15%) and txn 0.05030% (actual: 0.03553%). Its net
# results are therefore optimistic. Do not copy them. See T183.
BROKERAGE_PER_ORDER = 20.0   # flat, Dhan
STT_SELL_PCT = 0.15          # % of sell premium, from 2026-04-01
EXCHANGE_TXN_PCT = 0.03553   # % of premium, both sides (NSE options)
GST_PCT = 18.0               # on brokerage + exchange txn
SEBI_PCT = 0.0001            # % of turnover both sides
STAMP_BUY_PCT = 0.003        # % of buy premium

# MCX differs; only needed when crude/gas join (C1 says later).
MCX_CTT_SELL_PCT = 0.05
MCX_TXN_PCT = 0.0418
MCX_STAMP_BUY_PCT = 0.002


def round_trip_charges(buy_value: float, sell_value: float, exchange: str = "NSE") -> float:
    """Total charges for one long-option round trip (buy then sell).

    Mirrors server/portfolio/charges.ts: STT and stamp duty round to the nearest
    rupee (contract-note behaviour), everything else to 2 decimals.
    """
    brokerage = round(BROKERAGE_PER_ORDER * 2, 2)
    if exchange == "MCX":
        exch = round((buy_value + sell_value) * MCX_TXN_PCT / 100.0, 2)
        levy = float(round(sell_value * MCX_CTT_SELL_PCT / 100.0))
        stamp = float(round(buy_value * MCX_STAMP_BUY_PCT / 100.0))
    else:
        exch = round((buy_value + sell_value) * EXCHANGE_TXN_PCT / 100.0, 2)
        levy = float(round(sell_value * STT_SELL_PCT / 100.0))
        stamp = float(round(buy_value * STAMP_BUY_PCT / 100.0))
    gst = round((brokerage + exch) * GST_PCT / 100.0, 2)
    sebi = round((buy_value + sell_value) * SEBI_PCT / 100.0, 2)
    return round(brokerage + exch + levy + gst + sebi + stamp, 2)


def exchange_for(instrument: str) -> str:
    return "MCX" if instrument in ("crudeoil", "naturalgas") else "NSE"


# ── Look-ahead ban list ──────────────────────────────────────────────────
# The feature parquet carries FORWARD labels written by TFA's targets module.
# Using any of them as a rule input fabricates edge. Spec §8.
#
# The 2026-09-15 audit caught exactly this: classifying an entry by the leg
# containing it used that leg's END, producing a fake 70%-win / +Rs 432,594
# result. The causal version was -Rs 383,155.
BANNED_PREFIXES = (
    "max_upside_",
    "max_drawdown_",
    "risk_reward_ratio_",
    "direction_",
    "trend_",
    "swing_",
    "favorable_",
    "label_",
    "target_",
)


def is_banned(col: str) -> bool:
    """True if `col` is a forward label that cannot be known at decision time."""
    return col.startswith(BANNED_PREFIXES)


def assert_causal(columns) -> None:
    """Raise if any rule input is a forward label. Called before every run."""
    bad = sorted(c for c in columns if is_banned(c))
    if bad:
        raise ValueError(
            f"LOOK-AHEAD: {len(bad)} forward-label column(s) used as rule inputs: {bad[:10]}"
        )


# ── Rule parameters ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class Params:
    """Every hand-chosen number lives here so the sweep can move it.

    Defaults are the session-2026-09-16 starting points from spec §5/§6. They are
    NOT tested truths — that is what the backtest decides.
    """

    # -- session filters (spec §4)
    open_skip_min: float = 15.0        # no entries in the first N minutes
    close_block_min: float = 30.0      # no entries inside the last N minutes
    skip_lunch: bool = True
    max_chain_stale_sec: float = 120.0

    # -- setup A: break with flow
    adx_min: float = 20.0              # below this the market is chopping
    rsi_max: float = 72.0              # already exhausted above this
    ofi_min: float = 0.0               # flow must push the same way
    vol_expand_mult: float = 1.0       # realized vol vs session median so far

    # -- setup B: failed move (fade)
    fade_window_min: float = 10.0      # poke-through must reverse within this
    fade_ofi_flip: float = 0.0         # flow must flip against the break

    # -- liquidity / cost gate (spec §5)
    spread_max_pct_of_target: float = 10.0
    delta_min: float = 0.45
    delta_max: float = 0.60

    # -- exits (spec §6)
    stop_pct: float = 0.10             # % of underlying
    min_stop_pts: float = 8.0          # scale-invariant floor (bug 8)
    target_r: float = 2.0              # target = R x stop distance
    max_target_pts: float = 200.0
    wall_room_mult: float = 1.0        # wall must be > mult x target away
    time_stop_min: float = 30.0
    # Flow-flip exit. Measured 2026-09-16: `underlying_ofi_20` changes sign ~762
    # times a day (every ~30 s), so a bare sign flip is noise, not information.
    # A flip must be hard (magnitude vs the session's own median |ofi_50|) and
    # must persist, and cannot fire inside the first `min_hold_min`.
    flow_flip_exit: bool = True
    flow_flip_mag_mult: float = 2.0     # x session median |ofi_50| so far
    flow_flip_confirm_sec: float = 45.0
    min_hold_min: float = 5.0
    half_off_at_target: bool = True    # take half at T1, trail the rest
    expiry_day_shrink: float = 0.5     # halve hold times on expiry day

    # -- flow-based setups (2026-09-17, Partha's 15-rule spec)
    flow_window_sec: float = 300.0     # rule 15 confirmation window
    delta_ratio_min: float = 0.25      # rules 2,3,8 — how one-sided is one-sided
    require_cumdelta_confirm: bool = True   # rule 9
    rejection_min_back_pct: float = 0.05    # rule 14 — a real return, not a tick
    require_corroboration: bool = True      # rules 5,6,10 must back rule 14

    # -- risk (spec §4)
    max_trades_per_day: int = 3
    stop_after_losses: int = 2

    def scaled_for_expiry(self, is_expiry_day: bool) -> "Params":
        if not is_expiry_day:
            return self
        return replace(self, time_stop_min=self.time_stop_min * self.expiry_day_shrink)


# Deliberately small grid. The 2026-09-15 audit warns that 432 combinations were
# searched for blast and "some will look good by chance". Fewer knobs, fewer lies.
SWEEP_GRID = {
    "adx_min": [15.0, 20.0, 25.0],
    "stop_pct": [0.08, 0.10, 0.15],
    "target_r": [1.5, 2.0, 3.0],
    "time_stop_min": [20.0, 30.0, 45.0],
}


def sweep_params(base: Params = Params()) -> Iterator[Params]:
    """Yield every combination in SWEEP_GRID applied to `base`."""
    import itertools

    keys = sorted(SWEEP_GRID)
    for combo in itertools.product(*(SWEEP_GRID[k] for k in keys)):
        yield replace(base, **dict(zip(keys, combo)))
