"""Order-flow / tape-reading tests — Partha's 15-point spec.

Each test names the rule it covers. The ones that matter most are the negative
tests: rules 8 and 12 say explicitly that delta and imbalance are NOT signals on
their own, and rule 7 says pressure without price movement needs more
observation. Those are asserted, not assumed.
"""
from __future__ import annotations

import pytest

from claude_cohort.flow import BUY, PASSIVE, SELL, FlowState, classify


def tick(ts, ltp, bid, ask, volume, depth=None):
    return {
        "recv_ts": ts,
        "ltp": ltp,
        "bid": bid,
        "ask": ask,
        "volume": volume,
        "depth": depth
        or [
            {"bid_price": bid, "bid_qty": 100, "ask_price": ask, "ask_qty": 100,
             "bid_orders": 1, "ask_orders": 1}
        ],
    }


def feed(fs, rows):
    for r in rows:
        fs.on_tick(r)
    return fs


# ── rule 1: trade side ───────────────────────────────────────────────────


def test_print_at_ask_is_aggressive_buy():
    assert classify(100.5, 100.0, 100.5) == BUY


def test_print_at_bid_is_aggressive_sell():
    assert classify(100.0, 100.0, 100.5) == SELL


def test_print_inside_the_spread_is_passive():
    assert classify(100.25, 100.0, 100.5) == PASSIVE


def test_no_book_is_passive_not_a_trade():
    """A pre-depth packet has no bid/ask. Calling that a buy would invent flow."""
    assert classify(100.0, 0.0, 0.0) == PASSIVE


def test_classification_matches_tfa():
    """Must agree with TFA's underlying_trade_direction or the live row and this
    module would disagree about the same tick."""
    from tick_feature_agent.features.ofi import _trade_direction

    for ltp, bid, ask in [(100.5, 100.0, 100.5), (100.0, 100.0, 100.5),
                          (100.25, 100.0, 100.5), (100.0, 0.0, 0.0),
                          (99.0, 100.0, 100.5), (101.0, 100.0, 100.5)]:
        assert classify(ltp, bid, ask) == _trade_direction(ltp, bid, ask), (ltp, bid, ask)


# ── rules 2,3: aggressive volume ─────────────────────────────────────────


def test_volume_is_attributed_to_the_aggressive_side():
    fs = feed(FlowState(), [
        tick(1.0, 100.5, 100.0, 100.5, 1000),
        tick(2.0, 100.5, 100.0, 100.5, 1500),   # +500 at the ask -> buying
        tick(3.0, 100.0, 100.0, 100.5, 1700),   # +200 at the bid -> selling
    ])
    p = fs.pressure(60.0)
    assert p["buy_qty"] == 500
    assert p["sell_qty"] == 200


def test_first_tick_seeds_volume_without_inventing_a_trade():
    """Cumulative volume has no predecessor on the first packet; counting all of
    it would fabricate a huge opening trade."""
    fs = feed(FlowState(), [tick(1.0, 100.5, 100.0, 100.5, 50000)])
    assert fs.pressure(60.0)["n"] == 0


def test_volume_going_backwards_is_ignored():
    fs = feed(FlowState(), [
        tick(1.0, 100.5, 100.0, 100.5, 1000),
        tick(2.0, 100.5, 100.0, 100.5, 900),    # feed glitch / reset
    ])
    assert fs.pressure(60.0)["n"] == 0


# ── rule 8: delta ────────────────────────────────────────────────────────


def test_delta_is_buy_minus_sell():
    fs = feed(FlowState(), [
        tick(1.0, 100.5, 100.0, 100.5, 1000),
        tick(2.0, 100.5, 100.0, 100.5, 1800),   # +800 buy
        tick(3.0, 100.0, 100.0, 100.5, 2100),   # +300 sell
    ])
    assert fs.pressure(60.0)["delta"] == 500


def test_delta_alone_returns_no_verdict():
    """Rule 8: 'Delta is an observation, not an entry signal by itself.'"""
    fs = feed(FlowState(), [
        tick(1.0, 100.5, 100.0, 100.5, 1000),
        tick(2.0, 100.5, 100.0, 100.5, 9000),
    ])
    p = fs.pressure(60.0)
    assert "delta" in p
    assert not any(k in p for k in ("signal", "entry", "direction", "verdict"))


# ── rules 4,7: price response ────────────────────────────────────────────


def test_buying_with_price_rising_is_a_confirmed_response():
    fs = feed(FlowState(), [
        tick(1.0, 100.5, 100.0, 100.5, 1000),
        tick(2.0, 101.5, 101.0, 101.5, 2000),
        tick(3.0, 102.5, 102.0, 102.5, 3000),
    ])
    assert fs.pressure(60.0)["price_responded"] is True


