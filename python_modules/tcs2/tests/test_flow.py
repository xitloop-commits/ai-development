"""TCS2 - tests for the fifteen order-flow readings.

Spec: docs/systems/14_tcs2.md D27

Every test builds an explicit tape, so each assertion says what the rule means
rather than what the code happens to do.
"""
from __future__ import annotations

import pytest

from tcs2 import flow
from tcs2.flow import BUY, PASSIVE, SELL, UNKNOWN, FlowState
from tcs2.wire import DepthLevel, ResponseCode, Tick

T0 = 1790000000.0


def tick(ts_offset: float, ltp: float, volume: int, bid: float = 0.0,
         ask: float = 0.0, bid_size: int = 100, ask_size: int = 100,
         depth_levels: int = 5, kind: int = ResponseCode.FULL) -> Tick:
    depth = tuple(
        DepthLevel(bid_size, ask_size, 2, 2, bid - i, ask + i)
        for i in range(depth_levels)) if (bid or ask) else ()
    return Tick(security_id=1, segment=2, kind=kind, recv_ts=T0 + ts_offset,
                ltp=ltp, volume=volume, ltq=0, bid=bid, ask=ask,
                bid_size=bid_size, ask_size=ask_size, depth=depth)


def feed(fs: FlowState, rows: list[tuple[float, float, int, float, float]]) -> None:
    """rows are (ts_offset, ltp, cumulative_volume, bid, ask)."""
    for off, ltp, vol, bid, ask in rows:
        fs.on_tick(tick(off, ltp, vol, bid, ask))


# -- rule 1: trade side --------------------------------------------------

def test_classify_lifting_the_offer_is_a_buy():
    assert flow.classify(101.0, 99.0, 101.0) == BUY
    assert flow.classify(102.0, 99.0, 101.0) == BUY


def test_classify_hitting_the_bid_is_a_sell():
    assert flow.classify(99.0, 99.0, 101.0) == SELL
    assert flow.classify(98.0, 99.0, 101.0) == SELL


def test_classify_inside_the_spread_is_passive():
    assert flow.classify(100.0, 99.0, 101.0) == PASSIVE


def test_no_book_is_unknown_not_passive():
    """Calling a bookless print passive would relabel real aggression as neutral."""
    assert flow.classify(100.0, 0.0, 0.0) == UNKNOWN


def test_unknown_prints_are_counted_and_excluded():
    fs = FlowState()
    fs.on_tick(tick(0, 100.0, 1000))              # no book at all
    fs.on_tick(tick(1, 100.0, 1100))
    assert fs.unknown_prints == 1                 # the second had a volume delta
    assert len(fs.prints) == 0
    assert fs.aggression(60)["total_qty"] == 0


# -- quantity from volume, not ltq --------------------------------------

def test_quantity_comes_from_the_volume_change():
    """ltq is the last trade only; two trades between packets would lose one."""
    fs = FlowState()
    feed(fs, [(0, 101.0, 1000, 99.0, 101.0), (1, 101.0, 1250, 99.0, 101.0)])
    assert [p.qty for p in fs.prints] == [250]


def test_first_tick_establishes_the_volume_baseline():
    fs = FlowState()
    feed(fs, [(0, 101.0, 5000, 99.0, 101.0)])
    assert len(fs.prints) == 0, "the first volume reading is a baseline, not a trade"


def test_falls_back_to_ltq_when_volume_is_absent():
    fs = FlowState()
    fs.on_tick(Tick(security_id=1, segment=2, kind=ResponseCode.FULL, recv_ts=T0,
                    ltp=101.0, ltq=130, bid=99.0, ask=101.0,
                    depth=(DepthLevel(1, 1, 1, 1, 99.0, 101.0),)))
    assert [p.qty for p in fs.prints] == [130]


# -- rules 2, 3: aggression shares --------------------------------------

