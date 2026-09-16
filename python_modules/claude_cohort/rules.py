"""Claude cohort — the decision rules.

Spec: docs/systems/13_claude_cohort.md §5 (entries) and §6 (exits).

Pure and stateless-per-call: `SessionState` carries everything that must be
remembered within a day, and every value it holds is derived only from rows
already seen. Nothing here reads a forward label — see config.BANNED_PREFIXES.

Two setups, judged separately (spec §8):
  A  break with flow behind it     — only in a trending market
  B  failed move, fade back to VWAP — allowed in chop
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from statistics import median
from typing import Optional

from .config import Params

# Columns the rules are allowed to read. Kept explicit so `assert_causal` has
# something concrete to check and so a typo fails loudly instead of silently
# evaluating NaN.
RULE_INPUTS = (
    "timestamp",
    "underlying_ltp",
    "is_market_open",
    "minutes_from_open",
    "minutes_to_close",
    "lunch_session_flag",
    "time_since_chain_sec",
    "is_expiry_day",
    "adx_5min",
    "rsi_14_5min",
    "underlying_ofi_20",
    "underlying_ofi_50",
    "underlying_tick_imbalance_20",
    "underlying_realized_vol_20",
    "dist_from_session_vwap_pct",
    "distance_to_opening_range_high_pct",
    "distance_to_opening_range_low_pct",
    "distance_to_day_high_pct",
    "distance_to_day_low_pct",
    "oi_weighted_ce_resistance_strike",
    "oi_weighted_pe_support_strike",
    "atm_ce_delta",
    "atm_pe_delta",
    "opt_0_ce_ltp",
    "opt_0_ce_bid",
    "opt_0_ce_ask",
    "opt_0_pe_ltp",
    "opt_0_pe_bid",
    "opt_0_pe_ask",
)

SETUP_A = "break_with_flow"
SETUP_B = "failed_move"


def _f(row, key, default=float("nan")) -> float:
    """Read a numeric field, mapping None/missing to NaN."""
    v = row.get(key, default)
    if v is None:
        return float("nan")
    try:
        return float(v)
    except (TypeError, ValueError):
        return float("nan")


def _ok(x: float) -> bool:
    return not math.isnan(x)


@dataclass
class Signal:
    setup: str
    leg: str          # "CE" or "PE"
    ts: float
    underlying: float
    stop_pts: float
    target_pts: float
    reason: str


@dataclass
class Position:
    setup: str
    leg: str
    entry_ts: float
    entry_underlying: float
    entry_premium: float      # what we actually paid (ask)
    stop_pts: float
    target_pts: float
    entry_ofi_sign: int
    # The CONTRACT this trade holds, locked at entry. Priced from the per-contract
    # book for its whole life — never from the rolling ATM slot, which changes
    # strike 434 times a day and made losing trades print as wins. See book.py.
    strike: float = 0.0
    lots: int = 1
    half_done: bool = False
    half_premium: float = 0.0   # premium received on the half exit
    peak_underlying: float = 0.0
    # First timestamp at which flow turned hard against us, reset whenever it
    # relents. A flip must PERSIST to count — see evaluate_exit.
    adverse_since: Optional[float] = None

    def stop_level(self) -> float:
        return (
            self.entry_underlying - self.stop_pts
            if self.leg == "CE"
            else self.entry_underlying + self.stop_pts
        )

    def target_level(self) -> float:
        return (
            self.entry_underlying + self.target_pts
            if self.leg == "CE"
            else self.entry_underlying - self.target_pts
        )

    def favourable_pts(self, underlying: float) -> float:
        return (
            underlying - self.entry_underlying
            if self.leg == "CE"
            else self.entry_underlying - underlying
        )


@dataclass
class SessionState:
    """Per-day memory. Everything here is causal."""

    vol_samples: list = field(default_factory=list)
    ofi_samples: list = field(default_factory=list)
    # rolling record of (ts, above_or_high, below_or_low, ofi_sign) at decision points
    recent: deque = field(default_factory=lambda: deque(maxlen=64))
    trades_today: int = 0
    losses_today: int = 0
    position: Optional[Position] = None

    def note_decision_point(self, ts: float, row) -> None:
        v = _f(row, "underlying_realized_vol_20")
        if _ok(v):
            self.vol_samples.append(v)
        f50 = _f(row, "underlying_ofi_50")
        if _ok(f50):
            self.ofi_samples.append(abs(f50))
        orh = _f(row, "distance_to_opening_range_high_pct")
        orl = _f(row, "distance_to_opening_range_low_pct")
        ofi = _f(row, "underlying_ofi_20")
        self.recent.append(
            (
                ts,
                _ok(orh) and orh > 0,
                _ok(orl) and orl < 0,
                (0 if not _ok(ofi) else (1 if ofi > 0 else (-1 if ofi < 0 else 0))),
            )
        )

    def vol_median(self) -> float:
        return median(self.vol_samples) if self.vol_samples else float("nan")

    def ofi_mag_median(self) -> float:
        """Session median of |ofi_50| so far — a causal, scale-free yardstick.

        Needed because raw OFI magnitude is not comparable across instruments
        (BANKNIFTY prints far larger numbers than NIFTY for the same pressure).
        """
        return median(self.ofi_samples) if self.ofi_samples else float("nan")


# ── session gate ─────────────────────────────────────────────────────────


def session_open_for_entries(row, p: Params) -> tuple[bool, str]:
    """Spec §4. Returns (allowed, reason_if_not)."""
    if _f(row, "is_market_open", 0) < 1:
        return False, "market_closed"
    mfo = _f(row, "minutes_from_open")
    if _ok(mfo) and mfo < p.open_skip_min:
        return False, "opening_noise"
    mtc = _f(row, "minutes_to_close")
    if _ok(mtc) and mtc < p.close_block_min:
        return False, "closing_window"
    if p.skip_lunch and _f(row, "lunch_session_flag", 0) >= 1:
        return False, "lunch"
    stale = _f(row, "time_since_chain_sec")
    if _ok(stale) and stale > p.max_chain_stale_sec:
        return False, "chain_stale"
    return True, ""


def risk_open(state: SessionState, p: Params) -> tuple[bool, str]:
    if state.trades_today >= p.max_trades_per_day:
        return False, "max_trades"
    if state.losses_today >= p.stop_after_losses:
        return False, "two_loss_rule"
    return True, ""


# ── shared gates ─────────────────────────────────────────────────────────


def stop_distance(row, p: Params) -> float:
    """Scale-invariant stop in underlying points.

    Findings bug 8: a flat percentage is 36 ticks on BANKNIFTY and under one tick
    on NATURALGAS. Floor it.
    """
    und = _f(row, "underlying_ltp")
    if not _ok(und) or und <= 0:
        return float("nan")
    return max(und * p.stop_pct / 100.0, p.min_stop_pts)


def wall_room_pts(row, leg: str) -> float:
    """Points between spot and the OI wall in the direction of the trade.

    NaN means 'no wall known' — the chain is missing, not that the way is clear.
    Callers treat NaN as permissive because chain staleness is gated separately.
    """
    und = _f(row, "underlying_ltp")
    if not _ok(und):
        return float("nan")
    if leg == "CE":
        wall = _f(row, "oi_weighted_ce_resistance_strike")
        if not _ok(wall) or wall <= 0:
            return float("nan")
        return wall - und
    wall = _f(row, "oi_weighted_pe_support_strike")
    if not _ok(wall) or wall <= 0:
        return float("nan")
    return und - wall


def liquidity_gate_quote(
    bid: float, ask: float, delta: float, target_pts: float, p: Params
) -> tuple[bool, str]:
    """Spec §5 cost gate against a concrete quote.

    Split out from `liquidity_gate` so the backtest can gate on the REAL
    contract's bid/ask from the per-contract book rather than on the rolling
    ATM slot.
    """
    delta = abs(delta)
    if not _ok(delta):
        return False, "no_delta"
    if not (p.delta_min <= delta <= p.delta_max):
        return False, "delta_band"
    if not _ok(bid) or not _ok(ask) or bid <= 0 or ask <= 0 or ask < bid:
        return False, "no_quote"
    # Rupee target on the option ~= underlying points x delta.
    target_rupees = target_pts * delta
    if target_rupees <= 0:
        return False, "no_target"
    if (ask - bid) > target_rupees * p.spread_max_pct_of_target / 100.0:
        return False, "spread_too_wide"
    return True, ""


def liquidity_gate(row, leg: str, target_pts: float, p: Params) -> tuple[bool, str]:
    """Row-based pre-filter. Valid at a single instant (the splice only corrupts
    a SERIES), so it is a cheap first pass; the book quote is authoritative."""
    return liquidity_gate_quote(
        _f(row, f"opt_0_{leg.lower()}_bid"),
        _f(row, f"opt_0_{leg.lower()}_ask"),
        _f(row, "atm_ce_delta" if leg == "CE" else "atm_pe_delta"),
        target_pts,
        p,
    )


# ── setup A: break with flow ─────────────────────────────────────────────


def detect_break(row, state: SessionState, p: Params) -> Optional[str]:
    """Return "CE" / "PE" if a break-with-flow is live, else None."""
    adx = _f(row, "adx_5min")
    if not _ok(adx) or adx < p.adx_min:
        return None  # chopping — setup A is not allowed

    vol = _f(row, "underlying_realized_vol_20")
    vmed = state.vol_median()
    if not _ok(vol) or not _ok(vmed) or vol < vmed * p.vol_expand_mult:
        return None  # drifting into the level, not expanding through it

    ofi = _f(row, "underlying_ofi_20")
    tick_imb = _f(row, "underlying_tick_imbalance_20")
    rsi = _f(row, "rsi_14_5min")
    if not _ok(ofi) or not _ok(tick_imb):
        return None

    orh = _f(row, "distance_to_opening_range_high_pct")
    orl = _f(row, "distance_to_opening_range_low_pct")
    dh = _f(row, "distance_to_day_high_pct")
    dl = _f(row, "distance_to_day_low_pct")

    up_break = (_ok(orh) and orh > 0) or (_ok(dh) and dh >= 0)
    down_break = (_ok(orl) and orl < 0) or (_ok(dl) and dl <= 0)

    if up_break and ofi > p.ofi_min and tick_imb > 0:
        if _ok(rsi) and rsi > p.rsi_max:
            return None  # exhausted
        return "CE"
    if down_break and ofi < -p.ofi_min and tick_imb < 0:
        if _ok(rsi) and rsi < (100.0 - p.rsi_max):
            return None
        return "PE"
    return None


# ── setup B: failed move ─────────────────────────────────────────────────


def detect_fade(row, state: SessionState, p: Params) -> Optional[str]:
    """Price poked through a level then came back, and flow flipped with it.

    Long PE after a failed upside break; long CE after a failed downside break.
    """
    ts = _f(row, "timestamp")
    if not _ok(ts) or not state.recent:
        return None
    ofi = _f(row, "underlying_ofi_20")
    if not _ok(ofi):
        return None

    orh = _f(row, "distance_to_opening_range_high_pct")
    orl = _f(row, "distance_to_opening_range_low_pct")
    now_above = _ok(orh) and orh > 0
    now_below = _ok(orl) and orl < 0

    window = p.fade_window_min * 60.0
    poked_up = poked_down = False
    poke_ofi_up = poke_ofi_down = 0
    for r_ts, above, below, sign in state.recent:
        if ts - r_ts > window:
            continue
        if above:
            poked_up = True
            poke_ofi_up = sign
        if below:
            poked_down = True
            poke_ofi_down = sign

    # failed upside break -> buy PE
    if poked_up and not now_above and poke_ofi_up >= 0 and ofi < -p.fade_ofi_flip:
        return "PE"
    # failed downside break -> buy CE
    if poked_down and not now_below and poke_ofi_down <= 0 and ofi > p.fade_ofi_flip:
        return "CE"
    return None


# ── entry ────────────────────────────────────────────────────────────────


def evaluate_entry(
    row,
    state: SessionState,
    p: Params,
    allow: tuple[str, ...] = (SETUP_A, SETUP_B),
    flow: Optional[dict] = None,
) -> Optional[Signal]:
    """One decision point. Returns a Signal or None.

    `allow` exists because spec §8 requires setups to be judged SEPARATELY —
    combining them before each is proven repeats the in-sample selection trap.
    """
    if state.position is not None:
        return None
    ok, _why = session_open_for_entries(row, p)
    if not ok:
        return None
    ok, _why = risk_open(state, p)
    if not ok:
        return None

    stop_pts = stop_distance(row, p)
    if not _ok(stop_pts):
        return None
    target_pts = min(stop_pts * p.target_r, p.max_target_pts)

    setup = leg = None
    if SETUP_A in allow:
        leg = detect_break(row, state, p)
        if leg:
            setup = SETUP_A
    if leg is None and SETUP_B in allow:
        leg = detect_fade(row, state, p)
        if leg:
            setup = SETUP_B
    if leg is None and SETUP_A2 in allow:
        leg = detect_break_pressure(row, flow or {}, p)
        if leg:
            setup = SETUP_A2
    if leg is None and SETUP_B2 in allow:
        leg = detect_rejection(row, flow or {}, p)
        if leg:
            setup = SETUP_B2
    if leg is None:
        return None

    # Room to the wall: if the wall sits inside the target, the target is gone.
    room = wall_room_pts(row, leg)
    if _ok(room) and room < target_pts * p.wall_room_mult:
        return None

    ok, _why = liquidity_gate(row, leg, target_pts, p)
    if not ok:
        return None

    return Signal(
        setup=setup,
        leg=leg,
        ts=_f(row, "timestamp"),
        underlying=_f(row, "underlying_ltp"),
        stop_pts=stop_pts,
        target_pts=target_pts,
        reason=setup,
    )


# ── exit ─────────────────────────────────────────────────────────────────


def evaluate_exit(
    row, pos: Position, p: Params, state: Optional[SessionState] = None, eod: bool = False
) -> Optional[str]:
    """Checked on EVERY feature row, not just decision points, so the stop has
    tick resolution rather than minute resolution.

    Returns an exit reason, or None to hold. "target_half" means take half off
    and keep running — the caller is responsible for not re-firing it.
    """
    if eod:
        return "eod"

    und = _f(row, "underlying_ltp")
    ts = _f(row, "timestamp")
    if not _ok(und):
        return None

    # Hard stop on the UNDERLYING, never the premium (spec §6). After the half
    # is off, the stop moves to breakeven.
    fav = pos.favourable_pts(und)
    stop_at = 0.0 if pos.half_done else -pos.stop_pts
    if fav <= stop_at:
        return "stop" if not pos.half_done else "breakeven_stop"

    if not pos.half_done and fav >= pos.target_pts:
        return "target_half" if p.half_off_at_target else "target"

    held_sec = (ts - pos.entry_ts) if _ok(ts) else 0.0

    # Flow-flip exit. The first version of this rule used a bare sign change on
    # `underlying_ofi_20` and produced a median hold of ONE MINUTE — measured
    # 2026-09-16, that series changes sign roughly every 30 s (762 flips in a
    # day). "Flow flips against me HARD" needs three things, not one:
    #   1. direction against the trade
    #   2. magnitude beyond the session's own normal (scale-free, causal)
    #   3. persistence for flow_flip_confirm_sec
    # plus a minimum hold so a trade is not shaken out before it can breathe.
    if p.flow_flip_exit and held_sec >= p.min_hold_min * 60.0:
        ofi = _f(row, "underlying_ofi_50")
        yard = state.ofi_mag_median() if state is not None else float("nan")
        thresh = (yard * p.flow_flip_mag_mult) if _ok(yard) else float("inf")
        want = 1 if pos.leg == "CE" else -1
        adverse = _ok(ofi) and abs(ofi) >= thresh and (1 if ofi > 0 else -1) == -want
        if adverse:
            if pos.adverse_since is None:
                pos.adverse_since = ts
            elif (ts - pos.adverse_since) >= p.flow_flip_confirm_sec:
                return "flow_flip"
        else:
            pos.adverse_since = None

    if _ok(ts) and held_sec >= p.time_stop_min * 60.0:
        return "time_stop"

    return None


# ─────────────────────────────────────────────────────────────────────────
# Flow-based setups (2026-09-17)
#
# The originals above stay as CONTROLS. Their baseline on 78 nifty50 days with
# real per-contract fills was break_with_flow -Rs 6,250 and failed_move
# -Rs 26,126 (0 of 6 months positive, 25% win). Both are kept so the flow work
# has to prove it beats them, rather than being assumed better.
#
# What was actually wrong with the originals:
#   * "flow" was one number, `underlying_ofi_20`, read as a bare sign
#   * "price came back" counted as a rejection with nothing confirming it
#   * nothing checked whether pressure was actually MOVING price (rule 7)
#   * nothing noticed the other side absorbing (rules 5, 6)
# ─────────────────────────────────────────────────────────────────────────

SETUP_A2 = "break_with_pressure"
SETUP_B2 = "rejection_confirmed"


def detect_break_pressure(row, flow: dict, p: Params) -> Optional[str]:
    """Setup A rewritten on the tape (rules 2, 3, 4, 7, 9, 6, 10).

    A break is only worth buying when aggressive volume is genuinely one-sided,
    price is RESPONDING to it, cumulative delta agrees, and the other side is
    neither absorbing it nor is our own side exhausted.
    """
    if not flow:
        return None
    pr = flow.get(f"pressure_{int(p.flow_window_sec)}s") or {}
    if not pr.get("n"):
        return None

    # Rule 7 — pressure without price movement is not a break.
    if not pr.get("price_responded"):
        return None

    ratio = pr.get("delta_ratio", 0.0)
    if abs(ratio) < p.delta_ratio_min:
        return None

    # Rule 9 — cumulative delta must agree over the same stretch.
    cd = flow.get(f"cumdelta_{int(p.flow_window_sec)}s") or {}
    if p.require_cumdelta_confirm and not cd.get("confirms"):
        return None

    want = "CE" if ratio > 0 else "PE"

    # Rules 5, 6 — if the other side is absorbing, the break is being sold into.
    absorb = flow.get("absorption")
    if absorb:
        if want == "CE" and absorb["type"] == "seller_absorption":
            return None
        if want == "PE" and absorb["type"] == "buyer_absorption":
            return None

    # Rule 10 — do not board aggression that is already fading.
    exh = flow.get("exhaustion")
    if exh:
        if want == "CE" and exh["type"] == "buyer_exhaustion":
            return None
        if want == "PE" and exh["type"] == "seller_exhaustion":
            return None

    # The level still has to actually break.
    lv = flow.get("levels") or {}
    px = flow.get("price")
    if not px or not lv.get("or_frozen"):
        return None
    if want == "CE" and not (
        (lv.get("or_high") and px > lv["or_high"]) or (lv.get("session_high") and px >= lv["session_high"])
    ):
        return None
    if want == "PE" and not (
        (lv.get("or_low") and px < lv["or_low"]) or (lv.get("session_low") and px <= lv["session_low"])
    ):
        return None

    # Chop filter is kept but can be swept away — the flow test may make it
    # redundant, and we want the data to say so rather than assuming it.
    adx = _f(row, "adx_5min")
    if p.adx_min > 0 and (not _ok(adx) or adx < p.adx_min):
        return None
    return want


def detect_rejection(row, flow: dict, p: Params) -> Optional[str]:
    """Setup B rewritten on the tape (rules 14, 5, 6, 10, 9).

    Rule 14 asks for confirmation by the SUBSEQUENT trades, not by the poke.
    So a rejection counts only when the prints on the way back are genuinely on
    the other side, and something corroborates it — the level absorbing the
    move, or the aggression that made the move running out.
    """
    if not flow:
        return None
    rejections = flow.get("rejections") or {}
    if not rejections:
        return None

    absorb = flow.get("absorption")
    exh = flow.get("exhaustion")

    # Prefer the opening-range levels, then the session extremes.
    for name in ("or_high", "or_low", "session_high", "session_low"):
        r = rejections.get(name)
        if not r or not r.get("confirmed"):
            continue

        want = "PE" if r["direction"] == "down" else "CE"

        # Rule 14 — the return has to be worth something, not a tick.
        und = _f(row, "underlying_ltp")
        if _ok(und) and und > 0:
            if r.get("back_by", 0.0) < und * p.rejection_min_back_pct / 100.0:
                continue

        if not p.require_corroboration:
            return want

        # Corroboration: the level absorbed the push, or the push exhausted.
        corroborated = False
        if absorb:
            if want == "PE" and absorb["type"] == "seller_absorption":
                corroborated = True     # sellers soaked up the buying at the high
            if want == "CE" and absorb["type"] == "buyer_absorption":
                corroborated = True
        if exh:
            if want == "PE" and exh["type"] == "buyer_exhaustion":
                corroborated = True
            if want == "CE" and exh["type"] == "seller_exhaustion":
                corroborated = True
        if corroborated:
            return want
    return None
