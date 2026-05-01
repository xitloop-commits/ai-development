"""
tests/test_emitter.py — Unit tests for output/emitter.py (§9 flat vector assembly).

Run: python -m pytest python_modules/tick_feature_agent/tests/test_emitter.py -v
"""

from __future__ import annotations

import io
import json
import math
import sys
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG  = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.output.emitter import (
    COLUMN_NAMES,
    _INT_COLUMNS,
    _INT_COLUMNS_BASE,
    assemble_flat_vector,
    column_names_for,
    int_columns_for,
    serialize_row,
    Emitter,
    _build_column_names,
    _build_target_columns,
    _parquet_type,
)

_NAN = float("nan")


def _nan(v) -> bool:
    return isinstance(v, float) and math.isnan(v)


# ── Helpers ───────────────────────────────────────────────────────────────────

_ATM_WINDOW = [23950, 24000, 24050, 24100, 24150, 24200, 24250]

def _minimal_row(**overrides) -> dict:
    """Build the minimal kwargs dict for assemble_flat_vector."""
    defaults = dict(
        timestamp=1_000_000.0,
        spot_price=24100.0,
        atm_strike=24100,
        strike_step=50,
        atm_window=_ATM_WINDOW,
        underlying_feats={},
        ofi_feats={},
        realized_vol_feats={},
        horizon_feats={},
        compression_feats={},
        time_to_move_feats={},
        opt_tick_feats={},
        chain_feats={},
        active_feats={},
        decay_feats={},
        regime_feats={},
        zone_feats={},
        target_feats=None,
        trading_state="TRADING",
        trading_allowed=1,
        warm_up_remaining_sec=0.0,
        stale_reason=None,
        meta_feats={},
        target_windows_sec=(30, 60),
    )
    defaults.update(overrides)
    return defaults


def _build(**overrides) -> dict:
    return assemble_flat_vector(**_minimal_row(**overrides))


# ══════════════════════════════════════════════════════════════════════════════
# COLUMN_NAMES correctness
# ══════════════════════════════════════════════════════════════════════════════

