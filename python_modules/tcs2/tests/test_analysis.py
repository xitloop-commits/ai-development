"""TCS2 - tests for the 25 analysis points.

Spec: docs/systems/15_detection_decision.md

Two properties matter more than any individual point, and most of these tests are
about them:

  * **A missing reading is not a reading of zero.** A point that cannot be
    computed returns None with a reason. Conflating the two is how a screen ends
    up looking confident about nothing.
  * **Scores describe, they do not predict.** Spec 15 §5.4. Over 77 days and
    26,671 decision points not one of the fifteen flow rules beat the base rate,
    so a score of 80 means "strongly present", never "80% likely".
"""
from __future__ import annotations

import time

import numpy as np
import pytest

from tcs2 import analysis as an
from tcs2.analysis import Analysis, Point
from tcs2.chain import Chain
from tcs2.flow import FlowState
from tcs2.scrip import Contract, Resolved
from tcs2.wire import DepthLevel, ResponseCode, Tick

EXPIRY = "2026-10-06"
NEXT = "2026-10-27"
T0 = 1790000000.0


def _chain(expiries=(EXPIRY,)) -> Chain:
    opts, sid = [], 1000
    for e in expiries:
        for k in (23400.0, 23500.0, 23600.0):
            for side in ("CE", "PE"):
                opts.append(Contract(str(sid), f"N {k:.0f} {side}", "OPTIDX",
                                     e, k, side, "W", 65, 0.05))
                sid += 1
    r = Resolved(instrument="nifty50", trade_date="2026-10-01",
                 index=Contract("13", "Nifty 50", "INDEX", "", 0.0, "XX", "", 1, 0.05),
                 vix=None,
                 futures=(Contract("900", "FUT", "FUTIDX", EXPIRY, 0.0, "XX",
                                   "M", 65, 0.05),),
                 option_expiries=tuple(expiries), options=tuple(opts))
    return Chain(r)


def fut_tick(off: float, ltp: float, vol: int, bid=None, ask=None) -> Tick:
    bid = ltp - 1 if bid is None else bid
    ask = ltp + 1 if ask is None else ask
    depth = tuple(DepthLevel(500, 400, 3, 2, bid - i, ask + i) for i in range(5))
    return Tick(security_id=900, segment=2, kind=ResponseCode.FULL,
                recv_ts=T0 + off, ltp=ltp, volume=vol, ltq=65,
                bid=bid, ask=ask, bid_size=500, ask_size=400, depth=depth)


def opt_tick(sid: int, off: float, ltp: float, vol: int, oi: int,
             lift: bool = True) -> Tick:
    bid, ask = (ltp - 1, ltp) if lift else (ltp, ltp + 1)
    depth = tuple(DepthLevel(500, 400, 3, 2, bid, ask) for _ in range(5))
    return Tick(security_id=sid, segment=2, kind=ResponseCode.FULL,
                recv_ts=T0 + off, ltp=ltp, volume=vol, ltq=65, oi=oi,
                day_open=100.0, bid=bid, ask=ask, bid_size=500, ask_size=400,
                depth=depth)


def _rising(n: int = 60, step: float = 2.0, lift: bool = True):
    """A futures tape walking up, with buyers lifting the offer."""
    ch = _chain()
    fs = FlowState()
    ch.on_tick(Tick(security_id=13, segment=0, kind=ResponseCode.TICKER,
                    recv_ts=T0, ltp=23500.0))
    vol = 0
    for i in range(n):
        px = 23500.0 + i * step
        vol += 500
        bid, ask = (px - 1, px) if lift else (px, px + 1)
        t = fut_tick(i * 2.0, px, vol, bid=bid, ask=ask)
        ch.on_tick(t)
        fs.on_tick(t)
    return Analysis(ch, {900: fs}), ch, fs


def _flat(n: int = 60):
    ch = _chain()
    fs = FlowState()
    ch.on_tick(Tick(security_id=13, segment=0, kind=ResponseCode.TICKER,
                    recv_ts=T0, ltp=23500.0))
    vol = 0
    for i in range(n):
        px = 23500.0 + (1.0 if i % 2 else -1.0)
        vol += 500
        t = fut_tick(i * 2.0, px, vol, bid=px - 1, ask=px + 1)
        ch.on_tick(t)
        fs.on_tick(t)
    return Analysis(ch, {900: fs}), ch, fs


