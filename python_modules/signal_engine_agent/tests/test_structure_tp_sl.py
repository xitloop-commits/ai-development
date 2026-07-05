"""
Tests for structure-aware TP/SL (Part B SEA rule, 2026-07-06).

The model gives TP/SL magnitude; structure caps the TP at the nearest
favourable wall and widens the SL just beyond the nearest adverse wall
(bounded), converting underlying levels to premium via the leg delta. Behind
Wave2Thresholds.structure_tp_sl — a strict no-op when off.
"""

from __future__ import annotations

import math

from signal_engine_agent.thresholds import (
    StructureContext,
    Wave2Thresholds,
    _apply_structure_tp_sl,
    decide_action_wave2,
)

_CFG = Wave2Thresholds(
    structure_tp_sl=True,
    structure_sl_buffer_pct=0.02,
    structure_sl_widen_cap=1.5,
    structure_min_rr=0.5,
)


# ── pure helper ───────────────────────────────────────────────────────────


def test_call_tp_capped_at_resistance():
    # resistance 16 pts up @ delta .5 → premium wall 108 caps model TP 110.
    tp, sl = _apply_structure_tp_sl(
        is_call=True, entry=100, delta=0.5, spot=50000,
        nearest_resistance=50016, nearest_support=49980,
        model_tp=110, model_sl=95, cfg=_CFG,
    )
    assert tp == 108.0
    assert sl == 92.5  # widened to 1.5× model SL cap


def test_call_tp_not_extended_when_wall_far():
    tp, _ = _apply_structure_tp_sl(
        is_call=True, entry=100, delta=0.5, spot=50000,
        nearest_resistance=50100, nearest_support=49980,
        model_tp=110, model_sl=95, cfg=_CFG,
    )
    assert tp == 110  # never target BEYOND the model TP


def test_put_uses_support_for_tp_and_resistance_for_sl():
    tp, sl = _apply_structure_tp_sl(
        is_call=False, entry=80, delta=-0.5, spot=50000,
        nearest_resistance=50020, nearest_support=49984,
        model_tp=90, model_sl=76, cfg=_CFG,
    )
    assert tp == 88.0  # capped at support (favourable wall for a put)
    assert sl == 74.0  # widened just beyond resistance, bounded by cap


def test_fallback_when_wall_crushes_rr():
    # resistance 2 pts up → TP≈101, RR≈0.13 < 0.5 → keep model TP/SL.
    tp, sl = _apply_structure_tp_sl(
        is_call=True, entry=100, delta=0.5, spot=50000,
        nearest_resistance=50002, nearest_support=49980,
        model_tp=110, model_sl=95, cfg=_CFG,
    )
    assert (tp, sl) == (110, 95)


def test_noop_on_bad_delta():
    for bad in (float("nan"), 0.0):
        tp, sl = _apply_structure_tp_sl(
            is_call=True, entry=100, delta=bad, spot=50000,
            nearest_resistance=50016, nearest_support=49980,
            model_tp=110, model_sl=95, cfg=_CFG,
        )
        assert (tp, sl) == (110, 95)


def test_sl_never_tightened():
    # Support is FURTHER than the model SL → SL must not move closer to entry.
    tp, sl = _apply_structure_tp_sl(
        is_call=True, entry=100, delta=0.5, spot=50000,
        nearest_resistance=50040, nearest_support=49900,  # far support
        model_tp=110, model_sl=98, cfg=_CFG,
    )
    assert sl <= 98  # widened or unchanged, never tighter


# ── decide_action_wave2 integration ───────────────────────────────────────


def _passing_preds(prob=0.80):
    return {
        "direction_prob_60s": prob,
        "risk_reward_ratio_60s": 2.0,
        "upside_percentile_60s": 70.0,
        "direction_persists_60s": 0.80,
        "direction_persists_300s": 0.70,
        "exit_signal_60s": 0.10,
        "max_upside_300s": 20.0,
        "max_drawdown_300s": 10.0,
        "max_upside_pe_300s": 20.0,
        "max_drawdown_pe_300s": 10.0,
    }


def _ctx():
    return StructureContext(
        spot=50000, ce_delta=0.5, pe_delta=-0.5,
        nearest_resistance=50016, nearest_support=49980,
    )


def test_wave2_flag_off_is_unchanged():
    off = Wave2Thresholds(structure_tp_sl=False)
    base = decide_action_wave2(_passing_preds(), wave2_thresholds=off,
                               ce_ltp=100, pe_ltp=80, structure=_ctx())
    # Same as passing no structure at all.
    ref = decide_action_wave2(_passing_preds(), wave2_thresholds=off,
                              ce_ltp=100, pe_ltp=80)
    assert (base.tp, base.sl) == (ref.tp, ref.sl)


def test_wave2_flag_on_clips_tp():
    on = Wave2Thresholds(structure_tp_sl=True, structure_min_rr=0.3)
    off = Wave2Thresholds(structure_tp_sl=False)
    got = decide_action_wave2(_passing_preds(), wave2_thresholds=on,
                              ce_ltp=100, pe_ltp=80, structure=_ctx())
    ref = decide_action_wave2(_passing_preds(), wave2_thresholds=off,
                              ce_ltp=100, pe_ltp=80)
    assert got.gate_passed and got.action == "LONG_CE"
    assert got.tp < ref.tp  # TP was clipped toward the resistance wall
    assert got.rr == round((got.tp - got.entry) / (got.entry - got.sl), 2)


def test_wave2_structure_none_is_noop():
    on = Wave2Thresholds(structure_tp_sl=True)
    got = decide_action_wave2(_passing_preds(), wave2_thresholds=on,
                              ce_ltp=100, pe_ltp=80, structure=None)
    off = Wave2Thresholds(structure_tp_sl=False)
    ref = decide_action_wave2(_passing_preds(), wave2_thresholds=off,
                              ce_ltp=100, pe_ltp=80)
    assert (got.tp, got.sl) == (ref.tp, ref.sl)