class TestColumnNames:

    def test_count_is_370(self):
        assert len(COLUMN_NAMES) == 370

    def test_no_duplicates(self):
        assert len(set(COLUMN_NAMES)) == 370

    def test_first_column_is_timestamp(self):
        assert COLUMN_NAMES[0] == "timestamp"

    def test_spot_check_underlying_base(self):
        assert COLUMN_NAMES[1]  == "underlying_ltp"
        assert COLUMN_NAMES[12] == "underlying_tick_imbalance_20"

    def test_spot_check_underlying_extended(self):
        assert COLUMN_NAMES[13] == "underlying_trade_direction"
        assert COLUMN_NAMES[19] == "underlying_realized_vol_50"
        assert COLUMN_NAMES[32] == "underlying_horizon_ofi_ratio"

    def test_atm_context_columns(self):
        assert COLUMN_NAMES[33] == "spot_price"
        assert COLUMN_NAMES[34] == "atm_strike"
        assert COLUMN_NAMES[35] == "strike_step"

    def test_compression_breakout_columns(self):
        assert COLUMN_NAMES[36] == "range_20ticks"
        assert COLUMN_NAMES[40] == "breakout_readiness"   # col 41 (1-indexed)

    def test_time_to_move_columns(self):
        assert COLUMN_NAMES[41] == "time_since_last_big_move"
        assert COLUMN_NAMES[44] == "breakout_readiness_extended"

    def test_opt_tick_first_and_last(self):
        assert COLUMN_NAMES[45]  == "opt_m3_ce_tick_available"   # col 46
        assert COLUMN_NAMES[170] == "opt_p3_pe_premium_momentum_10"  # col 171

    def test_opt_tick_atm2_starts_at_col64(self):
        # col 64 (0-indexed 63) = opt_m2_ce_tick_available
        assert COLUMN_NAMES[63] == "opt_m2_ce_tick_available"

    def test_opt_tick_atm_starts_at_col100(self):
        assert COLUMN_NAMES[99] == "opt_0_ce_tick_available"

    def test_chain_columns(self):
        assert COLUMN_NAMES[171] == "chain_pcr_global"     # col 172
        assert COLUMN_NAMES[179] == "chain_oi_imbalance_atm"  # col 180

    def test_active_strike_first_slot(self):
        assert COLUMN_NAMES[180] == "active_0_strike"        # col 181
        assert COLUMN_NAMES[203] == "active_0_tick_age_sec"  # col 204

    def test_active_strike_last_slot(self):
        assert COLUMN_NAMES[300] == "active_5_strike"        # col 301
        assert COLUMN_NAMES[323] == "active_5_tick_age_sec"  # col 324

    def test_cross_feature_columns(self):
        assert COLUMN_NAMES[324] == "call_put_strength_diff"  # col 325
        assert COLUMN_NAMES[327] == "premium_divergence"

    def test_decay_columns(self):
        assert COLUMN_NAMES[328] == "total_premium_decay_atm"
        assert COLUMN_NAMES[332] == "dead_market_score"

    def test_regime_columns(self):
        assert COLUMN_NAMES[333] == "regime"
        assert COLUMN_NAMES[334] == "regime_confidence"

    def test_zone_columns(self):
        assert COLUMN_NAMES[335] == "atm_zone_call_pressure"
        assert COLUMN_NAMES[341] == "zone_activity_score"

    def test_target_columns_default_windows(self):
        assert COLUMN_NAMES[342] == "max_upside_30s"
        assert COLUMN_NAMES[356] == "upside_percentile_30s"

    def test_trading_state_columns(self):
        assert COLUMN_NAMES[357] == "trading_state"
        assert COLUMN_NAMES[360] == "stale_reason"

    def test_metadata_last_column(self):
        assert COLUMN_NAMES[361] == "exchange"
        assert COLUMN_NAMES[369] == "is_market_open"


# ══════════════════════════════════════════════════════════════════════════════
# Target column generation
# ══════════════════════════════════════════════════════════════════════════════

class TestBuildTargetColumns:

    def test_default_windows_15_columns(self):
        cols = _build_target_columns((30, 60))
        assert len(cols) == 15

    def test_single_window_8_columns(self):
        cols = _build_target_columns((30,))
        assert len(cols) == 8   # 5 per-window + 2 direction + 1 upside_percentile

    def test_three_windows_22_columns(self):
        cols = _build_target_columns((30, 60, 120))
        assert len(cols) == 22  # 5×3 + 6 direction + 1 percentile

    def test_upside_percentile_uses_smallest_window(self):
        cols = _build_target_columns((60, 30))  # unsorted input
        assert "upside_percentile_30s" in cols

    def test_column_naming_pattern(self):
        cols = _build_target_columns((30,))
        assert "max_upside_30s" in cols
        assert "max_drawdown_30s" in cols
        assert "risk_reward_ratio_30s" in cols
        assert "total_premium_decay_30s" in cols
        assert "avg_decay_per_strike_30s" in cols
        assert "direction_30s" in cols
        assert "direction_30s_magnitude" in cols
        assert "upside_percentile_30s" in cols

    def test_4_windows_370_total(self):
        """4 windows × per-window cols + other groups = still validates."""
        cols_4w = _build_column_names((30, 60, 90, 120))
        # Each extra window past 2 adds 7 cols per window for 4 windows vs 2 = +14
        # Plus direction pairs: 2 per window × 4 = 8 vs 2 = +4
        # Total with 4 windows: 15 + 14 + 4 = 33 target cols (vs 15 for 2 windows)
        # But total row count changes — just check no duplicates and count is consistent
        assert len(set(cols_4w)) == len(cols_4w)