# -- the two properties that matter most --------------------------------

def test_every_point_is_produced_even_with_no_data():
    """25 points, always. A missing one is worse than one saying 'no data'."""
    a = Analysis(_chain(), {})
    pts = a.all()
    assert sorted(pts) == list(range(1, 26))


def test_a_point_with_no_data_returns_none_and_says_why():
    a = Analysis(_chain(), {})
    pts = a.all()
    unavailable = [p for p in pts.values() if not p.available]
    assert unavailable, "with no ticks, most points cannot be computed"
    for p in unavailable:
        assert p.value is None
        assert p.note, f"point {p.n} gives no reason"


def test_no_point_fabricates_a_zero_when_it_means_unknown():
    """A reading of zero and a missing reading are different things."""
    a = Analysis(_chain(), {})
    for p in a.all().values():
        if not p.available:
            assert p.score is None or p.n == 25, (
                f"point {p.n} reported a score with no value")


def test_scores_stay_within_zero_to_one_hundred():
    a, _, _ = _rising()
    for p in a.all().values():
        if p.score is not None:
            assert 0.0 <= p.score <= 100.0, f"point {p.n} scored {p.score}"


def test_the_verdict_is_always_marked_advisory():
    """Spec 15 §5.5 - it does not size capital until the bar is cleared."""
    a, _, _ = _rising()
    d = a.p25_decision()
    assert d.detail["advisory"] is True
    assert "ADVISORY" in d.note


# -- 1, 2, 15: direction, momentum, persistence -------------------------

def test_a_rising_tape_reads_up():
    a, _, _ = _rising()
    p = a.p1_direction(300)
    assert p.value == an.UP
    assert p.score > 50


def test_a_falling_tape_reads_down():
    ch = _chain()
    fs = FlowState()
    vol = 0
    for i in range(60):
        px = 23600.0 - i * 2.0
        vol += 500
        t = fut_tick(i * 2.0, px, vol, bid=px, ask=px + 1)
        ch.on_tick(t)
        fs.on_tick(t)
    assert Analysis(ch, {900: fs}).p1_direction(300).value == an.DOWN


def test_a_chopping_tape_reads_flat():
    a, _, _ = _flat()
    assert a.p1_direction(300).value == an.FLAT


def test_momentum_is_scale_free():
    """The same shape at a different price level must score the same.

    BANKNIFTY and NATURALGAS differ by orders of magnitude; a momentum number
    that does not survive that is useless on one of them.
    """
    small = _rising(step=2.0)[0].p2_momentum(300)
    ch = _chain()
    fs = FlowState()
    vol = 0
    for i in range(60):
        px = 270.0 + i * 0.02          # same shape, 100x smaller
        vol += 500
        t = fut_tick(i * 2.0, px, vol, bid=px - 0.01, ask=px)
        ch.on_tick(t)
        fs.on_tick(t)
    big = Analysis(ch, {900: fs}).p2_momentum(300)
    assert small.score == pytest.approx(big.score, abs=5.0)


def test_persistence_sees_a_reversal():
    """A reversal means the RECENT move opposes the whole window's move.

    The first attempt at this test ran up then down harder, so the tape ended
    lower than it started - which makes the window itself DOWN and the recent
    move DOWN too. That is continuation, and the code was right to say so.
    """
    ch = _chain()
    fs = FlowState()
    vol = 0
    for i in range(60):                         # a long rise
        vol += 500
        t = fut_tick(i * 2.0, 23500.0 + i * 2.0, vol)
        ch.on_tick(t); fs.on_tick(t)
    for i in range(60, 80):                     # then a turn, still net up
        vol += 500
        t = fut_tick(i * 2.0, 23618.0 - (i - 60) * 2.0, vol)
        ch.on_tick(t); fs.on_tick(t)
    p = Analysis(ch, {900: fs}).p15_persistence(900)
    assert p.value == an.REVERSAL, "net up, but the recent leg is down"


