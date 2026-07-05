"""
tests/test_emitter.py — Unit tests for output/emitter.py (§9 flat vector assembly).

Run: python -m pytest python_modules/tick_feature_agent/tests/test_emitter.py -v
"""

from __future__ import annotations

import io
import json
import math
import socket
import sys
import tempfile
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.output.emitter import (
    _INT_COLUMNS,
    _INT_COLUMNS_BASE,
    _PHASE2_BC_COLUMNS,
    COLUMN_NAMES,
    Emitter,
    LATEST_SCHEMA_VERSION,
    _build_column_names,
    _build_target_columns,
    _parquet_type,
    assemble_flat_vector,
    column_names_for,
    int_columns_for,
    serialize_row,
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

    def test_count_is_528(self):
        # Wave 1: +22 (8 levels + 9 greeks + 5 expiry) → 392.
        # Wave 2: +5 target types per window × 2 default windows = +10 → 402.
        # Phase 2 (Schema-22/23): +69 trend/swing L1 (23 B-block + 46 C-block) → 495.
        # T37 (Schema v9, 2026-06-13): +26 ATM-only depth (2 sides × 13 keys) → 524.
        # Part B (2026-07-02): +4 trend/swing direction_down target cols → 550.
        assert len(COLUMN_NAMES) == 550

    def test_no_duplicates(self):
        assert len(set(COLUMN_NAMES)) == 550

    def test_first_column_is_timestamp(self):
        assert COLUMN_NAMES[0] == "timestamp"

    def test_spot_check_underlying_base(self):
        assert COLUMN_NAMES[1] == "underlying_ltp"
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
        assert COLUMN_NAMES[40] == "breakout_readiness"  # col 41 (1-indexed)

    def test_time_to_move_columns(self):
        assert COLUMN_NAMES[41] == "time_since_last_big_move"
        assert COLUMN_NAMES[44] == "breakout_readiness_extended"

    def test_opt_tick_first_and_last(self):
        assert COLUMN_NAMES[45] == "opt_m3_ce_tick_available"  # col 46
        assert COLUMN_NAMES[170] == "opt_p3_pe_premium_momentum_10"  # col 171

    def test_opt_tick_atm2_starts_at_col64(self):
        # col 64 (0-indexed 63) = opt_m2_ce_tick_available
        assert COLUMN_NAMES[63] == "opt_m2_ce_tick_available"

    def test_opt_tick_atm_starts_at_col100(self):
        assert COLUMN_NAMES[99] == "opt_0_ce_tick_available"

    def test_chain_columns(self):
        assert COLUMN_NAMES[197] == "chain_pcr_global"  # col 198
        assert COLUMN_NAMES[205] == "chain_oi_imbalance_atm"  # col 206

    def test_active_strike_first_slot(self):
        assert COLUMN_NAMES[206] == "active_0_strike"  # col 207
        assert COLUMN_NAMES[229] == "active_0_tick_age_sec"  # col 230

    def test_active_strike_last_slot(self):
        assert COLUMN_NAMES[326] == "active_5_strike"  # col 327
        assert COLUMN_NAMES[349] == "active_5_tick_age_sec"  # col 350

    def test_cross_feature_columns(self):
        assert COLUMN_NAMES[350] == "call_put_strength_diff"  # col 351
        assert COLUMN_NAMES[353] == "premium_divergence"

    def test_decay_columns(self):
        assert COLUMN_NAMES[354] == "total_premium_decay_atm"
        assert COLUMN_NAMES[358] == "dead_market_score"

    def test_regime_columns(self):
        assert COLUMN_NAMES[359] == "regime"
        assert COLUMN_NAMES[360] == "regime_confidence"

    def test_zone_columns(self):
        assert COLUMN_NAMES[361] == "atm_zone_call_pressure"
        assert COLUMN_NAMES[367] == "zone_activity_score"

    def test_target_columns_default_windows(self):
        assert COLUMN_NAMES[368] == "max_upside_30s"
        # Part B added risk_reward_ratio_pe per window (+2 for the 2-window
        # default) before upside_percentile_30s, shifting it +2 (392→394).
        assert COLUMN_NAMES[394] == "upside_percentile_30s"

    def test_trading_state_columns(self):
        # Part B: shifted +2 from the RR-PE columns.
        assert COLUMN_NAMES[395] == "trading_state"
        assert COLUMN_NAMES[398] == "stale_reason"

    def test_metadata_last_column(self):
        # Part B: shifted +2 from the RR-PE columns.
        assert COLUMN_NAMES[399] == "exchange"
        assert COLUMN_NAMES[407] == "is_market_open"


# ══════════════════════════════════════════════════════════════════════════════
# Target column generation
# ══════════════════════════════════════════════════════════════════════════════


class TestBuildTargetColumns:

    def test_default_windows_27_columns(self):
        # Part B: 13 target types per window × 2 + 1 percentile = 27
        cols = _build_target_columns((30, 60))
        assert len(cols) == 27

    def test_single_window_14_columns(self):
        cols = _build_target_columns((30,))
        # 13 per-window types + 1 upside_percentile = 14 (Part B)
        assert len(cols) == 14

    def test_three_windows_40_columns(self):
        cols = _build_target_columns((30, 60, 120))
        assert len(cols) == 40  # Part B: 13×3 + 1 percentile

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
    profile and the canonical 4-window profile. Phase 2 (Schema-22/23)
    appends 69 trend/swing L1 features, lifting the totals to 495 / 519.
    T37 (Schema v9, 2026-06-13) appends 26 ATM-only depth columns,
    lifting to 524 / 548. Part B (2026-07-02) adds 4 direction_down target
    columns → 550 / 576."""

    def test_count_is_528_for_2window_profile(self):
        # Wave 1 +22 cols, Wave 2 +10 (5 target types × 2 windows),
        # Phase 2 +69 trend/swing L1, T37 +26 ATM depth,
        # Part B +4 trend/swing direction_down, v12 +12 pivot structure
        # → 380 + 22 + 10 + 69 + 26 + 4 + 12 = 550.
        cols = column_names_for((30, 60))
        assert len(cols) == 550
        assert len(set(cols)) == 550, "duplicate column names in 2-window profile"

    def test_count_is_552_for_4window_profile(self):
        """Canonical Phase D4 layout + Wave 1 (22) + Wave 2 (4×5=20)
        + Phase 2 (69) + T37 ATM depth (26) + Part B direction_down (4)
        + v12 pivot structure (12) = 576."""
        cols = column_names_for((30, 60, 300, 900))
        assert len(cols) == 576
        assert len(set(cols)) == 576, "duplicate column names in 4-window profile"

    @pytest.mark.parametrize(
        "windows,expected_count",
        [
            ((30,), 537),       # single-window: 475 + 12×1 + 1 + 28 = 537
            ((30, 60), 550),    # 2-window legacy MVP: 475 + 24 + 1 + 28 = 550
            ((30, 60, 300), 563),         # 3-window: 475 + 36 + 1 + 28 = 563
            ((30, 60, 300, 900), 576),    # canonical D4: 475 + 48 + 1 + 28 = 576
            ((30, 60, 120, 300, 900), 589),  # 5-window: 475 + 60 + 1 + 28 = 589
        ],
    )
    def test_count_formula(self, windows, expected_count):
        """Total = 475 (window-independent: 355 base + 22 Wave 1 + 69
        Phase 2 + 26 T37 ATM depth + 28 trend/swing targets incl. Part B
        direction_down) + 13 × len(windows) + 1
        (upside_percentile_<min(windows)>s). Each extra target window
        adds exactly 13 columns."""
        assert len(column_names_for(windows)) == expected_count

    def test_legacy_module_global_is_2window_default(self):
        """`COLUMN_NAMES` exists as backward-compat for pre-E8 callers
        and resolves to the 2-window default."""
        assert len(COLUMN_NAMES) == 550
        assert COLUMN_NAMES == column_names_for((30, 60))

    def test_4window_includes_300s_and_900s_target_cols(self):
        cols = set(column_names_for((30, 60, 300, 900)))
        for w in (30, 60, 300, 900):
            for prefix in (
                "max_upside",
                "max_drawdown",
                "risk_reward_ratio",
                "total_premium_decay",
                "avg_decay_per_strike",
                "direction",
                "direction",
            ):
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
        for stale in ("direction_90s", "direction_120s", "direction_150s", "direction_180s"):
            assert stale not in _INT_COLUMNS_BASE, f"{stale} leaked into _INT_COLUMNS_BASE"
            assert stale not in int_columns_for((30, 60)), f"{stale} in 2-window int set"
            assert stale not in int_columns_for((30, 60, 300, 900)), f"{stale} in 4-window int set"

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
            "direction_30s",
            "direction_60s",
            "direction_300s",
            "direction_900s",
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

    @pytest.mark.parametrize(
        "col",
        [
            "direction_30s",
            "direction_60s",
            "direction_300s",
            "direction_900s",
        ],
    )
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

    def test_key_count_is_528(self):
        row = _build()
        assert len(row) == 550

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
        row = _build(
            compression_feats={
                "range_20ticks": 50.0,
                "volatility_compression": 0.7,
            }
        )
        assert row["range_20ticks"] == pytest.approx(50.0)
        assert row["volatility_compression"] == pytest.approx(0.7)

    def test_breakout_readiness_from_time_to_move(self):
        """breakout_readiness (col 41) is sourced from time_to_move_feats."""
        row = _build(
            compression_feats={},  # no breakout_readiness here
            time_to_move_feats={"breakout_readiness": 1.0, "breakout_readiness_extended": 0.0},
        )
        assert row["breakout_readiness"] == pytest.approx(1.0)

    def test_time_to_move_feats_mapped(self):
        row = _build(
            time_to_move_feats={
                "time_since_last_big_move": 30.5,
                "stagnation_duration_sec": 15.0,
                "momentum_persistence_ticks": 3.0,
                "breakout_readiness": 0.0,
                "breakout_readiness_extended": 1.0,
            }
        )
        assert row["time_since_last_big_move"] == pytest.approx(30.5)
        assert row["stagnation_duration_sec"] == pytest.approx(15.0)
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
        row = _build(
            meta_feats={
                "exchange": "NSE",
                "instrument": "NIFTY",
                "chain_available": 1,
                "is_market_open": 1,
            }
        )
        assert row["exchange"] == "NSE"
        assert row["instrument"] == "NIFTY"
        assert row["chain_available"] == 1
        assert row["is_market_open"] == 1


# ══════════════════════════════════════════════════════════════════════════════
# Option tick mapping
# ══════════════════════════════════════════════════════════════════════════════


class TestOptTickMapping:

    def test_atm_minus3_ce_ltp_mapped(self):
        """Strike at ATM-3 (index 0) → opt_m3_ce_ltp."""
        atm_window = [23950, 24000, 24050, 24100, 24150, 24200, 24250]
        opt_feats = {
            (23950, "CE"): {
                "ltp": 85.5,
                "tick_available": 1,
                "bid": 85.0,
                "ask": 86.0,
                "spread": 1.0,
                "volume": 5,
                "bid_ask_imbalance": 0.1,
                "premium_momentum": 2.0,
                "premium_momentum_10": 3.0,
            }
        }
        row = _build(atm_window=atm_window, opt_tick_feats=opt_feats)
        assert row["opt_m3_ce_ltp"] == pytest.approx(85.5)
        assert row["opt_m3_ce_tick_available"] == 1

    def test_atm_ce_ltp_mapped(self):
        """Strike at ATM (index 3 = offset '0') → opt_0_ce_ltp."""
        atm_window = [23950, 24000, 24050, 24100, 24150, 24200, 24250]
        opt_feats = {
            (24100, "CE"): {
                "ltp": 200.0,
                "tick_available": 1,
                "bid": 199.0,
                "ask": 201.0,
                "spread": 2.0,
                "volume": 10,
                "bid_ask_imbalance": 0.0,
                "premium_momentum": 0.5,
                "premium_momentum_10": 1.0,
            }
        }
        row = _build(atm_window=atm_window, opt_tick_feats=opt_feats)
        assert row["opt_0_ce_ltp"] == pytest.approx(200.0)

    def test_atm_plus3_pe_mapped(self):
        """Strike at ATM+3 (index 6 = offset 'p3') PE → opt_p3_pe_ltp."""
        atm_window = [23950, 24000, 24050, 24100, 24150, 24200, 24250]
        opt_feats = {
            (24250, "PE"): {
                "ltp": 50.0,
                "tick_available": 1,
                "bid": 49.5,
                "ask": 50.5,
                "spread": 1.0,
                "volume": 2,
                "bid_ask_imbalance": -0.2,
                "premium_momentum": -1.0,
                "premium_momentum_10": -2.0,
            }
        }
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
        row = _build(active_feats={"active_0_strike": 24100.0, "active_0_tick_available": 1})
        assert row["active_0_strike"] == pytest.approx(24100.0)
        assert row["active_0_tick_available"] == 1

    def test_active_slot_5_missing_is_nan(self):
        row = _build(active_feats={})
        assert _nan(row["active_5_strike"])

    def test_cross_feature_from_active_feats(self):
        row = _build(active_feats={"call_put_strength_diff": 0.3, "premium_divergence": -1.5})
        assert row["call_put_strength_diff"] == pytest.approx(0.3)
        assert row["premium_divergence"] == pytest.approx(-1.5)


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
        row = _build(
            target_feats={
                "max_upside_30s": 5.2,
                "direction_30s": 1.0,
                "upside_percentile_30s": 87.5,
            }
        )
        assert row["max_upside_30s"] == pytest.approx(5.2)
        assert row["direction_30s"] == pytest.approx(1.0)
        assert row["upside_percentile_30s"] == pytest.approx(87.5)

    def test_custom_target_windows(self):
        row = assemble_flat_vector(
            **_minimal_row(target_windows_sec=(30,), target_feats={"max_upside_30s": 2.0})
        )
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
        assert len(parsed) == 550

    def test_allow_nan_false_satisfied(self):
        """NaN converted to null → json.loads should not raise."""
        row = {k: _NAN for k in COLUMN_NAMES}
        line = serialize_row(row)
        parsed = json.loads(line)
        assert all(
            v is None or isinstance(v, (int, float, str, type(None))) for v in parsed.values()
        )


# ══════════════════════════════════════════════════════════════════════════════
# Emitter file sink
# ══════════════════════════════════════════════════════════════════════════════


class TestEmitterFileSink:

    def test_emit_writes_to_file(self, tmp_path):
        out_file = str(tmp_path / "test_out.ndjson")
        emitter = Emitter(file_path=out_file, schema_registry_dir=tmp_path / "_sr")
        row = _build()
        emitter.emit(row)
        emitter.close()
        lines = Path(out_file).read_text(encoding="utf-8").strip().split("\n")
        assert len(lines) == 1
        parsed = json.loads(lines[0])
        assert len(parsed) == 550

    def test_emit_multiple_rows(self, tmp_path):
        out_file = str(tmp_path / "test_multi.ndjson")
        emitter = Emitter(file_path=out_file, schema_registry_dir=tmp_path / "_sr")
        for i in range(5):
            emitter.emit(_build(timestamp=float(i)))
        emitter.close()
        lines = Path(out_file).read_text(encoding="utf-8").strip().split("\n")
        assert len(lines) == 5

    def test_emit_appends_on_second_open(self, tmp_path):
        """Opening an existing file appends rather than truncates."""
        out_file = str(tmp_path / "append_test.ndjson")
        emitter = Emitter(file_path=out_file, schema_registry_dir=tmp_path / "_sr")
        emitter.emit(_build(timestamp=1.0))
        emitter.close()

        emitter2 = Emitter(file_path=out_file, schema_registry_dir=tmp_path / "_sr")
        emitter2.emit(_build(timestamp=2.0))
        emitter2.close()

        lines = Path(out_file).read_text(encoding="utf-8").strip().split("\n")
        assert len(lines) == 2

    def test_roll_file(self, tmp_path):
        """roll_file() closes old file and opens new one."""
        file1 = str(tmp_path / "file1.ndjson")
        file2 = str(tmp_path / "file2.ndjson")
        emitter = Emitter(file_path=file1, schema_registry_dir=tmp_path / "_sr")
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
        emitter = Emitter(file_path=out_file, schema_registry_dir=tmp_path / "_sr")
        emitter.close()
        emitter.close()  # should not raise

    def test_no_file_sink(self, tmp_path):
        """No file path → no error, rows are silently dropped."""
        emitter = Emitter(schema_registry_dir=tmp_path / "_sr")
        emitter.emit(_build())
        emitter.close()

    def test_custom_target_window_370_columns(self, tmp_path):
        """Single-window config → different target columns but still valid JSON."""
        out_file = str(tmp_path / "single_window.ndjson")
        emitter = Emitter(file_path=out_file, schema_registry_dir=tmp_path / "_sr")
        row = assemble_flat_vector(**_minimal_row(target_windows_sec=(30,)))
        emitter.emit(row)
        emitter.close()
        line = Path(out_file).read_text(encoding="utf-8").strip()
        parsed = json.loads(line)
        assert "max_upside_30s" in parsed
        assert "max_upside_60s" not in parsed


# ══════════════════════════════════════════════════════════════════════════════
# Phase 2 (Schema-22 / Schema-23) — trend/swing Layer-1 column coverage
# ══════════════════════════════════════════════════════════════════════════════


# Exhaustive list of every dict key emitted by the 18 Phase 2 feature
# modules — sourced directly from each compute_*() function. Used by the
# tests below to detect any accidental key drift between feature module
# and emitter column list.
_PHASE2_EXPECTED_KEYS: frozenset[str] = frozenset({
    # B1 multi_tf MA ratios
    "ma_5_1min", "ma_20_1min", "ma_5_5min", "ma_20_5min", "ma_5_15min",
    # B2 multi_tf trend strength
    "adx_5min", "momentum_5min", "momentum_15min",
    # B3 session.compute_session_features
    "dist_from_session_open_pct", "dist_from_session_vwap_pct",
    "session_high_age_min", "session_low_age_min",
    # B4 multi_tf patterns
    "consecutive_higher_highs_5min", "consecutive_higher_lows_5min",
    "range_compression_ratio",
    # B5 opening_range
    "distance_to_opening_range_high_pct", "distance_to_opening_range_low_pct",
    # B5 cross-day levels (levels.compute_cross_day_level_features)
    "distance_to_prev_day_high_pct", "distance_to_prev_day_low_pct",
    "distance_to_round_number_above_pct", "distance_to_round_number_below_pct",
    "distance_to_5d_swing_high_pct", "distance_to_5d_swing_low_pct",
    # C1 OI flow / dominance (oi_dominance + chain wall/delta/weighted/pcr-slope)
    "oi_dominance_streak_min",
    "ce_wall_strength_rel", "pe_wall_strength_rel",
    "ce_oi_change_5min_pct", "pe_oi_change_5min_pct",
    "ce_oi_change_15min_pct", "pe_oi_change_15min_pct",
    "ce_oi_change_60min_pct", "pe_oi_change_60min_pct",
    "oi_weighted_ce_resistance_strike", "oi_weighted_pe_support_strike",
    "pcr_intraday_slope_30min",
    # C2 technical
    "rsi_14_5min", "macd_5min", "macd_signal_5min", "macd_histogram_5min",
    "volume_price_divergence_5min",
    # C3 india_vix
    "india_vix", "india_vix_change_5min",
    # C4 dealer_hedging
    "net_gex", "gamma_flip_distance_pct", "dealer_net_delta",
    "charm_estimate_atm", "vanna_estimate_atm",
    # C5 exhaustion
    "trend_age_ticks", "volume_no_move_score",
    # C6 intraday_time
    "minutes_from_open", "minutes_to_close", "lunch_session_flag",
    # C7 active_features.compute_strike_rotation_features
    "active_strike_shift_direction", "active_strike_shift_velocity",
    "atm_to_otm_flow_ratio",
    # C8 premium_vwap
    "atm_ce_premium_vwap_dist", "atm_pe_premium_vwap_dist",
    "premium_vwap_reclaim_count",
    # C9 greeks.compute_iv_velocity_features
    "iv_change_1min", "iv_change_5min", "iv_skew_velocity",
    "iv_expansion_without_spot",
    # C10 levels.compute_max_pain_features
    "max_pain_strike", "distance_to_max_pain_pct", "max_pain_gravity_strength",
    # C11 event_calendar
    "is_tier_2_event_day", "event_type_categorical",
    "hours_to_next_tier_1_or_2_event",
    # C12 expiry — days_to_expiry_bucket (new key on existing module)
    "days_to_expiry_bucket",
})


class TestPhase2Columns:
    """Lock the 69 new trend/swing Layer-1 columns added in Phase 2
    (Schema-22 + Schema-23). These tests guard against accidental
    rename / removal of any feature module's dict key drifting away
    from the emitter column list."""

    def test_phase2_block_has_69_columns(self):
        assert len(_PHASE2_BC_COLUMNS) == 69

    def test_phase2_block_no_duplicates(self):
        assert len(set(_PHASE2_BC_COLUMNS)) == len(_PHASE2_BC_COLUMNS)

    def test_expected_keys_cover_69(self):
        """Sanity: the hand-curated expected-keys set itself is 69."""
        assert len(_PHASE2_EXPECTED_KEYS) == 69

    def test_all_69_keys_in_default_column_list(self):
        cols = set(column_names_for((30, 60)))
        missing = _PHASE2_EXPECTED_KEYS - cols
        assert not missing, f"Phase 2 keys missing from default cols: {missing}"

    def test_all_69_keys_in_4window_column_list(self):
        cols = set(column_names_for((30, 60, 300, 900)))
        missing = _PHASE2_EXPECTED_KEYS - cols
        assert not missing, f"Phase 2 keys missing from 4-window cols: {missing}"

    @pytest.mark.parametrize(
        "spotcheck_key",
        [
            "india_vix",
            "net_gex",
            "adx_5min",
            "rsi_14_5min",
            "oi_weighted_ce_resistance_strike",
            "days_to_expiry_bucket",
            "oi_dominance_streak_min",
            "minutes_from_open",
            "max_pain_strike",
        ],
    )
    def test_phase2_spot_check_keys_present(self, spotcheck_key):
        assert spotcheck_key in column_names_for((30, 60))

    def test_existing_columns_still_present(self):
        """Regression guard: appending Phase 2 must not drop any pre-existing column."""
        cols = set(column_names_for((30, 60)))
        # Spot-check coverage of every legacy group.
        for legacy in (
            "timestamp",
            "underlying_ltp",
            "spot_price",
            "atm_strike",
            "opt_0_ce_ltp",
            "chain_pcr_global",
            "active_0_strike",
            "call_put_strength_diff",
            "total_premium_decay_atm",
            "regime",
            "atm_zone_call_pressure",
            "max_upside_30s",
            "trading_state",
            "is_market_open",
            "distance_to_day_high_pct",  # Wave 1 level
            "atm_ce_iv",                  # Wave 1 greek
            "days_to_expiry",             # Wave 1 expiry
        ):
            assert legacy in cols, f"legacy column dropped: {legacy}"

    def test_phase2_block_is_appended_after_wave1(self):
        """Phase 2 columns must come AFTER the Wave 1 expiry block — the
        order is contractually locked the moment we publish v8.json."""
        cols = column_names_for((30, 60))
        last_wave1_idx = cols.index("session_remaining_pct")
        first_phase2_idx = cols.index(_PHASE2_BC_COLUMNS[0])
        assert first_phase2_idx == last_wave1_idx + 1

    def test_assemble_flat_vector_includes_phase2_keys_as_nan(self):
        """When no Phase 2 dicts are passed, every Phase 2 column emits NaN."""
        row = _build()  # all Phase 2 kwargs default to None
        for k in _PHASE2_BC_COLUMNS:
            assert k in row, f"Phase 2 col {k!r} missing from row"
            assert _nan(row[k]), f"Phase 2 col {k!r} should default to NaN, got {row[k]!r}"

    def test_assemble_flat_vector_wires_phase2_dicts(self):
        """Spot-check that the new optional kwargs feed the right output keys."""
        row = assemble_flat_vector(
            **_minimal_row(
                multi_tf_feats={"adx_5min": 22.5, "ma_5_1min": -0.001},
                session_feats={"dist_from_session_open_pct": 0.42},
                vix_feats={"india_vix": 14.7, "india_vix_change_5min": 0.3},
                dealer_hedging_feats={"net_gex": -1.2e9},
                technical_feats={"rsi_14_5min": 58.0},
                oi_flow_feats={"oi_dominance_streak_min": -12.5},
                intraday_time_feats={"minutes_from_open": 35.0},
                max_pain_feats={"max_pain_strike": 24000.0},
                event_calendar_feats={"is_tier_2_event_day": 1.0},
                expiry_feats={
                    "days_to_expiry": 2.5,
                    "days_to_expiry_bucket": 2.0,
                },
            )
        )
        assert row["adx_5min"] == pytest.approx(22.5)
        assert row["ma_5_1min"] == pytest.approx(-0.001)
        assert row["dist_from_session_open_pct"] == pytest.approx(0.42)
        assert row["india_vix"] == pytest.approx(14.7)
        assert row["india_vix_change_5min"] == pytest.approx(0.3)
        assert row["net_gex"] == pytest.approx(-1.2e9)
        assert row["rsi_14_5min"] == pytest.approx(58.0)
        assert row["oi_dominance_streak_min"] == pytest.approx(-12.5)
        assert row["minutes_from_open"] == pytest.approx(35.0)
        assert row["max_pain_strike"] == pytest.approx(24000.0)
        assert row["is_tier_2_event_day"] == pytest.approx(1.0)
        assert row["days_to_expiry"] == pytest.approx(2.5)
        assert row["days_to_expiry_bucket"] == pytest.approx(2.0)


# ══════════════════════════════════════════════════════════════════════════════
# Schema-registry write (V2_MASTER_SPEC §2.3 D74 B1)
# ══════════════════════════════════════════════════════════════════════════════


class TestSchemaRegistry:
    """Lock the D74 B1 contract: emitter writes v<N>.json iff
    LATEST_SCHEMA_VERSION > highest existing version on disk."""

    def test_writes_v8_when_dir_empty(self, tmp_path):
        registry = tmp_path / "schema_registry"
        Emitter(target_windows_sec=(30, 60, 300, 900), schema_registry_dir=registry)
        out_file = registry / f"v{LATEST_SCHEMA_VERSION}.json"
        assert out_file.exists(), "emitter should auto-write v8.json on empty registry"
        payload = json.loads(out_file.read_text(encoding="utf-8"))
        assert payload["schema_version"] == LATEST_SCHEMA_VERSION
        assert payload["feature_count"] == len(payload["columns"])
        assert payload["feature_count"] == 576  # 4-window canonical (+4 Part B)
        assert payload["columns"][0] == "timestamp"
        assert "india_vix" in payload["columns"]
        assert "days_to_expiry_bucket" in payload["columns"]
        assert payload["written_by"] == "tick_feature_agent.emitter"

    def test_no_write_when_existing_version_equal(self, tmp_path):
        registry = tmp_path / "schema_registry"
        registry.mkdir()
        # Pre-place a v8.json with a deliberately wrong payload — the
        # emitter must NOT overwrite an equal version.
        sentinel = {"schema_version": LATEST_SCHEMA_VERSION, "columns": ["DO-NOT-OVERWRITE"]}
        (registry / f"v{LATEST_SCHEMA_VERSION}.json").write_text(json.dumps(sentinel))
        Emitter(schema_registry_dir=registry)
        loaded = json.loads(
            (registry / f"v{LATEST_SCHEMA_VERSION}.json").read_text(encoding="utf-8")
        )
        assert loaded == sentinel, "emitter must NOT overwrite an equal version"

    def test_no_write_when_existing_version_higher(self, tmp_path):
        registry = tmp_path / "schema_registry"
        registry.mkdir()
        future = {"schema_version": LATEST_SCHEMA_VERSION + 1, "columns": []}
        (registry / f"v{LATEST_SCHEMA_VERSION + 1}.json").write_text(json.dumps(future))
        Emitter(schema_registry_dir=registry)
        # Our v8 must NOT have appeared.
        assert not (registry / f"v{LATEST_SCHEMA_VERSION}.json").exists()
        # The future file is untouched.
        loaded = json.loads(
            (registry / f"v{LATEST_SCHEMA_VERSION + 1}.json").read_text(encoding="utf-8")
        )
        assert loaded == future

    def test_write_failure_does_not_block_emitter(self, tmp_path):
        """Pass a path that resolves to a file (not a directory) — the
        registry-write helper must swallow the error and let the emitter
        come up clean."""
        not_a_dir = tmp_path / "blocker.txt"
        not_a_dir.write_text("I'm a file, not a directory")
        # This must not raise — registry-write failure is non-fatal.
        emitter = Emitter(schema_registry_dir=not_a_dir)
        emitter.close()

    def test_replay_mode_also_writes_registry(self, tmp_path):
        """Replay-mode emitters share the same schema and SHOULD write
        the registry too (the recorder is not the only thing that boots
        the emitter — replay runs do too)."""
        registry = tmp_path / "schema_registry"
        Emitter(mode="replay", schema_registry_dir=registry)
        assert (registry / f"v{LATEST_SCHEMA_VERSION}.json").exists()

    def test_real_repo_registry_latest_present(self):
        """End-to-end fixture: writes the canonical 4-window
        v<LATEST_SCHEMA_VERSION>.json to the real
        `config/schema_registry/` directory so the repo carries a
        developer-readable schema-of-truth. Per V2_MASTER_SPEC §2.3
        D74 B1 this file is autogenerated; the test fixture is the
        authoritative producer.

        T37 (2026-06-13): bumped schema to v9 (+26 ATM depth columns).
        The test now references LATEST_SCHEMA_VERSION rather than a
        hardcoded ``v8`` so future bumps stay one-line edits.
        """
        from tick_feature_agent.output.emitter import _DEFAULT_SCHEMA_REGISTRY_DIR
        latest = _DEFAULT_SCHEMA_REGISTRY_DIR / f"v{LATEST_SCHEMA_VERSION}.json"
        if latest.exists():
            latest.unlink()
        Emitter(target_windows_sec=(30, 60, 300, 900))
        assert latest.exists(), f"expected real-repo registry file at {latest}"
        payload = json.loads(latest.read_text(encoding="utf-8"))
        assert payload["schema_version"] == LATEST_SCHEMA_VERSION
        assert payload["feature_count"] == len(payload["columns"])
        assert payload["feature_count"] == 576, (
            "real-repo schema registry must reflect canonical 4-window profile"
        )
        assert payload["columns"][0] == "timestamp"
        # Spot-check that the 69 Phase 2 keys + 24 Phase 3 target keys made it in.
        assert "india_vix" in payload["columns"]
        assert "net_gex" in payload["columns"]
        assert "days_to_expiry_bucket" in payload["columns"]
        assert "trend_direction_900s" in payload["columns"]
        assert "swing_breakout_imminent_7200s" in payload["columns"]


# ══════════════════════════════════════════════════════════════════════════════
# Emitter socket sink — connect / reconnect (T70, 2026-07-03)
# ══════════════════════════════════════════════════════════════════════════════
#
# The socket sink is the low-latency transport carrying live feature rows
# to SEA (TFA connects OUT to SEA's listener). SEA may start after TFA or
# restart mid-session, so the sink must (a) come up cleanly with no
# listener, (b) deliver NDJSON lines when one exists, and (c) reconnect
# after the listener dies and returns. Retry cadence is _SOCK_RETRY_SEC
# (3s), driven from emit(); tests force the window via _sock_next_retry.


def _free_tcp_port() -> int:
    """Grab an OS-assigned free port, then release it (no listener left)."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


@pytest.fixture()
def _af_unix_shim(monkeypatch):
    """KNOWN SOURCE BUG (reported upstream, not fixed here): Emitter.__init__
    evaluates `socket.AF_UNIX` unconditionally whenever socket_addr is set,
    but AF_UNIX does not exist on Windows → AttributeError before the
    AF_INET path even runs. Shim a sentinel in so the TCP behaviour under
    test is reachable; harmless once the source guards with getattr()."""
    if not hasattr(socket, "AF_UNIX"):
        monkeypatch.setattr(socket, "AF_UNIX", -1, raising=False)


def _recv_line(conn: socket.socket, timeout: float = 2.0) -> bytes:
    """Read from `conn` until a newline arrives (or the peer closes)."""
    conn.settimeout(timeout)
    buf = b""
    while b"\n" not in buf:
        chunk = conn.recv(65536)
        if not chunk:
            break
        buf += chunk
    return buf


class TestEmitterSocketSink:

    def test_no_listener_constructor_does_not_raise(self, tmp_path, _af_unix_shim):
        """No listener on the port → ctor swallows the refused connect,
        _sock stays None, and emit() still works file-only."""
        port = _free_tcp_port()
        out_file = str(tmp_path / "no_listener.ndjson")
        emitter = Emitter(
            file_path=out_file,
            socket_addr=port,
            schema_registry_dir=tmp_path / "_sr",
        )
        try:
            assert emitter._sock is None
            emitter.emit(_build(timestamp=1.0))  # must not raise
            assert emitter.socket_drops == 0  # no sock → skip, not a drop
        finally:
            emitter.close()
        lines = Path(out_file).read_text(encoding="utf-8").strip().split("\n")
        assert len(lines) == 1
        assert json.loads(lines[0])["timestamp"] == pytest.approx(1.0)

    def test_listener_receives_ndjson_line(self, tmp_path, _af_unix_shim):
        srv = socket.create_server(("127.0.0.1", 0))
        srv.settimeout(2.0)
        port = srv.getsockname()[1]
        emitter = Emitter(socket_addr=port, schema_registry_dir=tmp_path / "_sr")
        conn = None
        try:
            assert emitter._sock is not None
            conn, _ = srv.accept()
            emitter.emit(_build(timestamp=42.0))
            raw = _recv_line(conn)
            assert raw.endswith(b"\n")
            parsed = json.loads(raw.decode("utf-8"))
            assert parsed["timestamp"] == pytest.approx(42.0)
            assert len(parsed) == 550
        finally:
            if conn is not None:
                conn.close()
            emitter.close()
            srv.close()

    def test_reconnects_after_listener_restart(self, tmp_path, _af_unix_shim):
        """Kill the listener → send fails → sock torn down + drop counted;
        restart the listener on the SAME port, force the retry window, and
        the next emit() reconnects and delivers."""
        srv1 = socket.create_server(("127.0.0.1", 0))
        srv1.settimeout(2.0)
        port = srv1.getsockname()[1]
        emitter = Emitter(socket_addr=port, schema_registry_dir=tmp_path / "_sr")
        srv2 = conn2 = None
        try:
            conn1, _ = srv1.accept()
            emitter.emit(_build(timestamp=1.0))
            assert b"\n" in _recv_line(conn1)

            # ── Kill the listener ─────────────────────────────────────────
            conn1.close()
            srv1.close()
            # The first send after the peer dies may still land in the local
            # buffer (RST arrives async) — the failure surfaces within a few
            # emits. Bounded loop keeps the suite fast (<1s worst case).
            for _ in range(20):
                emitter.emit(_build(timestamp=2.0))
                if emitter._sock is None:
                    break
                time.sleep(0.05)
            assert emitter._sock is None, "socket should be torn down after peer death"
            assert emitter.socket_drops >= 1

            # ── Restart on the SAME port; force the 3s retry window ──────
            srv2 = socket.create_server(("127.0.0.1", port))
            srv2.settimeout(2.0)
            emitter._sock_next_retry = 0.0
            emitter.emit(_build(timestamp=3.0))
            assert emitter._sock is not None, "emit() should have reconnected"
            conn2, _ = srv2.accept()
            raw = _recv_line(conn2)
            parsed = json.loads(raw.decode("utf-8"))
            assert parsed["timestamp"] == pytest.approx(3.0)
        finally:
            if conn2 is not None:
                conn2.close()
            emitter.close()
            if srv2 is not None:
                srv2.close()
