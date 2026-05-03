"""
chain_cache.py — Snapshot-derived feature cache for TFA.

ChainCache sits between the chain_poller (REST, every 5s) and the feature
engine (per-tick). It holds the computed chain state that all feature modules
read from on every tick.

Update lifecycle:
  1. Chain poller calls update_from_snapshot(snapshot) on every valid REST poll.
     → Full refresh: global features recomputed, ATM recalculated from
       snapshot.spot_price, active strikes re-selected, snapshots rotated.
  2. Tick processor calls refresh_atm_zone(spot) whenever the WS spot price
     shifts the computed ATM to a different strike.
     → Partial refresh: only ATM-zone fields updated; global features untouched.
  3. reset() is called on session start and expiry rollover.

Two-snapshot memory:
  ChainCache retains the current snapshot and the previous one.
  The previous is used by compute_strike_scores() to calculate vol_diff.
  Only 2 snapshots are held at any time — older ones are dropped.

Thread safety:
  All methods run on the asyncio event loop (single thread). No locks needed.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from tick_feature_agent.features.active_strikes import (
    StrikeScore,
    compute_strike_scores,
    select_active_strikes,
)
from tick_feature_agent.features.atm import (
    atm_shifted,
    compute_atm,
    compute_atm_window,
)
from tick_feature_agent.feed.chain_poller import ChainSnapshot


@dataclass
class ChainCache:
    """
    Snapshot-derived feature cache.

    Attributes:
        chain_available:    True after the first valid snapshot is received.
        vol_diff_available: True after the second snapshot (vol_diff baseline exists).
        snapshot:           Current validated chain snapshot (or None).
        prev_snapshot:      Previous snapshot (or None on first update).
        strike_step:        Detected strike step — set from snapshot, not updated mid-session.
        atm:                Current ATM strike, derived from spot_price.
        atm_window:         7-element window [ATM-3s … ATM+3s].
        active_strikes:     0–6 active StrikeScore objects, descending strength.

        Global chain features (recomputed on every snapshot):
            pcr_global      put_oi_total / call_oi_total  (None if call_oi == 0)
            oi_total_call   Sum callOI across all strikes.
            oi_total_put    Sum putOI across all strikes.
            oi_change_call  Sum callOIChange across all strikes.
            oi_change_put   Sum putOIChange across all strikes.

        ATM-zone chain features (recomputed on snapshot + ATM shift):
            pcr_atm             put_oi_atm / call_oi_atm  (None if call_oi_atm == 0)
            oi_change_call_atm  Sum callOIChange for ATM window strikes.
            oi_change_put_atm   Sum putOIChange for ATM window strikes.
            oi_imbalance_atm    (call_chg_atm - put_chg_atm) /
                                (|call_chg_atm| + |put_chg_atm|)
                                Range [−1, +1], None if both changes are 0.

        last_snapshot_ts:   monotonic time of last full snapshot update.
    """

    # Availability flags
    chain_available: bool = False
    vol_diff_available: bool = False

    # Snapshots (current + previous for vol_diff)
    snapshot: ChainSnapshot | None = None
    prev_snapshot: ChainSnapshot | None = None

    # ATM context
    strike_step: int | None = None
    atm: int | None = None
    atm_window: list[int] = field(default_factory=list)
    active_strikes: list[StrikeScore] = field(default_factory=list)

    # Global chain features
    pcr_global: float | None = None
    oi_total_call: float = 0.0
    oi_total_put: float = 0.0
    oi_change_call: float = 0.0
    oi_change_put: float = 0.0

    # ATM-zone chain features
    pcr_atm: float | None = None
    oi_change_call_atm: float = 0.0
    oi_change_put_atm: float = 0.0
    oi_imbalance_atm: float | None = None

    # ATM-zone volume diffs (None until second snapshot — vol_diff_available)
    call_vol_diff_atm: float | None = None
    put_vol_diff_atm: float | None = None

    # Metadata
    last_snapshot_ts: float = 0.0

    # ── Public methods ────────────────────────────────────────────────────────

    def update_from_snapshot(self, snapshot: ChainSnapshot) -> bool:
        """
        Full refresh from a new REST chain snapshot.

        Called by chain_poller every ~5s. Uses snapshot.spot_price for ATM
        computation (the REST response always includes the current spot).

        Returns:
            True if the ATM strike changed compared to the previous value.
        """
        # Rotate snapshots (keep at most 2)
        self.prev_snapshot = self.snapshot
        self.snapshot = snapshot
        self.last_snapshot_ts = time.monotonic()

        # Availability flags
        self.chain_available = True
        if self.prev_snapshot is not None:
            self.vol_diff_available = True

        # ATM context
        self.strike_step = snapshot.strike_step
        old_atm = self.atm
        self.atm = compute_atm(snapshot.spot_price, self.strike_step)
        self.atm_window = compute_atm_window(self.atm, self.strike_step)
        shifted = atm_shifted(old_atm, self.atm)

        # Active strikes
        prev_rows = self.prev_snapshot.rows if self.prev_snapshot else None
        scores = compute_strike_scores(snapshot.rows, prev_rows)
        self.active_strikes = select_active_strikes(
            scores, snapshot.spot_price, self.vol_diff_available
        )

        # Chain features
        self._compute_global_features(snapshot)
        self._compute_atm_zone_features(snapshot, self.atm_window)

        return shifted

    def refresh_atm_zone(self, spot: float) -> bool:
        """
        Partial refresh triggered when the WS spot price shifts the ATM strike.

        Called by the tick processor after each underlying tick. Recomputes
        ATM, window, active_strikes, and ATM-zone features using the stored
        snapshot. Global features are NOT recomputed (they haven't changed —
        the REST snapshot hasn't changed).

        vol_diff_available is NOT reset.

        Returns:
            True if the ATM actually shifted; False if spot is still in the
            same ATM bucket (no-op).
        """
        if not self.chain_available or self.snapshot is None or self.strike_step is None:
            return False

        old_atm = self.atm
        new_atm = compute_atm(spot, self.strike_step)
        if not atm_shifted(old_atm, new_atm):
            return False

        self.atm = new_atm
        self.atm_window = compute_atm_window(self.atm, self.strike_step)

        # Re-select active strikes with updated spot (scores are snapshot-derived,
        # tiebreaker changes with spot; recompute scores from stored snapshot)
        prev_rows = self.prev_snapshot.rows if self.prev_snapshot else None
        scores = compute_strike_scores(self.snapshot.rows, prev_rows)
        self.active_strikes = select_active_strikes(scores, spot, self.vol_diff_available)

        # ATM-zone features only
        self._compute_atm_zone_features(self.snapshot, self.atm_window)
        return True

    def reset(self) -> None:
        """
        Reset to initial state.

        Called on session start (SessionManager._on_session_open) and expiry
        rollover (SessionManager.trigger_expiry_rollover).

        strike_step is intentionally retained — it is set at startup from the
        first chain snapshot and does not change during a session or across
        same-contract rollovers.
        """
        self.chain_available = False
        self.vol_diff_available = False
        self.snapshot = None
        self.prev_snapshot = None
        # atm/atm_window/active_strikes cleared but strike_step kept
        self.atm = None
        self.atm_window = []
        self.active_strikes = []
        # Global features
        self.pcr_global = None
        self.oi_total_call = 0.0
        self.oi_total_put = 0.0
        self.oi_change_call = 0.0
        self.oi_change_put = 0.0
        # ATM-zone features
        self.pcr_atm = None
        self.oi_change_call_atm = 0.0
        self.oi_change_put_atm = 0.0
        self.oi_imbalance_atm = None
        self.call_vol_diff_atm = None
        self.put_vol_diff_atm = None
        self.last_snapshot_ts = 0.0

    # ── Internal ─────────────────────────────────────────────────────────────

    def _compute_global_features(self, snapshot: ChainSnapshot) -> None:
        """Recompute global features from all rows in the snapshot."""
        rows = snapshot.rows
        self.oi_total_call = sum(float(r.get("callOI", 0) or 0) for r in rows)
        self.oi_total_put = sum(float(r.get("putOI", 0) or 0) for r in rows)
        self.oi_change_call = sum(float(r.get("callOIChange", 0) or 0) for r in rows)
        self.oi_change_put = sum(float(r.get("putOIChange", 0) or 0) for r in rows)
        self.pcr_global = self.oi_total_put / self.oi_total_call if self.oi_total_call > 0 else None

    def _compute_atm_zone_features(self, snapshot: ChainSnapshot, atm_window: list[int]) -> None:
        """
        Recompute ATM-zone features from rows matching the given ATM window.

        If the ATM window includes strikes not present in the snapshot (e.g.
        very wide spread chain), those strikes are simply absent from atm_rows.
        """
        atm_set = set(atm_window)
        atm_rows = [r for r in snapshot.rows if int(r["strike"]) in atm_set]

        oi_call_atm = sum(float(r.get("callOI", 0) or 0) for r in atm_rows)
        oi_put_atm = sum(float(r.get("putOI", 0) or 0) for r in atm_rows)
        self.oi_change_call_atm = sum(float(r.get("callOIChange", 0) or 0) for r in atm_rows)
        self.oi_change_put_atm = sum(float(r.get("putOIChange", 0) or 0) for r in atm_rows)

        self.pcr_atm = oi_put_atm / oi_call_atm if oi_call_atm > 0 else None

        # Imbalance: signed direction of ATM OI change.
        # Denominator uses absolute values so sign cancellation cannot zero it.
        denom = abs(self.oi_change_call_atm) + abs(self.oi_change_put_atm)
        self.oi_imbalance_atm = (
            (self.oi_change_call_atm - self.oi_change_put_atm) / denom if denom != 0 else None
        )

        # Volume diffs (current - previous snapshot volume per ATM ±3 strike).
        # Only available when prev_snapshot exists (vol_diff_available = True).
        if self.prev_snapshot is not None:
            prev_by_strike = {int(r["strike"]): r for r in self.prev_snapshot.rows}
            self.call_vol_diff_atm = sum(
                float(r.get("callVolume", 0) or 0)
                - float(prev_by_strike.get(int(r["strike"]), {}).get("callVolume", 0) or 0)
                for r in atm_rows
            )
            self.put_vol_diff_atm = sum(
                float(r.get("putVolume", 0) or 0)
                - float(prev_by_strike.get(int(r["strike"]), {}).get("putVolume", 0) or 0)
                for r in atm_rows
            )
        else:
            self.call_vol_diff_atm = None
            self.put_vol_diff_atm = None
