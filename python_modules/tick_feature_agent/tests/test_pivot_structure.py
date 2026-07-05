"""
tests/test_pivot_structure.py — unit tests for the PivotStructureTracker.

There is a single (scalar, stateful) code path used by BOTH live and replay,
so these tests validate the detection logic directly; no columnar parity test
is needed (unlike the target/label builders).

Covered:
    1. A single swing high is confirmed exactly k ticks late (no look-ahead)
       with the correct signed % distance and bars-since count.
    2. HH vs LH (and HL vs LL) classification across two consecutive pivots.
    3. Emergent structure = +1 on a drifting-up zig-zag, -1 on drifting-down.
    4. NaN policy: distances / is_hh / is_hl NaN until available; structure
       is never NaN (0 = neutral).
    5. Bad spot (<=0 / NaN / None) leaves state untouched.
    6. Every row carries exactly the 12 canonical columns.
"""

from __future__ import annotations

import math

from tick_feature_agent.features.pivot_structure import (
    PIVOT_STRUCTURE_COLUMNS,
    PivotStructureTracker,
    pivot_structure_column_names,
)


def _feed(tracker: PivotStructureTracker, prices):
    row = {}
    for p in prices:
        row = tracker.update(p)
    return row


# ── 1. single swing high: confirmation lag, distance, bars-since ──────────


def test_swing_high_confirmed_k_ticks_late():
    # k=2 → a pivot at the centre of a 5-tick window confirms 2 ticks later.
    t = PivotStructureTracker(swing_k=2, trend_k=100)
    prices = [10.0, 11.0, 12.0, 11.0, 10.0]  # peak (12) at index 2

    # After only 4 ticks the 5-window is not full → nothing confirmed yet.
    row4 = _feed(t, prices[:4])
    assert math.isnan(row4["pivot_swing_dist_high_pct"])
    assert math.isnan(row4["pivot_swing_bars_since"])

    # The 5th tick (index 4) closes the window; the high at index 2 confirms.
    row5 = t.update(prices[4])
    # spot=10, last_high=12 → (10-12)/10*100 = -20.0
    assert row5["pivot_swing_dist_high_pct"] == -20.0
    # most recent pivot at tick 2, now at tick 4 → 2 bars since
    assert row5["pivot_swing_bars_since"] == 2.0
    # only one high so far → not yet classifiable
    assert math.isnan(row5["pivot_swing_high_is_hh"])


def test_swing_low_confirmed_and_distance():
    t = PivotStructureTracker(swing_k=2, trend_k=100)
    prices = [12.0, 11.0, 10.0, 11.0, 12.0]  # trough (10) at index 2
    row = _feed(t, prices)
    # spot=12, last_low=10 → (12-10)/12*100 = +16.666..
    assert row["pivot_swing_dist_low_pct"] == (12.0 - 10.0) / 12.0 * 100.0
    assert row["pivot_swing_bars_since"] == 2.0


# ── 2. HH vs LH classification across two highs ───────────────────────────


def test_higher_high_sets_hh_true():
    t = PivotStructureTracker(swing_k=2, trend_k=100)
    # high@idx2=12 (confirms idx4), then higher high@idx6=14 (confirms idx8)
    prices = [10, 11, 12, 11, 10, 11, 14, 12, 11]
    row = _feed(t, [float(p) for p in prices])
    assert row["pivot_swing_high_is_hh"] == 1.0  # 14 > 12


def test_lower_high_sets_hh_false():
    t = PivotStructureTracker(swing_k=2, trend_k=100)
    # high@idx2=14 (confirms idx4), then lower high@idx6=12 (confirms idx8)
    prices = [10, 11, 14, 11, 10, 11, 12, 11, 10]
    row = _feed(t, [float(p) for p in prices])
    assert row["pivot_swing_high_is_hh"] == 0.0  # 12 < 14


# ── 3. emergent structure on a drifting zig-zag ───────────────────────────


def _zigzag(n, drift, amp=5.0, period=20):
    return [100.0 + drift * i + amp * math.sin(2 * math.pi * i / period) for i in range(n)]


def test_uptrend_structure_is_plus_one():
    # rising sine: peaks make higher highs, troughs higher lows → +1
    t = PivotStructureTracker(swing_k=5, trend_k=200)
    row = _feed(t, _zigzag(80, drift=+0.6))
    assert row["pivot_swing_high_is_hh"] == 1.0
    assert row["pivot_swing_low_is_hl"] == 1.0
    assert row["pivot_swing_structure"] == 1.0


def test_downtrend_structure_is_minus_one():
    t = PivotStructureTracker(swing_k=5, trend_k=200)
    row = _feed(t, _zigzag(80, drift=-0.6))
    assert row["pivot_swing_high_is_hh"] == 0.0
    assert row["pivot_swing_low_is_hl"] == 0.0
    assert row["pivot_swing_structure"] == -1.0


# ── 4. NaN / neutral policy ───────────────────────────────────────────────


def test_structure_never_nan_before_pivots():
    t = PivotStructureTracker(swing_k=2, trend_k=100)
    row = _feed(t, [100.0, 100.5, 101.0])  # too few ticks for any pivot
    assert row["pivot_swing_structure"] == 0.0  # neutral, not NaN
    assert row["pivot_trend_structure"] == 0.0
    assert math.isnan(row["pivot_swing_dist_high_pct"])
    assert math.isnan(row["pivot_swing_high_is_hh"])


# ── 5. bad spot leaves state untouched ────────────────────────────────────


def _rows_equal(a: dict, b: dict) -> bool:
    if a.keys() != b.keys():
        return False
    for k in a:
        av, bv = a[k], b[k]
        if isinstance(av, float) and math.isnan(av):
            if not (isinstance(bv, float) and math.isnan(bv)):
                return False
        elif av != bv:
            return False
    return True


def test_bad_spot_ignored():
    # A garbage tick must be a pure no-op: it neither advances the tick index
    # nor mutates history. Proof: interleaving garbage into a good stream must
    # yield a final row identical to feeding the good stream alone.
    good = [10.0, 11.0, 12.0, 11.0, 10.0, 10.5]
    clean = PivotStructureTracker(swing_k=2, trend_k=100)
    row_clean = _feed(clean, good)

    dirty = PivotStructureTracker(swing_k=2, trend_k=100)
    stream = [10.0, 11.0, 12.0, 0.0, 11.0, -1.0, 10.0, float("nan"), None, 10.5]
    row_dirty = {}
    for p in stream:
        r = dirty.update(p)
        if p is None or (isinstance(p, float) and (math.isnan(p) or p <= 0.0)):
            assert math.isnan(r["pivot_swing_dist_high_pct"])  # garbage → all-NaN
        row_dirty = r

    assert _rows_equal(row_clean, row_dirty)


# ── 6. schema ─────────────────────────────────────────────────────────────


def test_row_has_exactly_canonical_columns():
    t = PivotStructureTracker()
    row = t.update(100.0)
    assert tuple(row.keys()) == PIVOT_STRUCTURE_COLUMNS
    assert pivot_structure_column_names() == PIVOT_STRUCTURE_COLUMNS
    assert len(PIVOT_STRUCTURE_COLUMNS) == 12
