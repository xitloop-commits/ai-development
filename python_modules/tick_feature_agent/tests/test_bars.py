"""Tests for features/bars.py — multi-timeframe OHLCV aggregator."""

from __future__ import annotations

import pytest

from tick_feature_agent.features.bars import Bar, BarAggregator


# ── Construction ──────────────────────────────────────────────────────────


def test_default_timeframes_are_1m_5m_15m():
    agg = BarAggregator()
    assert agg.timeframes == (60, 300, 900)


def test_invalid_timeframe_raises():
    with pytest.raises(ValueError):
        BarAggregator(timeframes_sec=(60, -300))
    with pytest.raises(ValueError):
        BarAggregator(timeframes_sec=())
    with pytest.raises(ValueError):
        BarAggregator(timeframes_sec=(60,), max_bars_per_tf=0)


# ── Single-timeframe behaviour ────────────────────────────────────────────


def test_first_tick_opens_bar_no_finalisation_yet():
    agg = BarAggregator(timeframes_sec=(60,))
    agg.add_tick(ts=1_000_000.0, ltp=100.0, tick_volume=10)
    assert agg.get_recent_bars(60) == []
    cur = agg.current_bar(60)
    assert cur is not None
    assert cur.open == 100.0
    assert cur.tick_count == 1


def test_subsequent_tick_in_same_bar_updates_ohlcv():
    # 1_500_000 is on a 1-minute boundary (1_500_000 = 25000*60).
    base = 1_500_000
    agg = BarAggregator(timeframes_sec=(60,))
    agg.add_tick(ts=base, ltp=100.0, tick_volume=10)
    agg.add_tick(ts=base + 10, ltp=105.0, tick_volume=5)   # high
    agg.add_tick(ts=base + 20, ltp=98.0, tick_volume=8)    # low
    agg.add_tick(ts=base + 50, ltp=102.0, tick_volume=7)   # close
    cur = agg.current_bar(60)
    assert cur is not None
    assert cur.open == 100.0
    assert cur.high == 105.0
    assert cur.low == 98.0
    assert cur.close == 102.0
    assert cur.volume == 30.0
    assert cur.tick_count == 4


def test_bar_boundary_finalises_previous_and_opens_new():
    base = 1_500_000  # minute-aligned
    agg = BarAggregator(timeframes_sec=(60,))
    agg.add_tick(ts=base, ltp=100.0, tick_volume=10)        # bar A
    agg.add_tick(ts=base + 59, ltp=105.0, tick_volume=5)    # bar A still
    agg.add_tick(ts=base + 60, ltp=106.0, tick_volume=3)    # bar B opens
    bars = agg.get_recent_bars(60)
    assert len(bars) == 1
    a = bars[0]
    assert a.open == 100.0
    assert a.high == 105.0
    assert a.low == 100.0
    assert a.close == 105.0
    assert a.volume == 15.0
    assert a.tick_count == 2
    # In-progress bar B
    cur = agg.current_bar(60)
    assert cur is not None
    assert cur.open == 106.0
    assert cur.tick_count == 1


def test_multiple_bar_boundaries_finalise_in_order():
    base = 1_500_000  # minute-aligned
    agg = BarAggregator(timeframes_sec=(60,))
    for i in range(5):
        agg.add_tick(ts=base + i * 60, ltp=100.0 + i, tick_volume=1)
    # 4 finalised + 1 open
    bars = agg.get_recent_bars(60)
    assert len(bars) == 4
    assert [b.open for b in bars] == [100.0, 101.0, 102.0, 103.0]
    assert agg.current_bar(60).open == 104.0


# ── Multi-timeframe behaviour ─────────────────────────────────────────────


def test_5m_and_15m_aggregate_correctly():
    agg = BarAggregator(timeframes_sec=(60, 300, 900))
    # First 6 minutes worth of ticks, one per minute, so 5m + 15m bars
    # accumulate the entire 5-min window before finalising.
    base = 1_000_000 - (1_000_000 % 900)  # align to 15m boundary
    prices = [100, 102, 101, 103, 105, 107]
    for i, p in enumerate(prices):
        agg.add_tick(ts=base + i * 60, ltp=p, tick_volume=1)
    # 5m bar A covered minutes 0..4 → should be finalised after the 6th tick.
    bars_5m = agg.get_recent_bars(300)
    assert len(bars_5m) == 1
    a5 = bars_5m[0]
    assert a5.open == 100.0
    assert a5.high == 105.0
    assert a5.low == 100.0
    assert a5.close == 105.0
    assert a5.tick_count == 5
    # 15m bar still in progress.
    assert agg.get_recent_bars(900) == []
    cur_15m = agg.current_bar(900)
    assert cur_15m is not None
    assert cur_15m.tick_count == 6


