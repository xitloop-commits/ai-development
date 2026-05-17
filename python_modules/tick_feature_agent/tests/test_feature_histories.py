"""Tests for state/feature_histories.py — caller-side ring buffers."""

from __future__ import annotations

import math

import pytest

from tick_feature_agent.state.feature_histories import (
    ACTIVE_STRIKES_RETENTION_SEC,
    ATM_DELTA_RETENTION_SEC,
    IV_VELOCITY_RETENTION_SEC,
    OI_TOTALS_RETENTION_SEC,
    PCR_RETENTION_SEC,
    VIX_RETENTION_SEC,
    FeatureHistories,
)


# ── Empty state ───────────────────────────────────────────────────────────


def test_default_state_is_empty():
    h = FeatureHistories()
    assert h.vix_list() == []
    assert h.pcr_list() == []
    assert h.oi_totals_list() == []
    assert h.iv_velocity_list() == []
    assert h.atm_delta_list() == []
    assert h.active_strikes_list() == []


def test_reset_clears_every_buffer():
    h = FeatureHistories()
    h.append_vix(1_000_000.0, 13.5)
    h.append_pcr(1_000_000.0, 0.9)
    h.append_oi_totals(1_000_000.0, 1000, 800)
    h.append_iv_velocity(1_000_000.0, 0.18, 0.20, 24000)
    h.append_atm_delta(1_000_000.0, 0.5, 0.18)
    h.append_active_strikes(1_000_000.0, [{"strike": 24000, "callOI": 100, "putOI": 100}])
    h.reset()
    assert h.vix_list() == []
    assert h.pcr_list() == []
    assert h.oi_totals_list() == []
    assert h.iv_velocity_list() == []
    assert h.atm_delta_list() == []
    assert h.active_strikes_list() == []


# ── append_vix ────────────────────────────────────────────────────────────


def test_vix_append_round_trips():
    h = FeatureHistories()
    h.append_vix(1_000_000.0, 13.5)
    assert h.vix_list() == [(1_000_000.0, 13.5)]


def test_vix_rejects_non_positive_value():
    h = FeatureHistories()
    h.append_vix(1_000_000.0, 0.0)
    h.append_vix(1_000_000.0, -1.0)
    h.append_vix(1_000_000.0, float("nan"))
    h.append_vix(float("nan"), 14.0)
    h.append_vix("not-a-float", 14.0)
    assert h.vix_list() == []


def test_vix_prunes_entries_older_than_retention():
    h = FeatureHistories()
    h.append_vix(1_000_000.0, 13.0)
    h.append_vix(1_000_000.0 + VIX_RETENTION_SEC + 1.0, 14.0)
    # First entry is now outside retention → pruned.
    assert len(h.vix_list()) == 1
    assert h.vix_list()[0][1] == 14.0


# ── append_pcr ────────────────────────────────────────────────────────────


def test_pcr_append_round_trips():
    h = FeatureHistories()
    h.append_pcr(1_000_000.0, 0.95)
    assert h.pcr_list() == [(1_000_000.0, 0.95)]


def test_pcr_allows_zero_for_neutral_state():
    h = FeatureHistories()
    h.append_pcr(1_000_000.0, 0.0)
    assert h.pcr_list() == [(1_000_000.0, 0.0)]


def test_pcr_rejects_nan_and_negative():
    h = FeatureHistories()
    h.append_pcr(1_000_000.0, float("nan"))
    h.append_pcr(1_000_000.0, -0.5)
    assert h.pcr_list() == []


def test_pcr_prunes_entries_older_than_retention():
    h = FeatureHistories()
    h.append_pcr(0.0, 0.5)
    h.append_pcr(PCR_RETENTION_SEC + 100.0, 0.9)
    assert len(h.pcr_list()) == 1
    assert h.pcr_list()[0][1] == 0.9


# ── append_oi_totals ──────────────────────────────────────────────────────


def test_oi_totals_append_round_trips():
    h = FeatureHistories()
    h.append_oi_totals(1_000_000.0, 12_345.0, 9_876.0)
    assert h.oi_totals_list() == [(1_000_000.0, 12_345.0, 9_876.0)]


def test_oi_totals_rejects_negative_side():
    h = FeatureHistories()
    h.append_oi_totals(1_000_000.0, -5.0, 100.0)
    h.append_oi_totals(1_000_000.0, 100.0, -5.0)
    h.append_oi_totals(1_000_000.0, float("nan"), 100.0)
    assert h.oi_totals_list() == []


def test_oi_totals_prunes_entries_older_than_retention():
    h = FeatureHistories()
    h.append_oi_totals(0.0, 1000, 1000)
    h.append_oi_totals(OI_TOTALS_RETENTION_SEC + 1.0, 2000, 2000)
    assert len(h.oi_totals_list()) == 1


# ── append_iv_velocity ────────────────────────────────────────────────────


def test_iv_velocity_append_round_trips():
    h = FeatureHistories()
    h.append_iv_velocity(1_000_000.0, 0.18, 0.20, 24_000.0)
    assert h.iv_velocity_list() == [(1_000_000.0, 0.18, 0.20, 24_000.0)]


def test_iv_velocity_rejects_non_positive_components():
    h = FeatureHistories()
    h.append_iv_velocity(1_000_000.0, 0.0, 0.20, 24_000.0)
    h.append_iv_velocity(1_000_000.0, 0.18, 0.0, 24_000.0)
    h.append_iv_velocity(1_000_000.0, 0.18, 0.20, 0.0)
    h.append_iv_velocity(1_000_000.0, float("nan"), 0.20, 24_000.0)
    assert h.iv_velocity_list() == []


