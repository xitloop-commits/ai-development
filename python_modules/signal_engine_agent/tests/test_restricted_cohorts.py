"""--only-cohorts allowlist (2026-08-10 MCX sma5-only mandate).

The MCX engines run with --only-cohorts sma5: every other toggleable cohort
is pinned OFF at boot and the global control-panel pushes (which mutate the
live dict directly) must not be able to re-enable them.
"""
from signal_engine_agent.engine import _RestrictedCohorts


def _base() -> dict:
    return {
        "scalp": True, "trend": True, "ma": True, "sma5": True,
        "rev_pct": 0.1, "sma5_confirm": 1, "sma5_buffer": 0.0,
        "sma5_entry_watch": 0,
    }


def test_disallowed_cohorts_pinned_off_at_boot():
    d = _RestrictedCohorts(_base(), frozenset({"sma5"}))
    assert d["sma5"] is True
    assert d["scalp"] is False
    assert d["trend"] is False
    assert d["ma"] is False


def test_control_push_cannot_reenable_disallowed():
    d = _RestrictedCohorts(_base(), frozenset({"sma5"}))
    d["scalp"] = True          # global toggle push arrives
    assert d["scalp"] is False  # silently ignored


def test_allowed_cohort_still_toggleable_both_ways():
    d = _RestrictedCohorts(_base(), frozenset({"sma5"}))
    d["sma5"] = False
    assert d["sma5"] is False
    d["sma5"] = True
    assert d["sma5"] is True


def test_disallowed_can_still_be_turned_off_and_tunables_pass():
    d = _RestrictedCohorts(_base(), frozenset({"sma5"}))
    d["ma"] = False             # off is always fine
    assert d["ma"] is False
    d["rev_pct"] = 0.25         # non-toggle tunables pass through
    assert d["rev_pct"] == 0.25
    d["model"] = "20260807_1"   # model-swap key passes through
    assert d["model"] == "20260807_1"