# ══════════════════════════════════════════════════════════════════════════════
# Phase E8 — Dynamic column count + int-column derivation
# ══════════════════════════════════════════════════════════════════════════════

class TestDynamicColumnCount:
    """Lock the column-count contract for both the legacy 2-window
    profile (370 columns) and the canonical 4-window profile (384).
    Per Phase E8 / D4 the live profile uses 4 windows = 384 cols; the
    2-window count is preserved for backward compat with replay of
    pre-D4 parquets."""

    def test_count_is_370_for_2window_profile(self):
        cols = column_names_for((30, 60))
        assert len(cols) == 370
        assert len(set(cols)) == 370, "duplicate column names in 2-window profile"

    def test_count_is_384_for_4window_profile(self):
        """Canonical Phase D4 layout."""
        cols = column_names_for((30, 60, 300, 900))
        assert len(cols) == 384
        assert len(set(cols)) == 384, "duplicate column names in 4-window profile"

    @pytest.mark.parametrize("windows,expected_count", [
        ((30,),                     363),  # single-window minimum
        ((30, 60),                  370),  # legacy MVP
        ((30, 60, 300),             377),  # 3-window
        ((30, 60, 300, 900),        384),  # canonical D4
        ((30, 60, 120, 300, 900),   391),  # hypothetical 5-window profile
    ])
    def test_count_formula(self, windows, expected_count):
        """Total = 355 (window-independent base) + 7 × len(windows) + 1
        (one upside_percentile_<min(windows)>s). Each extra window adds
        exactly 7 columns: max_upside, max_drawdown, risk_reward_ratio,
        total_premium_decay, avg_decay_per_strike, direction,
        direction_magnitude."""
        assert len(column_names_for(windows)) == expected_count

    def test_legacy_module_global_is_2window_default(self):
        """`COLUMN_NAMES` exists as backward-compat for pre-E8 callers
        and resolves to the 2-window default."""
        assert len(COLUMN_NAMES) == 370
        assert COLUMN_NAMES == column_names_for((30, 60))

    def test_4window_includes_300s_and_900s_target_cols(self):
        cols = set(column_names_for((30, 60, 300, 900)))
        for w in (30, 60, 300, 900):
            for prefix in ("max_upside", "max_drawdown", "risk_reward_ratio",
                           "total_premium_decay", "avg_decay_per_strike",
                           "direction", "direction"):
                # direction / direction_magnitude both checked below explicitly
                pass
            assert f"max_upside_{w}s" in cols
            assert f"max_drawdown_{w}s" in cols
            assert f"risk_reward_ratio_{w}s" in cols
            assert f"total_premium_decay_{w}s" in cols
            assert f"avg_decay_per_strike_{w}s" in cols
            assert f"direction_{w}s" in cols
            assert f"direction_{w}s_magnitude" in cols