def test_iv_velocity_prunes_old_entries():
    h = FeatureHistories()
    h.append_iv_velocity(0.0, 0.18, 0.20, 24_000.0)
    h.append_iv_velocity(IV_VELOCITY_RETENTION_SEC + 1.0, 0.19, 0.21, 24_100.0)
    assert len(h.iv_velocity_list()) == 1


# ── append_atm_delta ──────────────────────────────────────────────────────


def test_atm_delta_append_round_trips():
    h = FeatureHistories()
    h.append_atm_delta(1_000_000.0, 0.55, 0.18)
    assert h.atm_delta_list() == [(1_000_000.0, 0.55, 0.18)]


def test_atm_delta_accepts_negative_delta():
    """ATM PE delta is naturally negative — must NOT be rejected as invalid."""
    h = FeatureHistories()
    h.append_atm_delta(1_000_000.0, -0.45, 0.18)
    assert h.atm_delta_list()[0][1] == pytest.approx(-0.45)


def test_atm_delta_rejects_non_positive_iv():
    h = FeatureHistories()
    h.append_atm_delta(1_000_000.0, 0.55, 0.0)
    h.append_atm_delta(1_000_000.0, 0.55, -0.18)
    h.append_atm_delta(1_000_000.0, 0.55, float("nan"))
    h.append_atm_delta(1_000_000.0, float("nan"), 0.18)
    assert h.atm_delta_list() == []


def test_atm_delta_prunes_old_entries():
    h = FeatureHistories()
    h.append_atm_delta(0.0, 0.5, 0.18)
    h.append_atm_delta(ATM_DELTA_RETENTION_SEC + 1.0, 0.6, 0.19)
    assert len(h.atm_delta_list()) == 1


# ── append_active_strikes ─────────────────────────────────────────────────


def test_active_strikes_keeps_only_minimal_keys():
    h = FeatureHistories()
    h.append_active_strikes(
        1_000_000.0,
        [
            {
                "strike": 24_000,
                "callOI": 1_000,
                "putOI": 800,
                "callOIChange": 50,
                "putOIChange": 30,
                "callLTP": 245.5,    # not in the minimal set — must be dropped
                "putLTP": 95.0,
                "callVolume": 1_200,
                "putVolume": 800,
                "callIV": 18.5,
                "putIV": 17.2,
                "callSecurityId": "52175",
            }
        ],
    )
    row = h.active_strikes_list()[0][1][0]
    assert set(row.keys()) == {"strike", "callOI", "putOI", "callOIChange", "putOIChange"}


def test_active_strikes_skips_non_dict_rows():
    h = FeatureHistories()
    h.append_active_strikes(
        1_000_000.0,
        [
            "not-a-row",
            None,
            {"strike": 24_000, "callOI": 100, "putOI": 100},
        ],
    )
    assert len(h.active_strikes_list()[0][1]) == 1


def test_active_strikes_empty_rows_not_appended():
    h = FeatureHistories()
    h.append_active_strikes(1_000_000.0, [])
    h.append_active_strikes(1_000_000.0, [{"unrelated": 1}])  # no usable keys
    assert h.active_strikes_list() == []


def test_active_strikes_rejects_non_list_rows_argument():
    h = FeatureHistories()
    h.append_active_strikes(1_000_000.0, "not-a-list")  # type: ignore[arg-type]
    assert h.active_strikes_list() == []


def test_active_strikes_prunes_old_entries():
    h = FeatureHistories()
    h.append_active_strikes(0.0, [{"strike": 24_000, "callOI": 1, "putOI": 1}])
    h.append_active_strikes(
        ACTIVE_STRIKES_RETENTION_SEC + 1.0,
        [{"strike": 24_000, "callOI": 1, "putOI": 1}],
    )
    assert len(h.active_strikes_list()) == 1


# ── Integration with feature modules ──────────────────────────────────────


def test_vix_buffer_feeds_india_vix_feature():
    """End-to-end: append to vix buffer, feed list to the feature compute fn,
    verify a sensible output. This is the contract we built the buffer for."""
    from tick_feature_agent.features.india_vix import compute_india_vix_features

    h = FeatureHistories()
    now = 1_000_000.0
    h.append_vix(now - 300, 13.0)
    h.append_vix(now - 1, 15.0)
    out = compute_india_vix_features(now_ts=now, vix_history=h.vix_list())
    assert out["india_vix"] == pytest.approx(15.0)
    assert out["india_vix_change_5min"] == pytest.approx(2.0)


def test_oi_totals_buffer_feeds_oi_change_deltas():
    from tick_feature_agent.features.chain import compute_oi_change_deltas

    h = FeatureHistories()
    now = 1_000_000.0
    h.append_oi_totals(now - 300, 1_000_000, 800_000)
    h.append_oi_totals(now - 1, 1_100_000, 750_000)
    out = compute_oi_change_deltas(oi_history=h.oi_totals_list(), now_ts=now)
    assert math.isfinite(out["ce_oi_change_5min_pct"])
    assert math.isfinite(out["pe_oi_change_5min_pct"])
    assert out["ce_oi_change_5min_pct"] > 0  # CE grew
    assert out["pe_oi_change_5min_pct"] < 0  # PE shrank
