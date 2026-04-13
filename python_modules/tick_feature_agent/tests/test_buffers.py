"""
test_buffers.py — Unit tests for tick_buffer.py and option_buffer.py.

Run: python -m pytest python_modules/tick_feature_agent/tests/test_buffers.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pytest
from tick_feature_agent.buffers.tick_buffer import CircularBuffer, UnderlyingTick
from tick_feature_agent.buffers.option_buffer import OptionBufferStore, OptionTick


# ── Helpers ───────────────────────────────────────────────────────────────────

def _utick(ts: float, ltp: float = 100.0) -> UnderlyingTick:
    return UnderlyingTick(timestamp=ts, ltp=ltp, bid=ltp - 0.05, ask=ltp + 0.05, volume=1000)


def _otick(ts: float, ltp: float = 50.0) -> OptionTick:
    return OptionTick(timestamp=ts, ltp=ltp, bid=ltp - 0.1, ask=ltp + 0.1,
                      bid_size=100, ask_size=120, volume=500)


# ══════════════════════════════════════════════════════════════════════════════
# CircularBuffer
# ══════════════════════════════════════════════════════════════════════════════

class TestCircularBufferInit:
    def test_starts_empty(self):
        buf = CircularBuffer(maxlen=50)
        assert len(buf) == 0

    def test_maxlen_stored(self):
        buf = CircularBuffer(maxlen=10)
        assert buf.maxlen == 10

    def test_zero_maxlen_raises(self):
        with pytest.raises(ValueError):
            CircularBuffer(maxlen=0)

    def test_negative_maxlen_raises(self):
        with pytest.raises(ValueError):
            CircularBuffer(maxlen=-1)


class TestCircularBufferPush:
    def test_push_increments_length(self):
        buf = CircularBuffer(maxlen=5)
        buf.push(_utick(1.0))
        assert len(buf) == 1

    def test_push_to_capacity(self):
        buf = CircularBuffer(maxlen=3)
        for i in range(3):
            buf.push(_utick(float(i)))
        assert len(buf) == 3

    def test_overflow_drops_oldest(self):
        buf = CircularBuffer(maxlen=3)
        for i in range(5):
            buf.push(_utick(float(i), ltp=float(i * 10)))
        # Should hold last 3: ts=2.0, 3.0, 4.0
        assert len(buf) == 3
        ticks = buf.get_last(3)
        assert [t.timestamp for t in ticks] == [2.0, 3.0, 4.0]

    def test_overflow_length_stays_at_maxlen(self):
        buf = CircularBuffer(maxlen=5)
        for i in range(20):
            buf.push(_utick(float(i)))
        assert len(buf) == 5


class TestCircularBufferGetLast:
    def setup_method(self):
        self.buf = CircularBuffer(maxlen=50)
        for i in range(10):
            self.buf.push(_utick(float(i), ltp=float(i * 10)))

    def test_get_last_exact(self):
        result = self.buf.get_last(5)
        assert len(result) == 5
        assert [t.timestamp for t in result] == [5.0, 6.0, 7.0, 8.0, 9.0]

    def test_get_last_more_than_available(self):
        result = self.buf.get_last(100)
        assert len(result) == 10

    def test_get_last_1(self):
        result = self.buf.get_last(1)
        assert len(result) == 1
        assert result[0].timestamp == 9.0

    def test_get_last_0_returns_empty(self):
        result = self.buf.get_last(0)
        assert result == []

    def test_get_last_preserves_order_oldest_first(self):
        result = self.buf.get_last(3)
        assert result[0].timestamp < result[1].timestamp < result[2].timestamp

    def test_get_last_on_empty_buffer(self):
        buf = CircularBuffer(maxlen=10)
        assert buf.get_last(5) == []


class TestCircularBufferLatestOldest:
    def test_latest_returns_most_recent(self):
        buf = CircularBuffer(maxlen=10)
        buf.push(_utick(1.0, ltp=100.0))
        buf.push(_utick(2.0, ltp=200.0))
        assert buf.latest().timestamp == 2.0
        assert buf.latest().ltp == 200.0

    def test_oldest_returns_first_in_buffer(self):
        buf = CircularBuffer(maxlen=5)
        for i in range(7):
            buf.push(_utick(float(i)))
        # After overflow maxlen=5, oldest should be ts=2.0
        assert buf.oldest().timestamp == 2.0

    def test_latest_empty_returns_none(self):
        buf = CircularBuffer(maxlen=10)
        assert buf.latest() is None

    def test_oldest_empty_returns_none(self):
        buf = CircularBuffer(maxlen=10)
        assert buf.oldest() is None


class TestCircularBufferIsFull:
    def test_is_full_default_checks_maxlen(self):
        buf = CircularBuffer(maxlen=3)
        assert not buf.is_full()
        buf.push(_utick(1.0))
        buf.push(_utick(2.0))
        assert not buf.is_full()
        buf.push(_utick(3.0))
        assert buf.is_full()

    def test_is_full_with_n(self):
        buf = CircularBuffer(maxlen=50)
        for i in range(5):
            buf.push(_utick(float(i)))
        assert buf.is_full(5)
        assert not buf.is_full(6)
        assert buf.is_full(3)


class TestCircularBufferClear:
    def test_clear_resets_length(self):
        buf = CircularBuffer(maxlen=10)
        for i in range(5):
            buf.push(_utick(float(i)))
        buf.clear()
        assert len(buf) == 0

    def test_clear_makes_latest_none(self):
        buf = CircularBuffer(maxlen=10)
        buf.push(_utick(1.0))
        buf.clear()
        assert buf.latest() is None

    def test_push_after_clear(self):
        buf = CircularBuffer(maxlen=10)
        for i in range(5):
            buf.push(_utick(float(i)))
        buf.clear()
        buf.push(_utick(99.0, ltp=555.0))
        assert len(buf) == 1
        assert buf.latest().ltp == 555.0


# ══════════════════════════════════════════════════════════════════════════════
# OptionBufferStore
# ══════════════════════════════════════════════════════════════════════════════

class TestOptionBufferStoreInit:
    def test_default_maxlen(self):
        store = OptionBufferStore()
        assert store.maxlen == 10

    def test_custom_maxlen(self):
        store = OptionBufferStore(maxlen=5)
        assert store.maxlen == 5

    def test_zero_maxlen_raises(self):
        with pytest.raises(ValueError):
            OptionBufferStore(maxlen=0)

    def test_starts_empty(self):
        store = OptionBufferStore()
        assert store.registered_count() == 0


class TestOptionBufferStoreRegister:
    def test_register_strikes_creates_ce_and_pe(self):
        store = OptionBufferStore()
        store.register_strikes([21800, 21850])
        assert store.registered_count() == 4   # 2 strikes × 2 types

    def test_register_strikes_custom_opt_types(self):
        store = OptionBufferStore()
        store.register_strikes([21800], opt_types=["CE"])
        assert store.registered_count() == 1

    def test_register_same_strike_twice_no_duplicate(self):
        store = OptionBufferStore()
        store.register_strikes([21800])
        store.register_strikes([21800])
        assert store.registered_count() == 2   # CE + PE, not 4

    def test_registered_strikes_sorted(self):
        store = OptionBufferStore()
        store.register_strikes([21900, 21800, 22000])
        assert store.registered_strikes() == [21800, 21900, 22000]

    def test_register_single_strike(self):
        store = OptionBufferStore()
        store.register_strike(21800, "CE")
        assert store.registered_count() == 1


class TestOptionBufferStorePush:
    def test_push_increments_buffer(self):
        store = OptionBufferStore()
        store.register_strikes([21800])
        store.push(21800, "CE", _otick(1.0))
        assert len(store.get_last(21800, "CE", n=10)) == 1

    def test_push_lazy_creates_buffer(self):
        store = OptionBufferStore()
        store.push(21800, "CE", _otick(1.0))   # no prior register_strikes
        assert store.tick_available(21800, "CE")

    def test_push_overflow_wraps(self):
        store = OptionBufferStore(maxlen=3)
        store.register_strikes([21800])
        for i in range(5):
            store.push(21800, "CE", _otick(float(i), ltp=float(i * 10)))
        result = store.get_last(21800, "CE", n=10)
        assert len(result) == 3
        assert [t.timestamp for t in result] == [2.0, 3.0, 4.0]

    def test_push_does_not_affect_other_strike(self):
        store = OptionBufferStore()
        store.register_strikes([21800, 21850])
        store.push(21800, "CE", _otick(1.0))
        assert not store.tick_available(21850, "CE")


class TestOptionBufferStoreTickAvailable:
    def test_false_before_any_tick(self):
        store = OptionBufferStore()
        store.register_strikes([21800])
        assert not store.tick_available(21800, "CE")
        assert not store.tick_available(21800, "PE")

    def test_true_after_first_tick(self):
        store = OptionBufferStore()
        store.register_strikes([21800])
        store.push(21800, "CE", _otick(1.0))
        assert store.tick_available(21800, "CE")

    def test_false_for_unregistered_strike(self):
        store = OptionBufferStore()
        assert not store.tick_available(99999, "CE")

    def test_latches_true_after_first_tick(self):
        store = OptionBufferStore()
        store.register_strikes([21800])
        store.push(21800, "CE", _otick(1.0))
        # Even if we check multiple times it stays True
        assert store.tick_available(21800, "CE")
        assert store.tick_available(21800, "CE")

    def test_ce_and_pe_independent(self):
        store = OptionBufferStore()
        store.register_strikes([21800])
        store.push(21800, "CE", _otick(1.0))
        assert store.tick_available(21800, "CE")
        assert not store.tick_available(21800, "PE")


class TestOptionBufferStoreLastTickTime:
    def test_none_before_any_tick(self):
        store = OptionBufferStore()
        store.register_strikes([21800])
        assert store.last_tick_time(21800, "CE") is None

    def test_returns_timestamp_of_latest(self):
        store = OptionBufferStore()
        store.register_strikes([21800])
        store.push(21800, "CE", _otick(10.0))
        store.push(21800, "CE", _otick(20.0))
        assert store.last_tick_time(21800, "CE") == 20.0

    def test_none_for_unregistered(self):
        store = OptionBufferStore()
        assert store.last_tick_time(99999, "CE") is None


class TestOptionBufferStoreStrikesWithTicks:
    def test_empty_when_no_ticks(self):
        store = OptionBufferStore()
        store.register_strikes([21800, 21850, 21900])
        assert store.strikes_with_ticks() == []

    def test_includes_strike_after_ce_tick(self):
        store = OptionBufferStore()
        store.register_strikes([21800, 21850])
        store.push(21850, "CE", _otick(1.0))
        assert store.strikes_with_ticks() == [21850]

    def test_includes_strike_after_pe_tick(self):
        store = OptionBufferStore()
        store.register_strikes([21800, 21850])
        store.push(21800, "PE", _otick(1.0))
        assert store.strikes_with_ticks() == [21800]

    def test_sorted_output(self):
        store = OptionBufferStore()
        store.register_strikes([21900, 21800, 21850])
        store.push(21900, "CE", _otick(1.0))
        store.push(21800, "PE", _otick(1.0))
        assert store.strikes_with_ticks() == [21800, 21900]


class TestOptionBufferStoreClearAll:
    def test_clear_all_empties_data(self):
        store = OptionBufferStore()
        store.register_strikes([21800, 21850])
        store.push(21800, "CE", _otick(1.0))
        store.push(21850, "PE", _otick(2.0))
        store.clear_all()
        assert store.get_last(21800, "CE", n=10) == []
        assert store.get_last(21850, "PE", n=10) == []

    def test_clear_all_resets_tick_available(self):
        store = OptionBufferStore()
        store.register_strikes([21800])
        store.push(21800, "CE", _otick(1.0))
        assert store.tick_available(21800, "CE")
        store.clear_all()
        assert not store.tick_available(21800, "CE")

    def test_clear_all_keeps_registered_strikes(self):
        store = OptionBufferStore()
        store.register_strikes([21800, 21850])
        store.clear_all()
        assert store.registered_count() == 4   # CE+PE for each strike still registered

    def test_push_after_clear_all(self):
        store = OptionBufferStore()
        store.register_strikes([21800])
        store.push(21800, "CE", _otick(1.0))
        store.clear_all()
        store.push(21800, "CE", _otick(99.0, ltp=200.0))
        assert store.tick_available(21800, "CE")
        assert store.latest(21800, "CE").ltp == 200.0


class TestOptionBufferStoreClearStrike:
    def test_clear_single_strike(self):
        store = OptionBufferStore()
        store.register_strikes([21800])
        store.push(21800, "CE", _otick(1.0))
        store.push(21800, "PE", _otick(2.0))
        store.clear_strike(21800, "CE")
        assert not store.tick_available(21800, "CE")
        assert store.tick_available(21800, "PE")   # PE unaffected

    def test_clear_unregistered_strike_no_error(self):
        store = OptionBufferStore()
        store.clear_strike(99999, "CE")             # should not raise


class TestOptionBufferStoreGetLast:
    def test_get_last_empty(self):
        store = OptionBufferStore()
        store.register_strikes([21800])
        assert store.get_last(21800, "CE", n=5) == []

    def test_get_last_unregistered_returns_empty(self):
        store = OptionBufferStore()
        assert store.get_last(99999, "CE", n=5) == []

    def test_get_last_n_greater_than_available(self):
        store = OptionBufferStore()
        store.register_strikes([21800])
        store.push(21800, "CE", _otick(1.0))
        store.push(21800, "CE", _otick(2.0))
        result = store.get_last(21800, "CE", n=10)
        assert len(result) == 2

    def test_get_last_oldest_first(self):
        store = OptionBufferStore()
        store.register_strikes([21800])
        for i in range(5):
            store.push(21800, "CE", _otick(float(i)))
        result = store.get_last(21800, "CE", n=3)
        assert result[0].timestamp < result[1].timestamp < result[2].timestamp
