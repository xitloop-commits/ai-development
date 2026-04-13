"""
test_chain_cache.py — Unit tests for chain_cache.py.

Run: python -m pytest python_modules/tick_feature_agent/tests/test_chain_cache.py -v
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pytest
from tick_feature_agent.chain_cache import ChainCache
from tick_feature_agent.feed.chain_poller import ChainSnapshot


# ── Helpers ───────────────────────────────────────────────────────────────────

def _row(strike: int, call_oi: float = 1000, put_oi: float = 1000,
         call_oi_chg: float = 0, put_oi_chg: float = 0,
         call_vol: float = 0, put_vol: float = 0) -> dict:
    return {
        "strike":       strike,
        "callOI":       call_oi,
        "putOI":        put_oi,
        "callOIChange": call_oi_chg,
        "putOIChange":  put_oi_chg,
        "callVolume":   call_vol,
        "putVolume":    put_vol,
        "callSecurityId": str(strike * 2),
        "putSecurityId":  str(strike * 2 + 1),
        "callLTP": 100.0,
        "putLTP":  100.0,
    }


def _make_snapshot(
    spot: float = 24100.0,
    strike_step: int = 50,
    strikes: list[int] | None = None,
    rows_override: list[dict] | None = None,
    expiry: str = "2026-04-24",
    ts_sec: float | None = None,
) -> ChainSnapshot:
    if ts_sec is None:
        ts_sec = time.time()
    if rows_override is not None:
        rows = rows_override
    else:
        if strikes is None:
            strikes = list(range(23800, 24500, strike_step))
        rows = [_row(s) for s in strikes]
    sec_id_map = {}
    for r in rows:
        sec_id_map[str(r["callSecurityId"])] = (int(r["strike"]), "CE")
        sec_id_map[str(r["putSecurityId"])]  = (int(r["strike"]), "PE")
    return ChainSnapshot(
        spot_price=spot,
        expiry=expiry,
        timestamp_sec=ts_sec,
        rows=rows,
        strike_step=strike_step,
        sec_id_map=sec_id_map,
    )


def _fresh_cache() -> ChainCache:
    return ChainCache()


# ══════════════════════════════════════════════════════════════════════════════
# Initial state
# ══════════════════════════════════════════════════════════════════════════════

class TestInitialState:

    def test_chain_not_available(self):
        assert not _fresh_cache().chain_available

    def test_vol_diff_not_available(self):
        assert not _fresh_cache().vol_diff_available

    def test_snapshot_none(self):
        assert _fresh_cache().snapshot is None

    def test_prev_snapshot_none(self):
        assert _fresh_cache().prev_snapshot is None

    def test_atm_none(self):
        assert _fresh_cache().atm is None

    def test_strike_step_none(self):
        assert _fresh_cache().strike_step is None

    def test_atm_window_empty(self):
        assert _fresh_cache().atm_window == []

    def test_active_strikes_empty(self):
        assert _fresh_cache().active_strikes == []

    def test_pcr_global_none(self):
        assert _fresh_cache().pcr_global is None

    def test_pcr_atm_none(self):
        assert _fresh_cache().pcr_atm is None

    def test_oi_imbalance_atm_none(self):
        assert _fresh_cache().oi_imbalance_atm is None


# ══════════════════════════════════════════════════════════════════════════════
# Availability flags
# ══════════════════════════════════════════════════════════════════════════════

class TestAvailabilityFlags:

    def test_chain_available_after_first_snapshot(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot())
        assert cache.chain_available is True

    def test_vol_diff_not_available_after_first_snapshot(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot())
        assert cache.vol_diff_available is False

    def test_vol_diff_available_after_second_snapshot(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot())
        cache.update_from_snapshot(_make_snapshot())
        assert cache.vol_diff_available is True

    def test_vol_diff_not_reset_on_atm_shift(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(spot=24100.0))
        cache.update_from_snapshot(_make_snapshot(spot=24100.0))
        assert cache.vol_diff_available is True
        # ATM shift via tick processor
        cache.refresh_atm_zone(spot=24200.0)
        assert cache.vol_diff_available is True   # must not reset


# ══════════════════════════════════════════════════════════════════════════════
# Snapshot rotation
# ══════════════════════════════════════════════════════════════════════════════

class TestSnapshotRotation:

    def test_snapshot_stored_after_first_update(self):
        cache = _fresh_cache()
        snap1 = _make_snapshot(spot=24100.0)
        cache.update_from_snapshot(snap1)
        assert cache.snapshot is snap1

    def test_prev_none_after_first_update(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot())
        assert cache.prev_snapshot is None

    def test_prev_becomes_old_current_on_second_update(self):
        cache = _fresh_cache()
        snap1 = _make_snapshot(spot=24100.0)
        snap2 = _make_snapshot(spot=24150.0)
        cache.update_from_snapshot(snap1)
        cache.update_from_snapshot(snap2)
        assert cache.snapshot is snap2
        assert cache.prev_snapshot is snap1

    def test_only_two_snapshots_kept(self):
        cache = _fresh_cache()
        snaps = [_make_snapshot(spot=float(i)) for i in range(24000, 24500, 100)]
        for snap in snaps:
            cache.update_from_snapshot(snap)
        assert cache.snapshot is snaps[-1]
        assert cache.prev_snapshot is snaps[-2]


# ══════════════════════════════════════════════════════════════════════════════
# ATM computation
# ══════════════════════════════════════════════════════════════════════════════

class TestAtmComputation:

    def test_strike_step_from_snapshot(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(strike_step=50))
        assert cache.strike_step == 50

    def test_atm_computed_from_spot(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(spot=24137.6, strike_step=50))
        assert cache.atm == 24150

    def test_atm_window_has_7_elements(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(spot=24150.0, strike_step=50))
        assert len(cache.atm_window) == 7

    def test_atm_window_centred_on_atm(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(spot=24150.0, strike_step=50))
        assert cache.atm_window[3] == cache.atm

    def test_update_returns_true_on_first_call(self):
        # old_atm is None → always shifts
        cache = _fresh_cache()
        shifted = cache.update_from_snapshot(_make_snapshot(spot=24100.0))
        assert shifted is True

    def test_update_returns_false_when_atm_unchanged(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(spot=24100.0))
        # Same spot → same ATM
        shifted = cache.update_from_snapshot(_make_snapshot(spot=24100.0))
        assert shifted is False

    def test_update_returns_true_when_atm_shifts(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(spot=24100.0, strike_step=50))
        shifted = cache.update_from_snapshot(_make_snapshot(spot=24200.0, strike_step=50))
        assert shifted is True


# ══════════════════════════════════════════════════════════════════════════════
# refresh_atm_zone
# ══════════════════════════════════════════════════════════════════════════════

class TestRefreshAtmZone:

    def test_no_op_before_chain_available(self):
        cache = _fresh_cache()
        result = cache.refresh_atm_zone(spot=24200.0)
        assert result is False

    def test_no_op_when_atm_unchanged(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(spot=24100.0, strike_step=50))
        # Spot still rounds to 24100
        result = cache.refresh_atm_zone(spot=24101.0)
        assert result is False

    def test_returns_true_when_atm_shifts(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(spot=24100.0, strike_step=50))
        # New spot rounds to 24200
        result = cache.refresh_atm_zone(spot=24199.0)
        assert result is True

    def test_atm_updated_after_shift(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(spot=24100.0, strike_step=50))
        cache.refresh_atm_zone(spot=24199.0)
        assert cache.atm == 24200

    def test_atm_window_updated_after_shift(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(spot=24100.0, strike_step=50))
        cache.refresh_atm_zone(spot=24199.0)
        assert cache.atm_window[3] == 24200

    def test_global_features_unchanged_after_atm_shift(self):
        cache = _fresh_cache()
        rows = [_row(s, call_oi=1000, put_oi=2000) for s in range(24000, 24500, 50)]
        snap = _make_snapshot(spot=24100.0, rows_override=rows, strike_step=50)
        cache.update_from_snapshot(snap)
        pcr_before = cache.pcr_global
        total_call_before = cache.oi_total_call
        # Shift ATM
        cache.refresh_atm_zone(spot=24250.0)
        # Global features must not change
        assert cache.pcr_global == pytest.approx(pcr_before)
        assert cache.oi_total_call == pytest.approx(total_call_before)

    def test_atm_zone_features_updated_after_shift(self):
        cache = _fresh_cache()
        rows = [_row(s, call_oi_chg=100, put_oi_chg=200) for s in range(24000, 24500, 50)]
        snap = _make_snapshot(spot=24100.0, rows_override=rows, strike_step=50)
        cache.update_from_snapshot(snap)
        pcr_atm_before = cache.pcr_atm
        # Shift ATM significantly
        cache.refresh_atm_zone(spot=24350.0)
        # pcr_atm for new window may differ (different rows, but all rows have
        # same call/put OI so it should be equal — test that it was recomputed)
        assert cache.atm == 24350
        assert cache.oi_change_call_atm >= 0   # recomputed for new window


# ══════════════════════════════════════════════════════════════════════════════
# Global chain features
# ══════════════════════════════════════════════════════════════════════════════

class TestGlobalChainFeatures:

    def test_oi_total_call_summed(self):
        rows = [_row(24000, call_oi=1000), _row(24050, call_oi=2000), _row(24100, call_oi=3000)]
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(rows_override=rows, strike_step=50))
        assert cache.oi_total_call == pytest.approx(6000.0)

    def test_oi_total_put_summed(self):
        rows = [_row(24000, put_oi=500), _row(24050, put_oi=700)]
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(rows_override=rows, strike_step=50))
        assert cache.oi_total_put == pytest.approx(1200.0)

    def test_pcr_global_computed(self):
        # call_oi=1000, put_oi=1500 → pcr = 1.5
        rows = [_row(24000, call_oi=1000, put_oi=1500)]
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(rows_override=rows, strike_step=50))
        assert cache.pcr_global == pytest.approx(1.5)

    def test_pcr_global_none_when_call_oi_zero(self):
        rows = [_row(24000, call_oi=0, put_oi=1000)]
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(rows_override=rows, strike_step=50))
        assert cache.pcr_global is None

    def test_oi_change_call_global(self):
        rows = [
            _row(24000, call_oi_chg=100),
            _row(24050, call_oi_chg=200),
            _row(24100, call_oi_chg=-50),
        ]
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(rows_override=rows, strike_step=50))
        assert cache.oi_change_call == pytest.approx(250.0)

    def test_oi_change_put_global(self):
        rows = [
            _row(24000, put_oi_chg=300),
            _row(24050, put_oi_chg=100),
        ]
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(rows_override=rows, strike_step=50))
        assert cache.oi_change_put == pytest.approx(400.0)

    def test_global_features_use_all_rows(self):
        # 10 strikes — all contribute to oi_total
        rows = [_row(s, call_oi=100, put_oi=150) for s in range(24000, 24500, 50)]
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(rows_override=rows, strike_step=50))
        assert cache.oi_total_call == pytest.approx(10 * 100.0)
        assert cache.oi_total_put  == pytest.approx(10 * 150.0)


# ══════════════════════════════════════════════════════════════════════════════
# ATM-zone chain features
# ══════════════════════════════════════════════════════════════════════════════

class TestAtmZoneFeatures:

    def _cache_with_atm_rows(self, atm=24100, step=50, **row_kwargs) -> ChainCache:
        """Make a cache where only the ATM window rows have non-default data."""
        window = [atm + i * step for i in range(-3, 4)]
        rows = [_row(s, **row_kwargs) if s in window else _row(s)
                for s in range(23800, 24500, step)]
        cache = _fresh_cache()
        cache.update_from_snapshot(
            _make_snapshot(spot=float(atm), rows_override=rows, strike_step=step)
        )
        return cache

    def test_pcr_atm_uses_only_atm_window_rows(self):
        # ATM window: 24100±3×50 = [23950, 24000, 24050, 24100, 24150, 24200, 24250]
        # These rows: call_oi=100, put_oi=200 → pcr_atm = 200/100 = 2.0
        # All other rows: call_oi=1000, put_oi=1000 — should not affect pcr_atm
        cache = self._cache_with_atm_rows(atm=24100, step=50, call_oi=100, put_oi=200)
        assert cache.pcr_atm == pytest.approx(2.0)

    def test_pcr_atm_none_when_atm_call_oi_zero(self):
        cache = self._cache_with_atm_rows(atm=24100, step=50, call_oi=0, put_oi=500)
        assert cache.pcr_atm is None

    def test_oi_change_call_atm_sums_window(self):
        # 7 ATM window strikes × call_oi_chg=50 = 350
        cache = self._cache_with_atm_rows(atm=24100, step=50, call_oi_chg=50)
        assert cache.oi_change_call_atm == pytest.approx(7 * 50.0)

    def test_oi_change_put_atm_sums_window(self):
        cache = self._cache_with_atm_rows(atm=24100, step=50, put_oi_chg=30)
        assert cache.oi_change_put_atm == pytest.approx(7 * 30.0)

    def test_oi_imbalance_atm_pure_call(self):
        # call_chg > 0, put_chg = 0 → imbalance = +1.0
        cache = self._cache_with_atm_rows(atm=24100, step=50, call_oi_chg=100, put_oi_chg=0)
        assert cache.oi_imbalance_atm == pytest.approx(1.0)

    def test_oi_imbalance_atm_pure_put(self):
        # call_chg = 0, put_chg > 0 → imbalance = -1.0
        cache = self._cache_with_atm_rows(atm=24100, step=50, call_oi_chg=0, put_oi_chg=100)
        assert cache.oi_imbalance_atm == pytest.approx(-1.0)

    def test_oi_imbalance_atm_balanced(self):
        # equal call and put changes → imbalance = 0
        cache = self._cache_with_atm_rows(atm=24100, step=50, call_oi_chg=100, put_oi_chg=100)
        assert cache.oi_imbalance_atm == pytest.approx(0.0)

    def test_oi_imbalance_atm_none_when_both_zero(self):
        cache = self._cache_with_atm_rows(atm=24100, step=50, call_oi_chg=0, put_oi_chg=0)
        assert cache.oi_imbalance_atm is None

    def test_oi_imbalance_atm_sign_cancellation_guarded(self):
        # call_chg=100, put_chg=-100 → denominator uses abs values = 200, not 0
        rows = [_row(s, call_oi_chg=100, put_oi_chg=-100)
                for s in range(23800, 24500, 50)]
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(
            spot=24100.0, rows_override=rows, strike_step=50
        ))
        # denom = |100*7| + |-100*7| = 700 + 700 = 1400 ≠ 0
        assert cache.oi_imbalance_atm is not None

    def test_atm_rows_outside_chain_not_crash(self):
        # ATM window may extend beyond available strikes
        rows = [_row(24050), _row(24100)]  # only 2 strikes — window is wider
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(
            spot=24100.0, rows_override=rows, strike_step=50
        ))
        # Should not raise; ATM-zone features computed from available rows only
        assert cache.chain_available is True


# ══════════════════════════════════════════════════════════════════════════════
# Active strikes
# ══════════════════════════════════════════════════════════════════════════════

class TestActiveStrikes:

    def test_active_strikes_populated_after_snapshot(self):
        rows = [_row(s, call_oi_chg=100) for s in range(24000, 24400, 50)]
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(rows_override=rows, strike_step=50))
        assert len(cache.active_strikes) > 0

    def test_active_strikes_empty_when_all_oi_change_zero(self):
        rows = [_row(s, call_oi_chg=0, put_oi_chg=0) for s in range(24000, 24400, 50)]
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(rows_override=rows, strike_step=50))
        # vol_diff_available=False + all oi_change=0 → no active strikes
        assert len(cache.active_strikes) == 0

    def test_active_strikes_at_most_6(self):
        rows = [_row(s, call_oi_chg=100, call_vol=100) for s in range(24000, 24700, 50)]
        prev_rows = [_row(s) for s in range(24000, 24700, 50)]
        cache = _fresh_cache()
        snap1 = _make_snapshot(rows_override=prev_rows, strike_step=50)
        snap2 = _make_snapshot(rows_override=rows, strike_step=50)
        cache.update_from_snapshot(snap1)
        cache.update_from_snapshot(snap2)
        assert len(cache.active_strikes) <= 6


# ══════════════════════════════════════════════════════════════════════════════
# reset()
# ══════════════════════════════════════════════════════════════════════════════

class TestReset:

    def test_reset_clears_chain_available(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot())
        assert cache.chain_available is True
        cache.reset()
        assert cache.chain_available is False

    def test_reset_clears_vol_diff_available(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot())
        cache.update_from_snapshot(_make_snapshot())
        assert cache.vol_diff_available is True
        cache.reset()
        assert cache.vol_diff_available is False

    def test_reset_clears_snapshots(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot())
        cache.reset()
        assert cache.snapshot is None
        assert cache.prev_snapshot is None

    def test_reset_clears_atm(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(spot=24100.0))
        assert cache.atm is not None
        cache.reset()
        assert cache.atm is None

    def test_reset_clears_pcr(self):
        rows = [_row(24000, call_oi=1000, put_oi=1500)]
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(rows_override=rows, strike_step=50))
        assert cache.pcr_global is not None
        cache.reset()
        assert cache.pcr_global is None

    def test_reset_retains_strike_step(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(strike_step=50))
        assert cache.strike_step == 50
        cache.reset()
        assert cache.strike_step == 50   # intentionally kept

    def test_reset_clears_active_strikes(self):
        rows = [_row(s, call_oi_chg=100) for s in range(24000, 24300, 50)]
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot(rows_override=rows, strike_step=50))
        assert len(cache.active_strikes) > 0
        cache.reset()
        assert cache.active_strikes == []

    def test_can_accept_new_snapshot_after_reset(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot())
        cache.reset()
        cache.update_from_snapshot(_make_snapshot(spot=24200.0))
        assert cache.chain_available is True
        assert cache.vol_diff_available is False   # first snapshot after reset


# ══════════════════════════════════════════════════════════════════════════════
# last_snapshot_ts
# ══════════════════════════════════════════════════════════════════════════════

class TestLastSnapshotTs:

    def test_timestamp_updated_on_snapshot(self):
        cache = _fresh_cache()
        before = time.monotonic()
        cache.update_from_snapshot(_make_snapshot())
        after = time.monotonic()
        assert before <= cache.last_snapshot_ts <= after

    def test_timestamp_zero_initially(self):
        assert _fresh_cache().last_snapshot_ts == 0.0

    def test_timestamp_zero_after_reset(self):
        cache = _fresh_cache()
        cache.update_from_snapshot(_make_snapshot())
        cache.reset()
        assert cache.last_snapshot_ts == 0.0