class TestDynamicIntColumns:
    """Phase E8 / PY-15 / PY-46 regression tests.

    Pre-E8 the int-typed parquet column set was a hardcoded frozenset
    that included `direction_{30,60,90,120,150,180,300}s`. Two bugs:
      1. 4-window profiles include `direction_900s` which was missing,
         so the column landed as float32 instead of int32.
      2. 90/120/150/180 entries are stale — no profile uses them.
    `int_columns_for(windows)` derives the set from the actual profile.
    """

    def test_2window_int_columns_include_30s_and_60s_direction(self):
        ic = int_columns_for((30, 60))
        assert "direction_30s" in ic
        assert "direction_60s" in ic

    def test_4window_int_columns_include_900s_direction(self):
        """The bug: pre-E8 `direction_900s` was missing from `_INT_COLUMNS`
        for canonical 4-window profiles, causing int32 → float32 mis-typing
        in replay parquets."""
        ic = int_columns_for((30, 60, 300, 900))
        assert "direction_30s" in ic
        assert "direction_60s" in ic
        assert "direction_300s" in ic
        assert "direction_900s" in ic

    def test_int_columns_drop_stale_90_120_150_180(self):
        """The 90s/120s/150s/180s direction entries from pre-E8 _INT_COLUMNS
        were never matched by any real profile. Confirm they're not in
        the 2-window set (and the base set from which it's derived)."""
        for stale in ("direction_90s", "direction_120s",
                      "direction_150s", "direction_180s"):
            assert stale not in _INT_COLUMNS_BASE, (
                f"{stale} leaked into _INT_COLUMNS_BASE"
            )
            assert stale not in int_columns_for((30, 60)), (
                f"{stale} in 2-window int set"
            )
            assert stale not in int_columns_for((30, 60, 300, 900)), (
                f"{stale} in 4-window int set"
            )

    def test_int_columns_base_window_independent_keys_preserved(self):
        """Window-independent int columns (atm_strike, opt_*_volume,
        active_*_strike, etc.) must be present in every profile."""
        for windows in [(30, 60), (30, 60, 300, 900), (30,)]:
            ic = int_columns_for(windows)
            assert "atm_strike" in ic
            assert "strike_step" in ic
            assert "trading_allowed" in ic
            assert "data_quality_flag" in ic
            assert "is_market_open" in ic
            # Spot-check option tick + active strike int fields
            assert "opt_0_ce_volume" in ic
            assert "active_0_strike" in ic
            assert "active_5_tick_available" in ic

    def test_int_columns_4window_has_correct_direction_cardinality(self):
        """Exactly len(windows) direction_<W>s entries — nothing else."""
        ic = int_columns_for((30, 60, 300, 900))
        direction_cols = {c for c in ic if c.startswith("direction_")}
        assert direction_cols == {
            "direction_30s", "direction_60s",
            "direction_300s", "direction_900s",
        }

    def test_legacy_module_global_int_columns_2window(self):
        """Backward-compat: `_INT_COLUMNS` global == 2-window default set."""
        assert _INT_COLUMNS == int_columns_for((30, 60))


class TestParquetTypeForDirectionTargets:
    """Verify the actual parquet-type dispatch for direction columns
    across both 2-window and 4-window profiles. This is the bug E8
    closes: in 4-window mode `direction_900s` previously dispatched to
    float32 because it wasn't in the hardcoded `_INT_COLUMNS` set."""

    def test_direction_900s_is_int32_in_4window_mode(self):
        import pyarrow as pa
        ic = int_columns_for((30, 60, 300, 900))
        assert _parquet_type("direction_900s", ic) == pa.int32()

    def test_direction_900s_is_float32_in_2window_mode(self):
        """In a 2-window profile `direction_900s` is not a target column
        at all; if such a name appeared it would default to float32 —
        which is the right behaviour."""
        import pyarrow as pa
        ic = int_columns_for((30, 60))
        assert _parquet_type("direction_900s", ic) == pa.float32()

    @pytest.mark.parametrize("col", [
        "direction_30s", "direction_60s",
        "direction_300s", "direction_900s",
    ])
    def test_all_4window_directions_are_int32(self, col):
        import pyarrow as pa
        ic = int_columns_for((30, 60, 300, 900))
        assert _parquet_type(col, ic) == pa.int32()

    def test_direction_magnitude_stays_float32(self):
        """`direction_<W>s_magnitude` is a regression target → float32,
        regardless of window count."""
        import pyarrow as pa
        for windows in [(30, 60), (30, 60, 300, 900)]:
            ic = int_columns_for(windows)
            for w in windows:
                assert _parquet_type(f"direction_{w}s_magnitude", ic) == pa.float32()


# ══════════════════════════════════════════════════════════════════════════════
# assemble_flat_vector: output structure
# ══════════════════════════════════════════════════════════════════════════════