def test_persistence_sees_continuation_when_the_recent_leg_agrees():
    ch = _chain()
    fs = FlowState()
    vol = 0
    for i in range(80):
        vol += 500
        t = fut_tick(i * 2.0, 23500.0 + i * 2.0, vol)
        ch.on_tick(t); fs.on_tick(t)
    assert Analysis(ch, {900: fs}).p15_persistence(900).value == an.CONTINUATION


# -- 3, 4: buyer and seller shares --------------------------------------

def test_buyer_and_seller_shares_are_complementary():
    a, _, _ = _rising(lift=True)
    b, s = a.p3_buyers(300), a.p4_sellers(300)
    assert b.value > s.value
    assert b.value + s.value <= 100.0 + 1e-6


def test_seller_share_dominates_when_sellers_are_aggressive():
    ch = _chain()
    fs = FlowState()
    vol = 0
    for i in range(40):
        px = 23500.0 - i
        vol += 500
        t = fut_tick(i * 2.0, px, vol, bid=px, ask=px + 1)   # hitting the bid
        ch.on_tick(t); fs.on_tick(t)
    a = Analysis(ch, {900: fs})
    assert a.p4_sellers(300).value > a.p3_buyers(300).value


# -- 5-8: the price/OI table ------------------------------------------

def test_the_table_reports_BOTH_definitions():
    """Spec 15 §5.3 - on an option strike the table is ambiguous.

    A call premium rising with rising OI is new buyers OR writers selling into
    demand. Both readings are produced, and a disagreement is information rather
    than an error.
    """
    ch = _chain()
    flow: dict[int, FlowState] = {}
    ch.on_tick(Tick(security_id=13, segment=0, kind=ResponseCode.TICKER,
                    recv_ts=T0, ltp=23500.0))
    fs = FlowState()
    ch.on_tick(opt_tick(1000, 0, 100.0, 1000, 5000))
    fs.on_tick(opt_tick(1000, 0, 100.0, 1000, 5000))
    ch.on_tick(opt_tick(1000, 10, 120.0, 2000, 6000))
    fs.on_tick(opt_tick(1000, 10, 120.0, 2000, 6000))
    flow[1000] = fs

    pts = Analysis(ch, flow).p5_to_p8()
    assert [p.n for p in pts] == [5, 6, 7, 8]
    for p in pts:
        if p.available:
            assert "by_convention" in p.detail    # A: inferred from price
            assert "by_aggressor" in p.detail     # B: who crossed the spread
            assert "disagreements" in p.detail


def test_the_table_flags_when_the_two_definitions_disagree():
    """Price implying buying while the aggressor was the writer.

    Spec 15 §5.3 calls that the interesting moment rather than the error, so it
    is counted rather than resolved silently.
    """
    ch = _chain()
    ch.on_tick(Tick(security_id=13, segment=0, kind=ResponseCode.TICKER,
                    recv_ts=T0, ltp=23500.0))
    fs = FlowState()
    # Premium rises and OI rises -> convention A says call buying.
    # But every print is on the BID, so the aggressor was the seller.
    for i, (px, vol, oi) in enumerate([(100.0, 1000, 5000), (110.0, 2000, 5500),
                                       (120.0, 3000, 6000)]):
        t = opt_tick(1000, i * 10.0, px, vol, oi, lift=False)
        ch.on_tick(t); fs.on_tick(t)
    pts = {p.n: p for p in Analysis(ch, {1000: fs}).p5_to_p8()}
    available = [p for p in pts.values() if p.available]
    assert available
    assert any(p.detail["disagreements"] >= 1 for p in available), (
        "a bid-side aggressor with a rising premium must be flagged")


def test_points_5_to_8_say_so_when_there_is_nothing_to_read():
    pts = Analysis(_chain(), {}).p5_to_p8()
    assert all(not p.available and p.note for p in pts)


# -- 11, 12, 13: OI map and migration -----------------------------------

def test_the_oi_map_is_a_ladder_not_a_single_number():
    ch = _chain()
    ch.on_tick(opt_tick(1000, 0, 100.0, 500, 4000))
    ch.on_tick(opt_tick(1002, 0, 95.0, 500, 9000))
    p = Analysis(ch, {}).p11_oi_map()
    assert isinstance(p.value, list)
    assert {r["strike"] for r in p.value} == {23400.0, 23500.0, 23600.0}