def test_independent_finalisation_across_timeframes():
    """1m bars finalise much more often than 15m — they don't interfere."""
    agg = BarAggregator(timeframes_sec=(60, 900))
    base = 1_000_000 - (1_000_000 % 900)
    for i in range(10):
        agg.add_tick(ts=base + i * 60, ltp=100.0 + i, tick_volume=1)
    assert len(agg.get_recent_bars(60)) == 9
    assert agg.get_recent_bars(900) == []


# ── History limit ─────────────────────────────────────────────────────────


def test_history_trims_to_max_bars_per_tf():
    base = 1_500_000  # minute-aligned
    agg = BarAggregator(timeframes_sec=(60,), max_bars_per_tf=3)
    for i in range(10):
        agg.add_tick(ts=base + i * 60, ltp=100.0 + i, tick_volume=1)
    bars = agg.get_recent_bars(60)
    assert len(bars) == 3
    # Should be the last 3 finalised bars (indices 6,7,8 since 9 is in-progress).
    assert [b.open for b in bars] == [106.0, 107.0, 108.0]


def test_get_recent_bars_n_limits_tail():
    base = 1_500_000  # minute-aligned
    agg = BarAggregator(timeframes_sec=(60,), max_bars_per_tf=20)
    for i in range(5):
        agg.add_tick(ts=base + i * 60, ltp=100.0 + i, tick_volume=1)
    # 4 finalised bars exist.
    assert len(agg.get_recent_bars(60, n=2)) == 2
    assert agg.get_recent_bars(60, n=2)[-1].open == 103.0
    # n larger than available → all
    assert len(agg.get_recent_bars(60, n=99)) == 4


# ── reset ─────────────────────────────────────────────────────────────────


def test_reset_clears_history_and_open():
    base = 1_500_000  # minute-aligned
    agg = BarAggregator(timeframes_sec=(60,))
    for i in range(5):
        agg.add_tick(ts=base + i * 60, ltp=100.0 + i, tick_volume=1)
    assert agg.get_recent_bars(60)
    agg.reset()
    assert agg.get_recent_bars(60) == []
    assert agg.current_bar(60) is None


# ── Invalid input handling ────────────────────────────────────────────────


def test_nan_ts_dropped():
    agg = BarAggregator(timeframes_sec=(60,))
    agg.add_tick(ts=float("nan"), ltp=100.0)
    assert agg.current_bar(60) is None


def test_nan_or_zero_ltp_dropped():
    agg = BarAggregator(timeframes_sec=(60,))
    agg.add_tick(ts=1_000_000.0, ltp=float("nan"))
    agg.add_tick(ts=1_000_000.0, ltp=0.0)
    agg.add_tick(ts=1_000_000.0, ltp=-5.0)
    assert agg.current_bar(60) is None


def test_string_inputs_ignored():
    agg = BarAggregator(timeframes_sec=(60,))
    agg.add_tick(ts="not-a-ts", ltp=100.0)  # type: ignore[arg-type]
    agg.add_tick(ts=1_000_000.0, ltp="oops")  # type: ignore[arg-type]
    assert agg.current_bar(60) is None


def test_negative_tick_volume_clamps_to_zero():
    agg = BarAggregator(timeframes_sec=(60,))
    agg.add_tick(ts=1_000_000.0, ltp=100.0, tick_volume=-5)
    cur = agg.current_bar(60)
    assert cur is not None
    assert cur.volume == 0.0


def test_backwards_tick_does_not_corrupt_state():
    """A tick whose ts falls into an earlier bar window is dropped, not applied."""
    agg = BarAggregator(timeframes_sec=(60,))
    agg.add_tick(ts=1_000_120.0, ltp=100.0, tick_volume=1)  # opens bar at 1_000_120
    agg.add_tick(ts=1_000_000.0, ltp=999.0, tick_volume=999)  # earlier — dropped
    cur = agg.current_bar(60)
    assert cur is not None
    assert cur.open == 100.0
    assert cur.high == 100.0
    assert cur.volume == 1.0


# ── Bar dataclass ─────────────────────────────────────────────────────────


def test_bar_is_frozen():
    b = Bar(start_ts=0.0, open=1.0, high=2.0, low=0.5, close=1.5, volume=10.0, tick_count=3)
    with pytest.raises(Exception):
        b.open = 99.0  # type: ignore[misc]