class TestAssembleFlatVector:

    def test_key_count_is_370(self):
        row = _build()
        assert len(row) == 370

    def test_key_order_matches_column_names(self):
        row = _build()
        assert list(row.keys()) == list(COLUMN_NAMES)

    def test_no_extra_keys(self):
        row = _build()
        assert set(row.keys()) == set(COLUMN_NAMES)


# ══════════════════════════════════════════════════════════════════════════════
# assemble_flat_vector: field values
# ══════════════════════════════════════════════════════════════════════════════

class TestAssemblyValues:

    def test_timestamp(self):
        row = _build(timestamp=99999.0)
        assert row["timestamp"] == pytest.approx(99999.0)

    def test_spot_price(self):
        row = _build(spot_price=23500.0)
        assert row["spot_price"] == pytest.approx(23500.0)

    def test_atm_strike_float(self):
        row = _build(atm_strike=24100)
        assert row["atm_strike"] == pytest.approx(24100.0)

    def test_atm_strike_none_is_nan(self):
        row = _build(atm_strike=None)
        assert _nan(row["atm_strike"])

    def test_strike_step_none_is_nan(self):
        row = _build(strike_step=None)
        assert _nan(row["strike_step"])

    def test_underlying_ltp_from_dict(self):
        row = _build(underlying_feats={"ltp": 24123.5})
        assert row["underlying_ltp"] == pytest.approx(24123.5)

    def test_underlying_missing_key_is_nan(self):
        row = _build(underlying_feats={})
        assert _nan(row["underlying_ltp"])

    def test_underlying_prefix_applied(self):
        """Bare key 'spread' in underlying_feats → 'underlying_spread' in output."""
        row = _build(underlying_feats={"spread": 0.5})
        assert row["underlying_spread"] == pytest.approx(0.5)
        assert "spread" not in row

    def test_ofi_already_prefixed(self):
        row = _build(ofi_feats={"underlying_trade_direction": -1.0})
        assert row["underlying_trade_direction"] == pytest.approx(-1.0)

    def test_realized_vol_already_prefixed(self):
        row = _build(realized_vol_feats={"underlying_realized_vol_5": 0.012})
        assert row["underlying_realized_vol_5"] == pytest.approx(0.012)

    def test_horizon_already_prefixed(self):
        row = _build(horizon_feats={"underlying_horizon_vol_ratio": 1.5})
        assert row["underlying_horizon_vol_ratio"] == pytest.approx(1.5)

    def test_return_10ticks_in_extended_group(self):
        """return_10ticks is in underlying_feats (bare) but lands in extended group."""
        row = _build(underlying_feats={"return_10ticks": 0.001})
        assert row["underlying_return_10ticks"] == pytest.approx(0.001)

    def test_compression_feats_mapped(self):
        row = _build(compression_feats={
            "range_20ticks": 50.0, "volatility_compression": 0.7,
        })
        assert row["range_20ticks"] == pytest.approx(50.0)
        assert row["volatility_compression"] == pytest.approx(0.7)

    def test_breakout_readiness_from_time_to_move(self):
        """breakout_readiness (col 41) is sourced from time_to_move_feats."""
        row = _build(
            compression_feats={},       # no breakout_readiness here
            time_to_move_feats={"breakout_readiness": 1.0,
                                "breakout_readiness_extended": 0.0},
        )
        assert row["breakout_readiness"] == pytest.approx(1.0)

    def test_time_to_move_feats_mapped(self):
        row = _build(time_to_move_feats={
            "time_since_last_big_move": 30.5,
            "stagnation_duration_sec": 15.0,
            "momentum_persistence_ticks": 3.0,
            "breakout_readiness": 0.0,
            "breakout_readiness_extended": 1.0,
        })
        assert row["time_since_last_big_move"] == pytest.approx(30.5)
        assert row["stagnation_duration_sec"]  == pytest.approx(15.0)
        assert row["breakout_readiness_extended"] == pytest.approx(1.0)

    def test_chain_feats_mapped(self):
        row = _build(chain_feats={"chain_pcr_global": 1.23})
        assert row["chain_pcr_global"] == pytest.approx(1.23)

    def test_decay_feats_mapped(self):
        row = _build(decay_feats={"active_strike_count": 3.0})
        assert row["active_strike_count"] == pytest.approx(3.0)

    def test_regime_feats_mapped(self):
        row = _build(regime_feats={"regime": "TREND", "regime_confidence": 0.8})
        assert row["regime"] == "TREND"
        assert row["regime_confidence"] == pytest.approx(0.8)

    def test_regime_none_when_missing(self):
        row = _build(regime_feats={})
        assert row["regime"] is None

    def test_zone_feats_mapped(self):
        row = _build(zone_feats={"atm_zone_call_pressure": 0.45})
        assert row["atm_zone_call_pressure"] == pytest.approx(0.45)

    def test_trading_state_string(self):
        row = _build(trading_state="FEED_STALE")
        assert row["trading_state"] == "FEED_STALE"

    def test_trading_allowed(self):
        row = _build(trading_allowed=0)
        assert row["trading_allowed"] == 0

    def test_stale_reason_none(self):
        row = _build(stale_reason=None)
        assert row["stale_reason"] is None

    def test_stale_reason_string(self):
        row = _build(stale_reason="UNDERLYING_STALE")
        assert row["stale_reason"] == "UNDERLYING_STALE"

    def test_meta_feats_mapped(self):
        row = _build(meta_feats={
            "exchange": "NSE", "instrument": "NIFTY",
            "chain_available": 1, "is_market_open": 1,
        })
        assert row["exchange"]        == "NSE"
        assert row["instrument"]      == "NIFTY"
        assert row["chain_available"] == 1
        assert row["is_market_open"]  == 1