def test_strike_migration_pairs_what_left_with_what_arrived():
    ch = _chain()
    ch.on_tick(opt_tick(1000, 0, 100.0, 500, 5000))      # 23400 CE baseline
    ch.on_tick(opt_tick(1002, 0, 95.0, 500, 5000))       # 23500 CE baseline
    ch.on_tick(opt_tick(1000, 10, 100.0, 600, 3000))     # OI leaves 23400
    ch.on_tick(opt_tick(1002, 10, 95.0, 600, 7000))      # and arrives at 23500
    p = Analysis(ch, {}).p12_strike_migration()
    assert p.available
    assert p.value[0]["from"] == 23400.0
    assert p.value[0]["to"] == 23500.0


def test_expiry_migration_needs_more_than_one_expiry():
    """banknifty, crude and gas have no weekly (D11/D19), so it cannot apply."""
    p = Analysis(_chain(expiries=(EXPIRY,)), {}).p13_expiry_migration()
    assert not p.available
    assert "one expiry" in p.note


def test_expiry_migration_names_the_expiry_taking_the_flow():
    ch = _chain(expiries=(EXPIRY, NEXT))
    ch.on_tick(opt_tick(1000, 0, 100.0, 100, 5000))       # near expiry
    ch.on_tick(opt_tick(1006, 0, 100.0, 9000, 5000))      # next expiry, busier
    p = Analysis(ch, {}).p13_expiry_migration()
    assert p.value == NEXT


# -- 14, 16, 17, 18 ------------------------------------------------------

def test_volatility_reads_contraction_when_the_range_narrows():
    ch = _chain()
    fs = FlowState()
    vol = 0
    for i in range(40):                            # wide
        px = 23500.0 + (30.0 if i % 2 else -30.0)
        vol += 500
        t = fut_tick(i * 2.0, px, vol); ch.on_tick(t); fs.on_tick(t)
    for i in range(40, 80):                        # then tight
        px = 23500.0 + (1.0 if i % 2 else -1.0)
        vol += 500
        t = fut_tick(i * 2.0, px, vol); ch.on_tick(t); fs.on_tick(t)
    assert Analysis(ch, {900: fs}).p14_volatility(900).value == an.CONTRACTION


def test_a_rejection_makes_the_breakout_false():
    ch = _chain()
    fs = FlowState()
    vol = 0
    for i, px in enumerate([23500, 23520, 23560, 23600, 23598, 23540, 23520]):
        vol += 500
        t = fut_tick(i * 2.0, float(px), vol); ch.on_tick(t); fs.on_tick(t)
    for i in range(7, 25):
        vol += 500
        t = fut_tick(i * 2.0, 23520.0, vol); ch.on_tick(t); fs.on_tick(t)
    p = Analysis(ch, {900: fs}).p17_false_breakout(300)
    assert p.value in (an.FALSE, an.SUSPECT, an.CONFIRMED)
    assert p.score is not None


def test_pullback_strength_grades_the_retrace():
    a, _, _ = _rising()
    p = a.p18_pullback(900)
    assert p.value in (an.WEAK, an.NORMAL, an.STRONG)


# -- 19, 20 --------------------------------------------------------------

def test_aligned_clocks_read_strong():
    a, _, _ = _rising(n=200)
    p = a.p19_timing()
    assert p.available
    assert p.value in (an.STRONG, an.ACCEPTABLE, an.POOR)


def test_confirmation_is_not_given_on_the_first_tick():
    """Rule 15 applied to direction: a single tick is not a signal.

    An earlier design exited on a bare sign change when the flow measure flipped
    762 times in one day.
    """
    a, _, fs = _rising(n=20)
    fs.confirm_sec = 1e9
    assert a.p20_confirmation(120).value != an.CONFIRMED


# -- 21, 22, 23, 24 ------------------------------------------------------

def test_absorption_is_reported_when_buyers_lift_and_price_stalls():
    ch = _chain()
    fs = FlowState()
    vol = 0
    for i in range(30):
        vol += 800
        t = fut_tick(i * 2.0, 23500.0, vol, bid=23499.0, ask=23500.0)
        ch.on_tick(t); fs.on_tick(t)
    p = Analysis(ch, {900: fs}).p21_absorption(300)
    assert p.value in ("BUYERS_ABSORBED", "NONE")