def test_aggression_shares_sum_to_one():
    fs = FlowState()
    feed(fs, [(0, 100.0, 1000, 99.0, 101.0),
              (1, 101.0, 1300, 99.0, 101.0),      # buy 300
              (2, 99.0, 1500, 99.0, 101.0),       # sell 200
              (3, 100.0, 1600, 99.0, 101.0)])     # passive 100
    a = fs.aggression(60)
    assert a["buy_share"] == pytest.approx(300 / 600)
    assert a["sell_share"] == pytest.approx(200 / 600)
    assert a["passive_share"] == pytest.approx(100 / 600)
    assert a["total_qty"] == 600


def test_aggression_is_a_share_so_it_survives_a_scale_change():
    """The same tape at 1000x the quantity must read identically."""
    small, big = FlowState(), FlowState()
    feed(small, [(0, 100.0, 100, 99.0, 101.0), (1, 101.0, 400, 99.0, 101.0)])
    feed(big, [(0, 100.0, 100_000, 99.0, 101.0), (1, 101.0, 400_000, 99.0, 101.0)])
    assert small.aggression(60)["buy_share"] == big.aggression(60)["buy_share"]


def test_empty_window_reports_zero_not_an_error():
    fs = FlowState()
    a = fs.aggression(60)
    assert a == {"buy_share": 0.0, "sell_share": 0.0, "passive_share": 0.0,
                 "total_qty": 0, "prints": 0}


# -- rule 4: print size --------------------------------------------------

def test_large_prints_are_judged_against_the_session_median():
    fs = FlowState()
    rows = [(0, 100.0, 0, 99.0, 101.0)]
    vol = 0
    for i in range(1, 11):                        # ten prints of 100
        vol += 100
        rows.append((i, 101.0, vol, 99.0, 101.0))
    vol += 1000                                   # then one of 1000
    rows.append((11, 101.0, vol, 99.0, 101.0))
    feed(fs, rows)
    ps = fs.print_size(60)
    assert fs.median_qty == 100
    assert ps["large_prints"] == 1
    assert ps["max_qty"] == 1000


# -- rules 8, 9: delta ---------------------------------------------------

def test_delta_is_signed_quantity():
    fs = FlowState()
    feed(fs, [(0, 100.0, 1000, 99.0, 101.0),
              (1, 101.0, 1400, 99.0, 101.0),      # +400
              (2, 99.0, 1500, 99.0, 101.0)])      # -100
    assert fs.delta(60) == 300


def test_cumulative_delta_runs_for_the_session():
    fs = FlowState()
    feed(fs, [(0, 100.0, 1000, 99.0, 101.0),
              (1, 101.0, 1400, 99.0, 101.0),
              (2, 99.0, 1500, 99.0, 101.0)])
    assert fs.cumulative_delta() == 300


def test_cumulative_delta_outlives_the_window():
    """Rule 9 is a session total; trimming the window must not reset it."""
    fs = FlowState(window_sec=5.0)
    feed(fs, [(0, 100.0, 1000, 99.0, 101.0), (1, 101.0, 1500, 99.0, 101.0)])
    feed(fs, [(100, 101.0, 1600, 99.0, 101.0)])
    assert fs.delta(5) == 100                     # window forgot the 500
    assert fs.cumulative_delta() == 600           # the session did not


# -- rules 5, 6: absorption ---------------------------------------------

def test_buyers_absorbed_when_they_lift_and_price_does_not_rise():
    """Heavy lifting of the offer with price flat: someone bigger is selling."""
    fs = FlowState()
    rows = [(0, 100.0, 0, 99.5, 100.0)]
    vol = 0
    for i in range(1, 12):
        vol += 500
        rows.append((i, 100.0, vol, 99.5, 100.0))   # every print at the offer
    feed(fs, rows)
    a = fs.absorption(60)
    assert a["buyer_absorbed"] is True
    assert a["seller_absorbed"] is False
    assert a["price_change"] <= 0