# ══════════════════════════════════════════════════════════════════════════════
# Option tick mapping
# ══════════════════════════════════════════════════════════════════════════════

class TestOptTickMapping:

    def test_atm_minus3_ce_ltp_mapped(self):
        """Strike at ATM-3 (index 0) → opt_m3_ce_ltp."""
        atm_window = [23950, 24000, 24050, 24100, 24150, 24200, 24250]
        opt_feats = {(23950, "CE"): {"ltp": 85.5, "tick_available": 1,
                                     "bid": 85.0, "ask": 86.0, "spread": 1.0,
                                     "volume": 5, "bid_ask_imbalance": 0.1,
                                     "premium_momentum": 2.0, "premium_momentum_10": 3.0}}
        row = _build(atm_window=atm_window, opt_tick_feats=opt_feats)
        assert row["opt_m3_ce_ltp"]           == pytest.approx(85.5)
        assert row["opt_m3_ce_tick_available"] == 1

    def test_atm_ce_ltp_mapped(self):
        """Strike at ATM (index 3 = offset '0') → opt_0_ce_ltp."""
        atm_window = [23950, 24000, 24050, 24100, 24150, 24200, 24250]
        opt_feats = {(24100, "CE"): {"ltp": 200.0, "tick_available": 1,
                                     "bid": 199.0, "ask": 201.0, "spread": 2.0,
                                     "volume": 10, "bid_ask_imbalance": 0.0,
                                     "premium_momentum": 0.5, "premium_momentum_10": 1.0}}
        row = _build(atm_window=atm_window, opt_tick_feats=opt_feats)
        assert row["opt_0_ce_ltp"] == pytest.approx(200.0)

    def test_atm_plus3_pe_mapped(self):
        """Strike at ATM+3 (index 6 = offset 'p3') PE → opt_p3_pe_ltp."""
        atm_window = [23950, 24000, 24050, 24100, 24150, 24200, 24250]
        opt_feats = {(24250, "PE"): {"ltp": 50.0, "tick_available": 1,
                                     "bid": 49.5, "ask": 50.5, "spread": 1.0,
                                     "volume": 2, "bid_ask_imbalance": -0.2,
                                     "premium_momentum": -1.0, "premium_momentum_10": -2.0}}
        row = _build(atm_window=atm_window, opt_tick_feats=opt_feats)
        assert row["opt_p3_pe_ltp"] == pytest.approx(50.0)

    def test_missing_strike_gives_null_features(self):
        """Strike absent from opt_tick_feats → tick_available=0, ltp=NaN."""
        row = _build(opt_tick_feats={})
        assert row["opt_0_ce_tick_available"] == 0
        assert _nan(row["opt_0_ce_ltp"])

    def test_empty_atm_window_all_null(self):
        """Empty atm_window → all opt_ columns are null."""
        row = _build(atm_window=[])
        for off in ("m3", "m2", "m1", "0", "p1", "p2", "p3"):
            assert row[f"opt_{off}_ce_tick_available"] == 0
            assert _nan(row[f"opt_{off}_ce_ltp"])