def test_buying_without_price_moving_is_not_a_response():
    """Rule 7: pressure without price movement needs further observation."""
    fs = feed(FlowState(), [
        tick(1.0, 100.5, 100.0, 100.5, 1000),
        tick(2.0, 100.5, 100.0, 100.5, 9000),
        tick(3.0, 100.5, 100.0, 100.5, 18000),
    ])
    assert fs.pressure(60.0)["price_responded"] is False


# ── rule 9: cumulative delta ─────────────────────────────────────────────


def test_cumulative_delta_accumulates_across_the_session():
    fs = feed(FlowState(), [
        tick(1.0, 100.5, 100.0, 100.5, 1000),
        tick(2.0, 100.5, 100.0, 100.5, 2000),   # +1000 buy
        tick(3.0, 100.5, 100.0, 100.5, 3000),   # +1000 buy
    ])
    assert fs.cum_delta == 2000


def test_cumulative_delta_flags_divergence_from_price():
    """Delta building while price refuses to follow — the absorption tell."""
    fs = feed(FlowState(), [
        tick(1.0, 100.5, 100.0, 100.5, 1000),
        tick(2.0, 100.5, 100.0, 100.5, 5000),
        tick(3.0, 99.5, 99.0, 99.5, 9000),     # heavy buying, price LOWER
    ])
    cd = fs.cumulative_delta(300.0)
    assert cd["divergence"] is True
    assert cd["confirms"] is False


# ── rules 5,6: absorption ────────────────────────────────────────────────


def test_buyer_absorption_when_selling_does_not_push_price_down():
    # a normal-sized session first, so "significant quantity" has a baseline
    rows = [tick(1.0, 100.0, 100.0, 100.5, 1000)]
    v = 1000
    for i in range(2, 32):
        v += 100
        rows.append(tick(float(i), 100.0, 100.0, 100.5, v))
    # then a heavy burst of selling at the bid, price refusing to drop
    for i in range(200, 228):
        v += 900
        rows.append(tick(float(i), 100.0, 100.0, 100.5, v))
    a = feed(FlowState(), rows).absorption(sec=120.0, now=227.0)
    assert a is not None and a["type"] == "buyer_absorption"


def test_no_absorption_when_price_follows_the_selling():
    rows = [tick(1.0, 100.0, 100.0, 100.5, 1000)]
    v, px = 1000, 100.0
    for i in range(2, 30):
        v += 900
        px -= 1.0                                # price IS going down
        rows.append(tick(float(i), px, px, px + 0.5, v))
    assert feed(FlowState(), rows).absorption(sec=120.0) is None


def test_no_absorption_on_trivial_size():
    """Absorption needs size. A trickle stalling is just a quiet market."""
    rows = [tick(1.0, 100.0, 100.0, 100.5, 1000)]
    v = 1000
    for i in range(2, 30):
        v += 1
        rows.append(tick(float(i), 100.0, 100.0, 100.5, v))
    assert feed(FlowState(), rows).absorption(sec=120.0, min_size_mult=1.5) is None


# ── rule 10: exhaustion ──────────────────────────────────────────────────


def test_seller_exhaustion_when_selling_fades_and_price_stops_falling():
    rows = [tick(1.0, 100.0, 100.0, 100.5, 1000)]
    v = 1000
    for i in range(2, 20):                       # heavy selling early
        v += 1000
        rows.append(tick(float(i), 100.0, 100.0, 100.5, v))
    for i in range(20, 40):                      # fading late, price flat
        v += 50
        rows.append(tick(float(i), 100.0, 100.0, 100.5, v))
    e = feed(FlowState(), rows).exhaustion(sec=300.0)
    assert e is not None and e["type"] == "seller_exhaustion"


def test_no_exhaustion_when_aggression_is_steady():
    rows = [tick(1.0, 100.0, 100.0, 100.5, 1000)]
    v = 1000
    for i in range(2, 40):
        v += 500
        rows.append(tick(float(i), 100.0, 100.0, 100.5, v))
    assert feed(FlowState(), rows).exhaustion(sec=300.0) is None


# ── rules 11,12: depth ───────────────────────────────────────────────────