def test_sellers_absorbed_when_they_hit_and_price_does_not_fall():
    fs = FlowState()
    rows = [(0, 100.0, 0, 100.0, 100.5)]
    vol = 0
    for i in range(1, 12):
        vol += 500
        rows.append((i, 100.0, vol, 100.0, 100.5))  # every print on the bid
    feed(fs, rows)
    a = fs.absorption(60)
    assert a["seller_absorbed"] is True
    assert a["buyer_absorbed"] is False


def test_not_absorption_when_price_follows_the_flow():
    fs = FlowState()
    rows = [(0, 100.0, 0, 99.5, 100.0)]
    vol = 0
    for i in range(1, 12):
        vol += 500
        px = 100.0 + i * 0.5
        rows.append((i, px, vol, px - 0.5, px))     # buying AND price rising
    feed(fs, rows)
    assert fs.absorption(60)["buyer_absorbed"] is False


# -- rule 7: pressure with response -------------------------------------

def test_pressure_with_price_responding():
    fs = FlowState()
    rows = [(0, 100.0, 0, 99.5, 100.0)]
    vol = 0
    for i in range(1, 12):
        vol += 400
        px = 100.0 + i * 0.5
        rows.append((i, px, vol, px - 0.5, px))
    feed(fs, rows)
    p = fs.pressure(60)
    assert p["direction"] == BUY
    assert p["responding"] is True
    assert p["price_change"] > 0


def test_pressure_not_responding_is_the_absorption_case():
    fs = FlowState()
    rows = [(0, 100.0, 0, 99.5, 100.0)]
    vol = 0
    for i in range(1, 12):
        vol += 400
        rows.append((i, 100.0, vol, 99.5, 100.0))
    feed(fs, rows)
    p = fs.pressure(60)
    assert p["direction"] == BUY
    assert p["responding"] is False


def test_balanced_flow_has_no_direction():
    fs = FlowState()
    feed(fs, [(0, 100.0, 0, 99.0, 101.0),
              (1, 101.0, 500, 99.0, 101.0),
              (2, 99.0, 1000, 99.0, 101.0)])
    assert fs.pressure(60)["direction"] == 0


# -- rule 10: exhaustion -------------------------------------------------

def test_exhaustion_when_flow_fades_and_price_stalls():
    fs = FlowState()
    rows = [(0, 100.0, 0, 99.5, 100.0)]
    vol = 0
    for i in range(1, 11):                        # busy first half
        vol += 1000
        rows.append((i, 100.0, vol, 99.5, 100.0))
    for i in range(11, 21):                       # quiet second half
        vol += 50
        rows.append((i, 100.0, vol, 99.5, 100.0))
    feed(fs, rows)
    e = fs.exhaustion(20, now=T0 + 20)
    assert e["exhausted"] is True
    assert e["flow_ratio"] < 0.6


def test_no_exhaustion_when_flow_holds_up():
    fs = FlowState()
    rows = [(0, 100.0, 0, 99.5, 100.0)]
    vol = 0
    for i in range(1, 21):
        vol += 1000
        rows.append((i, 100.0, vol, 99.5, 100.0))
    feed(fs, rows)
    assert fs.exhaustion(20, now=T0 + 20)["exhausted"] is False


# -- rules 11, 12: depth and imbalance ----------------------------------

def test_depth_sums_all_five_levels():
    fs = FlowState()
    fs.on_tick(tick(0, 100.0, 1000, 99.0, 101.0, bid_size=200, ask_size=50))
    d = fs.depth()
    assert d["bid_depth"] == 1000          # 5 levels x 200
    assert d["ask_depth"] == 250           # 5 levels x 50
    assert d["spread"] == pytest.approx(2.0)


def test_imbalance_is_a_ratio_between_minus_one_and_one():
    fs = FlowState()
    fs.on_tick(tick(0, 100.0, 1000, 99.0, 101.0, bid_size=300, ask_size=100))
    assert fs.imbalance() == pytest.approx((1500 - 500) / 2000)
    assert -1.0 <= fs.imbalance() <= 1.0