# ══════════════════════════════════════════════════════════════════════════════
# Active strike slot mapping
# ══════════════════════════════════════════════════════════════════════════════

class TestActiveSlotMapping:

    def test_active_slot_0_strike(self):
        row = _build(active_feats={"active_0_strike": 24100.0,
                                   "active_0_tick_available": 1})
        assert row["active_0_strike"] == pytest.approx(24100.0)
        assert row["active_0_tick_available"] == 1

    def test_active_slot_5_missing_is_nan(self):
        row = _build(active_feats={})
        assert _nan(row["active_5_strike"])

    def test_cross_feature_from_active_feats(self):
        row = _build(active_feats={"call_put_strength_diff": 0.3,
                                   "premium_divergence": -1.5})
        assert row["call_put_strength_diff"] == pytest.approx(0.3)
        assert row["premium_divergence"]     == pytest.approx(-1.5)


# ══════════════════════════════════════════════════════════════════════════════
# Target variable mapping
# ══════════════════════════════════════════════════════════════════════════════

class TestTargetMapping:

    def test_target_feats_none_all_nan(self):
        row = _build(target_feats=None)
        assert _nan(row["max_upside_30s"])
        assert _nan(row["direction_30s"])
        assert _nan(row["upside_percentile_30s"])

    def test_target_feats_empty_all_nan(self):
        row = _build(target_feats={})
        assert _nan(row["max_upside_30s"])

    def test_target_feats_values_mapped(self):
        row = _build(target_feats={
            "max_upside_30s": 5.2, "direction_30s": 1.0,
            "upside_percentile_30s": 87.5,
        })
        assert row["max_upside_30s"]       == pytest.approx(5.2)
        assert row["direction_30s"]        == pytest.approx(1.0)
        assert row["upside_percentile_30s"]== pytest.approx(87.5)

    def test_custom_target_windows(self):
        row = assemble_flat_vector(**_minimal_row(
            target_windows_sec=(30,),
            target_feats={"max_upside_30s": 2.0}
        ))
        assert row["max_upside_30s"] == pytest.approx(2.0)
        assert "max_upside_60s" not in row


# ══════════════════════════════════════════════════════════════════════════════
# serialize_row
# ══════════════════════════════════════════════════════════════════════════════

class TestSerializeRow:

    def test_nan_becomes_null(self):
        row = {"x": _NAN}
        result = json.loads(serialize_row(row))
        assert result["x"] is None

    def test_none_becomes_null(self):
        row = {"x": None}
        result = json.loads(serialize_row(row))
        assert result["x"] is None

    def test_normal_float_preserved(self):
        row = {"x": 3.14}
        result = json.loads(serialize_row(row))
        assert result["x"] == pytest.approx(3.14)

    def test_string_preserved(self):
        row = {"x": "TREND"}
        result = json.loads(serialize_row(row))
        assert result["x"] == "TREND"

    def test_no_trailing_newline(self):
        line = serialize_row({"x": 1.0})
        assert not line.endswith("\n")

    def test_valid_json(self):
        row = _build()
        line = serialize_row(row)
        parsed = json.loads(line)
        assert len(parsed) == 370

    def test_allow_nan_false_satisfied(self):
        """NaN converted to null → json.loads should not raise."""
        row = {k: _NAN for k in COLUMN_NAMES}
        line = serialize_row(row)
        parsed = json.loads(line)
        assert all(v is None or isinstance(v, (int, float, str, type(None)))
                   for v in parsed.values())