def test_depth_totals_both_sides():
    d = [
        {"bid_price": 100.0, "bid_qty": 500, "ask_price": 100.5, "ask_qty": 200},
        {"bid_price": 99.5, "bid_qty": 300, "ask_price": 101.0, "ask_qty": 100},
    ]
    fs = feed(FlowState(), [tick(1.0, 100.5, 100.0, 100.5, 1000, depth=d)])
    dep = fs.depth_imbalance()
    assert dep["bid_qty"] == 800 and dep["ask_qty"] == 300
    assert dep["imbalance"] == pytest.approx(0.4545, abs=1e-3)


def test_depth_imbalance_returns_no_direction():
    """Rule 12: 'Do not treat imbalance alone as a directional signal.'"""
    fs = feed(FlowState(), [tick(1.0, 100.5, 100.0, 100.5, 1000)])
    dep = fs.depth_imbalance()
    assert not any(k in dep for k in ("signal", "direction", "bias", "verdict"))


# ── rule 13: liquidity removal ───────────────────────────────────────────


def test_liquidity_removal_detected_at_a_price_level():
    d1 = [{"bid_price": 100.0, "bid_qty": 1000, "ask_price": 100.5, "ask_qty": 500}]
    d2 = [{"bid_price": 100.0, "bid_qty": 200, "ask_price": 100.5, "ask_qty": 500}]
    fs = feed(FlowState(), [
        tick(1.0, 100.5, 100.0, 100.5, 1000, depth=d1),
        tick(2.0, 100.5, 100.0, 100.5, 1100, depth=d2),
    ])
    assert fs.liquidity_removed(60.0)["bid_removed"] == 800


def test_level_scrolling_out_of_view_is_not_removal():
    """A price that leaves the top 5 has not had its size pulled — counting it
    would report removals every time the book shifts one tick."""
    d1 = [{"bid_price": 100.0, "bid_qty": 1000, "ask_price": 100.5, "ask_qty": 500}]
    d2 = [{"bid_price": 99.0, "bid_qty": 700, "ask_price": 99.5, "ask_qty": 500}]
    fs = feed(FlowState(), [
        tick(1.0, 100.5, 100.0, 100.5, 1000, depth=d1),
        tick(2.0, 99.5, 99.0, 99.5, 1100, depth=d2),
    ])
    assert fs.liquidity_removed(60.0)["n"] == 0


# ── rule 14: rejection ───────────────────────────────────────────────────


def test_rejection_of_an_upside_break_is_confirmed_by_selling():
    rows = [tick(1.0, 100.0, 100.0, 100.5, 1000)]
    v = 1000
    # pokes above 100.5, then comes back — and the return prints are at the BID
    # (ltp == bid), which is what makes them aggressive sells.
    for i, px in enumerate([101.0, 102.0, 101.0, 100.0, 99.0], start=2):
        v += 500
        rows.append(tick(float(i), px, px, px + 0.5, v))
    r = feed(FlowState(), rows).rejection(level=100.5, sec=300.0)
    assert r is not None and r["direction"] == "down" and r["confirmed"] is True


def test_no_rejection_while_price_is_still_above_the_level():
    rows = [tick(1.0, 100.0, 99.5, 100.0, 1000)]
    v = 1000
    for i, px in enumerate([101.0, 102.0, 103.0], start=2):
        v += 500
        rows.append(tick(float(i), px, px - 0.5, px, v))
    assert feed(FlowState(), rows).rejection(level=100.5, sec=300.0) is None


# ── rule 15: combined read ───────────────────────────────────────────────


def test_snapshot_reports_every_window():
    fs = feed(FlowState(), [
        tick(1.0, 100.5, 100.0, 100.5, 1000),
        tick(2.0, 100.5, 100.0, 100.5, 2000),
    ])
    s = fs.snapshot()
    for sec in (60, 120, 300):
        assert f"pressure_{sec}s" in s
        assert f"cumdelta_{sec}s" in s
        assert f"liq_removed_{sec}s" in s
    for k in ("cum_delta", "depth", "absorption", "exhaustion"):
        assert k in s


def test_everything_is_causal():
    """No measure may change when later ticks arrive — a snapshot taken at t
    must stay valid. This is the look-ahead guard for the flow layer."""
    rows = [tick(float(i), 100.0 + i * 0.1, 100.0 + i * 0.1, 100.5 + i * 0.1, 1000 + i * 100)
            for i in range(1, 40)]
    early = feed(FlowState(), rows[:20])
    snap_at_20 = early.pressure(60.0, now=rows[19]["recv_ts"])
    later = feed(FlowState(), rows)
    snap_replayed = later.pressure(60.0, now=rows[19]["recv_ts"])
    assert snap_at_20["delta"] == snap_replayed["delta"]
    assert snap_at_20["buy_qty"] == snap_replayed["buy_qty"]