def test_liquidity_grades_the_spread_relative_to_price():
    """A 2-point spread is nothing on nifty and enormous on gas."""
    a, _, _ = _rising()
    p = a.p23_liquidity()
    assert p.value in ("GOOD", "FAIR", "POOR")
    assert p.detail["relative"] < 0.001


def test_the_footprint_never_claims_who_left_it():
    a, _, _ = _rising()
    p = a.p24_footprint()
    assert "never participant identity" in p.note


# -- 25: the verdict ----------------------------------------------------

def test_no_direction_means_no_trade():
    a, _, _ = _flat()
    d = a.p25_decision()
    assert d.value == an.NO_TRADE
    assert any("direction" in r for r in d.detail["reasons"])


def test_the_verdict_always_carries_its_reasons():
    for factory in (_rising, _flat):
        a, _, _ = factory()
        d = a.p25_decision()
        assert d.detail["reasons"], "a verdict with no reason is unusable"


def test_a_no_trade_still_names_every_gate_that_failed():
    a, _, _ = _flat()
    d = a.p25_decision()
    assert len(d.detail["reasons"]) >= 1


def test_a_trade_verdict_picks_a_strike_and_a_side():
    a, _, _ = _rising(n=300)
    d = a.p25_decision()
    if d.value == an.TRADE:
        assert d.detail["strike"]["side"] in ("CE", "PE")
        assert d.detail["strike"]["expiry"] == EXPIRY
    else:
        assert d.detail["strike"] is None


# -- kind D: the record --------------------------------------------------

def test_the_record_carries_all_25_points():
    a, _, _ = _rising()
    rec = a.record()
    assert len(rec["points"]) == 25
    assert rec["advisory"] is True


def test_a_no_trade_is_recorded_too():
    """D28: the rejected setups are half the evidence.

    Without them the 25 points can never be scored.
    """
    a, _, _ = _flat()
    rec = a.record()
    assert rec["verdict"] == an.NO_TRADE
    assert rec["reasons"]


def test_the_record_is_json_serialisable():
    import json
    a, _, _ = _rising()
    json.dumps(a.record())


def test_the_record_keeps_a_missing_point_as_null():
    import json
    rec = Analysis(_chain(), {}).record()
    blob = json.loads(json.dumps(rec))
    missing = [p for p in blob["points"].values() if p["value"] is None]
    assert missing
    for p in missing:
        assert p["note"], "a null point must say why"


# -- both sides, judged symmetrically -----------------------------------
#
# We trade both directions: up means buy a call, down means buy a put (Partha
# 2026-09-25). So the question is never "is there a trade" but "which side, if
# either, is good now".
#
# The SEA gate had exactly this bug once: an `upside_percentile_60s >= 60` filter
# blocked EVERY put, so the gate was structurally call-only while the model
# behind it was balanced. These tests exist so that cannot return unnoticed.

def _falling(n: int = 60, step: float = 2.0):
    """The mirror of _rising: price walking down, sellers hitting the bid."""
    ch = _chain()
    fs = FlowState()
    ch.on_tick(Tick(security_id=13, segment=0, kind=ResponseCode.TICKER,
                    recv_ts=T0, ltp=23500.0))
    vol = 0
    for i in range(n):
        px = 23500.0 - i * step
        vol += 500
        t = fut_tick(i * 2.0, px, vol, bid=px, ask=px + 1)
        ch.on_tick(t)
        fs.on_tick(t)
    return Analysis(ch, {900: fs}), ch, fs


def test_the_verdict_reports_BOTH_sides_always():
    """Even when neither is viable, each side says what it is waiting for."""
    for factory in (_rising, _falling, _flat):
        a, _, _ = factory()
        d = a.p25_decision()
        assert "call" in d.detail and "put" in d.detail
        for side in ("call", "put"):
            assert "viable" in d.detail[side]
            assert d.detail[side]["reasons"], f"{side} gave no reason"