def test_imbalance_is_zero_with_no_book():
    assert FlowState().imbalance() == 0.0


def test_imbalance_survives_a_scale_change():
    a, b = FlowState(), FlowState()
    a.on_tick(tick(0, 100.0, 1, 99.0, 101.0, bid_size=30, ask_size=10))
    b.on_tick(tick(0, 100.0, 1, 99.0, 101.0, bid_size=30_000, ask_size=10_000))
    assert a.imbalance() == pytest.approx(b.imbalance())


# -- rule 13: liquidity removal -----------------------------------------

def test_ask_pulled_is_detected_against_the_previous_book():
    fs = FlowState()
    fs.on_tick(tick(0, 100.0, 1000, 99.0, 101.0, bid_size=100, ask_size=100))
    fs.on_tick(tick(1, 100.0, 1100, 99.0, 101.0, bid_size=100, ask_size=20))
    liq = fs.liquidity_removed()
    assert liq["ask_pulled"] is True
    assert liq["bid_pulled"] is False
    assert liq["ask_drop"] == pytest.approx(0.8)


def test_no_pull_reported_on_the_first_book():
    fs = FlowState()
    fs.on_tick(tick(0, 100.0, 1000, 99.0, 101.0))
    assert fs.liquidity_removed() == {"bid_pulled": False, "ask_pulled": False}


# -- rule 14: rejection --------------------------------------------------

def test_rejection_at_the_session_high():
    fs = FlowState()
    feed(fs, [(0, 100.0, 100, 99.0, 101.0),        # baseline volume reading
              (1, 105.0, 200, 104.0, 106.0),
              (2, 110.0, 300, 109.0, 111.0),       # spike up to the session high
              (3, 109.5, 400, 109.0, 111.0),
              (4, 104.0, 500, 103.0, 105.0)])      # pushed back down
    r = fs.rejection(60)
    assert r["rejected_high"] is True
    assert r["window_high"] == pytest.approx(110.0)


def test_rejection_tolerance_is_a_fraction_of_price():
    """0.1% must mean 0.1% whether the instrument trades at 270 or 56,000."""
    cheap, rich = FlowState(), FlowState()
    feed(cheap, [(0, 270.0, 100, 269.0, 271.0), (1, 275.0, 200, 274.0, 276.0),
                 (2, 280.0, 300, 279.0, 281.0), (3, 279.5, 400, 279.0, 281.0),
                 (4, 272.0, 500, 271.0, 273.0)])
    feed(rich, [(0, 56000.0, 100, 55990.0, 56010.0),
                (1, 57000.0, 200, 56990.0, 57010.0),
                (2, 58000.0, 300, 57990.0, 58010.0),
                (3, 57900.0, 400, 57890.0, 57910.0),
                (4, 56400.0, 500, 56390.0, 56410.0)])
    assert cheap.rejection(60)["rejected_high"] is True
    assert cheap.rejection(60)["rejected_high"] == rich.rejection(60)["rejected_high"]


def test_no_rejection_when_price_holds_at_the_high():
    fs = FlowState()
    feed(fs, [(0, 100.0, 100, 99.0, 101.0), (1, 110.0, 200, 109.0, 111.0),
              (2, 110.0, 300, 109.0, 111.0), (3, 110.0, 400, 109.0, 111.0),
              (4, 110.0, 500, 109.0, 111.0)])
    assert fs.rejection(60)["rejected_high"] is False


# -- rule 15: confirmation ----------------------------------------------

def test_a_reading_is_not_confirmed_on_its_first_tick():
    fs = FlowState(confirm_sec=10.0)
    assert fs.confirm("x", True, now=T0) is False