# ══════════════════════════════════════════════════════════════════════════════
# Emitter file sink
# ══════════════════════════════════════════════════════════════════════════════

class TestEmitterFileSink:

    def test_emit_writes_to_file(self, tmp_path):
        out_file = str(tmp_path / "test_out.ndjson")
        emitter = Emitter(file_path=out_file)
        row = _build()
        emitter.emit(row)
        emitter.close()
        lines = Path(out_file).read_text(encoding="utf-8").strip().split("\n")
        assert len(lines) == 1
        parsed = json.loads(lines[0])
        assert len(parsed) == 370

    def test_emit_multiple_rows(self, tmp_path):
        out_file = str(tmp_path / "test_multi.ndjson")
        emitter = Emitter(file_path=out_file)
        for i in range(5):
            emitter.emit(_build(timestamp=float(i)))
        emitter.close()
        lines = Path(out_file).read_text(encoding="utf-8").strip().split("\n")
        assert len(lines) == 5

    def test_emit_appends_on_second_open(self, tmp_path):
        """Opening an existing file appends rather than truncates."""
        out_file = str(tmp_path / "append_test.ndjson")
        emitter = Emitter(file_path=out_file)
        emitter.emit(_build(timestamp=1.0))
        emitter.close()

        emitter2 = Emitter(file_path=out_file)
        emitter2.emit(_build(timestamp=2.0))
        emitter2.close()

        lines = Path(out_file).read_text(encoding="utf-8").strip().split("\n")
        assert len(lines) == 2

    def test_roll_file(self, tmp_path):
        """roll_file() closes old file and opens new one."""
        file1 = str(tmp_path / "file1.ndjson")
        file2 = str(tmp_path / "file2.ndjson")
        emitter = Emitter(file_path=file1)
        emitter.emit(_build(timestamp=1.0))
        emitter.roll_file(file2)
        emitter.emit(_build(timestamp=2.0))
        emitter.close()

        lines1 = Path(file1).read_text(encoding="utf-8").strip().split("\n")
        lines2 = Path(file2).read_text(encoding="utf-8").strip().split("\n")
        assert len(lines1) == 1
        assert len(lines2) == 1
        assert json.loads(lines1[0])["timestamp"] == pytest.approx(1.0)
        assert json.loads(lines2[0])["timestamp"] == pytest.approx(2.0)

    def test_close_idempotent(self, tmp_path):
        out_file = str(tmp_path / "idempotent.ndjson")
        emitter = Emitter(file_path=out_file)
        emitter.close()
        emitter.close()  # should not raise

    def test_no_file_sink(self):
        """No file path → no error, rows are silently dropped."""
        emitter = Emitter()
        emitter.emit(_build())
        emitter.close()

    def test_custom_target_window_370_columns(self, tmp_path):
        """Single-window config → different target columns but still valid JSON."""
        out_file = str(tmp_path / "single_window.ndjson")
        emitter = Emitter(file_path=out_file)
        row = assemble_flat_vector(**_minimal_row(target_windows_sec=(30,)))
        emitter.emit(row)
        emitter.close()
        line = Path(out_file).read_text(encoding="utf-8").strip()
        parsed = json.loads(line)
        assert "max_upside_30s" in parsed
        assert "max_upside_60s" not in parsed