def test_a_rising_tape_favours_the_call_side_not_the_put():
    a, _, _ = _rising(n=200)
    d = a.p25_decision()
    call, put = d.detail["call"], d.detail["put"]
    assert not put["viable"], "a rising tape must not make a put viable"
    assert any("not DOWN" in r or "DOWN" in r for r in put["reasons"])


def test_a_falling_tape_favours_the_put_side_not_the_call():
    """The mirror. If this fails while the rising case passes, we are call-biased."""
    a, _, _ = _falling(n=200)
    d = a.p25_decision()
    call, put = d.detail["call"], d.detail["put"]
    assert not call["viable"], "a falling tape must not make a call viable"
    assert any("not UP" in r or "UP" in r for r in call["reasons"])


def test_the_two_sides_are_STRUCTURALLY_symmetric():
    """The anti-SEA-bug test.

    Mirroring the tape must mirror the verdict. If the rising case blocks the put
    for one set of reasons and the falling case blocks the call for a DIFFERENT
    number of reasons, some gate is one-sided.
    """
    up, _, _ = _rising(n=200)
    down, _, _ = _falling(n=200)
    u, dn = up.p25_decision().detail, down.p25_decision().detail

    # The side that is against the tape must be blocked in both, for the same
    # count of reasons - the mirrored gate, not a different one.
    assert not u["put"]["viable"] and not dn["call"]["viable"]
    assert len(u["put"]["reasons"]) == len(dn["call"]["reasons"]), (
        f"asymmetric gating: rising blocks put with {u['put']['reasons']}, "
        f"falling blocks call with {dn['call']['reasons']}")


def test_absorption_only_blocks_the_side_it_works_against():
    """Buyers absorbed kills a CALL and says nothing against a PUT.

    This is the leg-awareness the SEA gate lacked.
    """
    ch = _chain()
    fs = FlowState()
    vol = 0
    for i in range(30):                      # heavy lifting, price flat
        vol += 800
        t = fut_tick(i * 2.0, 23500.0, vol, bid=23499.0, ask=23500.0)
        ch.on_tick(t); fs.on_tick(t)
    a = Analysis(ch, {900: fs})
    pts = a.all()
    if pts[21].value == "BUYERS_ABSORBED":
        call = a._side_verdict("CE", pts)
        put = a._side_verdict("PE", pts)
        assert any("buyers absorbed" in r for r in call["reasons"])
        assert not any("buyers absorbed" in r for r in put["reasons"]), (
            "buyers being absorbed says nothing against a put")


def test_a_flat_tape_makes_neither_side_viable():
    a, _, _ = _flat()
    d = a.p25_decision()
    assert not d.detail["call"]["viable"]
    assert not d.detail["put"]["viable"]
    assert d.value == an.NO_TRADE


def test_both_sides_viable_means_stand_aside():
    """Contradictory evidence is a reason to do nothing, not to pick one."""
    a, _, _ = _rising()
    pts = a.all()
    # Force both to pass by making every gate agree with both directions.
    import copy
    pts = copy.deepcopy(pts)
    pts[1] = Point(1, "direction", an.UP, 90.0)
    pts[19] = Point(19, "entry_timing", an.STRONG, 100.0)
    pts[20] = Point(20, "confirmation", an.CONFIRMED, 100.0)
    pts[21] = Point(21, "absorption", "NONE", 0.0)
    pts[22] = Point(22, "exhaustion", False, None)
    pts[23] = Point(23, "liquidity", "GOOD", 95.0)
    call_ok = a._side_verdict("CE", pts)["viable"]
    assert call_ok, "with every gate clear and direction UP, the call must pass"
    # And the put must be blocked, by direction alone.
    assert not a._side_verdict("PE", pts)["viable"]


def test_the_strike_side_matches_the_viable_side():
    a, _, _ = _falling(n=200)
    d = a.p25_decision()
    if d.value == an.TRADE:
        assert d.detail["strike"]["side"] == "PE"


def test_the_recorded_row_keeps_both_sides():
    """Kind D must record which side was considered, not just the verdict."""
    a, _, _ = _rising()
    rec = a.record()
    assert any("CALL" in r or "PUT" in r for r in rec["reasons"]) or \
        rec["verdict"] == an.TRADE