def test_a_reading_is_confirmed_once_it_has_held():
    fs = FlowState(confirm_sec=10.0)
    fs.confirm("x", True, now=T0)
    assert fs.confirm("x", True, now=T0 + 5) is False
    assert fs.confirm("x", True, now=T0 + 10) is True


def test_a_reading_that_flickers_off_restarts_the_clock():
    """The regression that matters: a single noise tick must not confirm.

    An earlier design exited on a bare sign change and the underlying flow
    measure flipped sign 762 times in one day - about every 30 seconds - turning
    a 15-minute-to-2-hour design into a 1-minute median hold.
    """
    fs = FlowState(confirm_sec=10.0)
    fs.confirm("x", True, now=T0)
    fs.confirm("x", True, now=T0 + 9)
    fs.confirm("x", False, now=T0 + 9.5)          # one tick of noise
    assert fs.confirm("x", True, now=T0 + 10) is False
    assert fs.confirm("x", True, now=T0 + 19.5) is False
    assert fs.confirm("x", True, now=T0 + 20) is True


def test_held_for_reports_the_duration():
    fs = FlowState()
    fs.confirm("x", True, now=T0)
    assert fs.held_for("x", now=T0 + 7) == pytest.approx(7.0)
    assert fs.held_for("never", now=T0) == 0.0


# -- windows and memory --------------------------------------------------

def test_prints_outside_the_window_are_dropped():
    fs = FlowState(window_sec=10.0)
    feed(fs, [(0, 100.0, 0, 99.0, 101.0), (1, 101.0, 500, 99.0, 101.0)])
    feed(fs, [(100, 101.0, 600, 99.0, 101.0)])
    assert len(fs.prints) == 1


def test_memory_is_bounded_by_max_prints():
    """One of these can exist per leg, so it must not grow without limit."""
    fs = FlowState(window_sec=1e9, max_prints=50)
    vol = 0
    for i in range(500):
        vol += 10
        fs.on_tick(tick(i, 101.0, vol, 99.0, 101.0))
    assert len(fs.prints) == 50


def test_data_span_reports_what_we_actually_hold():
    fs = FlowState()
    assert fs.data_span() == 0.0
    feed(fs, [(0, 100.0, 100, 99.0, 101.0),        # baseline: no print yet
              (1, 101.0, 500, 99.0, 101.0),
              (30, 101.0, 600, 99.0, 101.0)])
    assert fs.data_span() == pytest.approx(29.0)


def test_the_first_volume_reading_is_a_baseline_not_a_trade():
    """Without a previous total there is no change to measure, so no print."""
    fs = FlowState()
    feed(fs, [(0, 100.0, 12345, 99.0, 101.0)])
    assert len(fs.prints) == 0
    feed(fs, [(1, 101.0, 12445, 99.0, 101.0)])
    assert [p.qty for p in fs.prints] == [100]


# -- snapshot ------------------------------------------------------------

def test_snapshot_carries_every_rule_for_every_window():
    fs = FlowState()
    feed(fs, [(0, 100.0, 0, 99.0, 101.0), (1, 101.0, 500, 99.0, 101.0),
              (2, 99.0, 800, 99.0, 101.0)])
    snap = fs.snapshot(windows=(60.0, 300.0))
    assert set(snap["windows"]) == {60, 300}
    for w in snap["windows"].values():
        for rule in ("aggression", "print_size", "delta", "absorption",
                     "pressure", "exhaustion", "rejection"):
            assert rule in w
    for rule in ("cum_delta", "depth", "imbalance", "liquidity",
                 "session_high", "session_low"):
        assert rule in snap


def test_session_levels_track_the_extremes():
    fs = FlowState()
    feed(fs, [(0, 100.0, 0, 99.0, 101.0), (1, 110.0, 500, 109.0, 111.0),
              (2, 95.0, 600, 94.0, 96.0)])
    assert fs.session_high == pytest.approx(110.0)
    assert fs.session_low == pytest.approx(95.0)
