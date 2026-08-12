"""
Tests for the SMA-5 price-cross detector (`sma5_signal.Sma5SignalDetector`).

Fires LONG_CE when the 1-min close crosses ABOVE the 5-period SMA and LONG_PE
when it crosses BELOW; a flip emits the opposite side's EXIT_* first (symmetric).
"""
from __future__ import annotations

from signal_engine_agent.sma5_signal import Sma5SignalDetector
from signal_engine_agent.thresholds import Sma5SignalThresholds


def _det(**kw) -> Sma5SignalDetector:
    return Sma5SignalDetector(Sma5SignalThresholds(**kw))


def _run(det, closes):
    """Feed one candle per minute (a couple of ticks each). The first tick of a
    new minute closes the prior candle; a final flush tick closes the last."""
    fires = []
    for m, c in enumerate(closes):
        fires.extend(det.on_tick(m * 60 + 0.0, c))
        det.on_tick(m * 60 + 40.0, c)
    fires.extend(det.on_tick(len(closes) * 60 + 0.0, closes[-1]))
    return fires


def test_no_event_during_warmup():
    """Fewer closes than the SMA period → never fires."""
    assert _run(_det(use_ha=False), [1000, 1010, 1020, 1030]) == []


def test_cross_above_fires_call_once():
    """A clean rising series crosses above the SMA-5 and fires ONE call."""
    assert _run(_det(use_ha=False), [1000, 1010, 1020, 1030, 1040, 1050]) == ["LONG_CE"]


def test_cross_below_fires_put_and_exits_call():
    """Rise (CALL) then a drop below the line → EXIT_CE + LONG_PE (symmetric)."""
    closes = [1000, 1010, 1020, 1030, 1040, 1050, 900]
    assert _run(_det(use_ha=False), closes) == ["LONG_CE", "EXIT_CE", "LONG_PE"]


def test_flip_back_above_exits_put_and_re_enters_call():
    """A down leg then a fresh push above the line flips PE→CE."""
    closes = [1000, 990, 980, 970, 960, 950, 1100]
    fires = _run(_det(use_ha=False), closes)
    assert fires[:1] == ["LONG_PE"]
    assert fires[-2:] == ["EXIT_PE", "LONG_CE"]


def test_buffer_deadband_suppresses_marginal_cross():
    """With a buffer, a close only just above the line does NOT flip."""
    # Flat-ish series so the close sits a hair above the SMA; 5% buffer swallows it.
    closes = [1000, 1000, 1000, 1000, 1000, 1001]
    assert _run(_det(buffer_pct=5.0, use_ha=False), closes) == []


def test_ha_mode_fires_on_clean_uptrend():
    """Heikin-Ashi mode still fires a call on a clean rising series (path works)."""
    assert _run(_det(use_ha=True), [1000 + i * 10 for i in range(8)]) == ["LONG_CE"]


def test_ha_mode_symmetric_put_on_downtrend():
    assert _run(_det(use_ha=True), [1000 - i * 10 for i in range(8)]) == ["LONG_PE"]


# ── confirm_candles: gate reversals so a 1-candle poke doesn't exit early ──────

def test_confirm_default_1_flips_on_first_cross():
    """confirm_candles=1 (default) = original behaviour: a single below candle
    reverses immediately (EXIT_CE + LONG_PE)."""
    closes = [1000, 1010, 1020, 1030, 1040, 1050, 900, 1200]
    fires = _run(_det(use_ha=False), closes)  # confirm_candles defaults to 1
    assert fires == ["LONG_CE", "EXIT_CE", "LONG_PE", "EXIT_PE", "LONG_CE"]


def test_confirm_2_ignores_one_candle_poke_that_recovers():
    """A lone candle below the line that recovers green next bar must NOT exit."""
    closes = [1000, 1010, 1020, 1030, 1040, 1050, 900, 1200]
    fires = _run(_det(use_ha=False, confirm_candles=2), closes)
    assert fires == ["LONG_CE"]  # no EXIT_CE — the poke was unconfirmed


def test_confirm_2_exits_on_sustained_reversal():
    """Two consecutive closes below the line confirm the reversal → it exits."""
    closes = [1000, 1010, 1020, 1030, 1040, 1050, 900, 800]
    fires = _run(_det(use_ha=False, confirm_candles=2), closes)
    assert fires == ["LONG_CE", "EXIT_CE", "LONG_PE"]


def test_confirm_2_first_entry_from_flat_is_immediate():
    """Confirmation gates only reversals — the first entry still fires at once."""
    closes = [1000, 1010, 1020, 1030, 1040, 1050]
    assert _run(_det(use_ha=False, confirm_candles=2), closes) == ["LONG_CE"]


# ── entry_watch: wait N candles that keep closing further before entering ──────

def test_entry_watch_0_enters_immediately_on_the_cross():
    """Default (0) = original behaviour: enter on the cross candle."""
    assert _run(_det(use_ha=False, period=3, entry_watch=0), [1000, 1010, 1020, 1030]) == ["LONG_CE"]


def test_entry_watch_1_enters_after_a_higher_close():
    """With 1, entry waits for the next candle to close ABOVE the cross candle."""
    assert _run(_det(use_ha=False, period=3, entry_watch=1), [1000, 1010, 1020, 1030]) == ["LONG_CE"]


def test_entry_watch_1_cancels_when_next_close_is_lower():
    """A spike that crosses then reverts (lower next close, still above the line)
    never gets bought."""
    assert _run(_det(use_ha=False, period=3, entry_watch=1), [1000, 1010, 1020, 1018]) == []


def test_entry_watch_2_needs_two_rising_closes():
    assert _run(_det(use_ha=False, period=3, entry_watch=2), [1000, 1010, 1020, 1030, 1040]) == ["LONG_CE"]


def test_entry_watch_put_side_needs_lower_closes():
    """Symmetric for PE: after crossing below, the next candle must close LOWER."""
    assert _run(_det(use_ha=False, period=3, entry_watch=1), [1000, 990, 980, 970]) == ["LONG_PE"]


def _run_notes(det, closes):
    """Like _run but collects the entry-watch audit note from each candle close."""
    notes = []
    for m, c in enumerate(closes):
        det.on_tick(m * 60 + 0.0, c)
        if det.last_watch_note:
            notes.append(det.last_watch_note)
        det.on_tick(m * 60 + 40.0, c)
    det.on_tick(len(closes) * 60 + 0.0, closes[-1])
    if det.last_watch_note:
        notes.append(det.last_watch_note)
    return notes


def test_entry_watch_audit_note_traces_arm_confirm_enter():
    notes = _run_notes(_det(use_ha=False, period=3, entry_watch=2), [1000, 1010, 1020, 1030, 1040])
    assert "armed" in notes[0]
    assert "confirming 1/2" in notes[1]
    assert "entered" in notes[2] and "2/2" in notes[2]


def test_entry_watch_audit_note_traces_cancellation():
    notes = _run_notes(_det(use_ha=False, period=3, entry_watch=1), [1000, 1010, 1020, 1018])
    assert "armed" in notes[0]
    assert "cancelled" in notes[-1]


def test_entry_watch_0_sets_no_audit_note():
    """When disabled, the immediate entry leaves no watch note (no log noise)."""
    assert _run_notes(_det(use_ha=False, period=3, entry_watch=0), [1000, 1010, 1020, 1030]) == []


# ── candle_sec: the timeframe the detector buckets on ─────────────────────────

def test_candle_sec_3m_buckets_at_180s():
    """With candle_sec=180 a candle closes every 3 min; the cross still fires."""
    det = _det(use_ha=False, period=3, candle_sec=180)
    fires = []
    closes = [1000, 1010, 1020, 1030]
    for m, c in enumerate(closes):
        fires.extend(det.on_tick(m * 180 + 0.0, c))
        det.on_tick(m * 180 + 100.0, c)
    fires.extend(det.on_tick(len(closes) * 180 + 0.0, closes[-1]))
    assert fires == ["LONG_CE"]


def test_same_ticks_do_not_close_a_3m_candle_early():
    """Ticks within a 3-min window must NOT complete a candle (bucketing works)."""
    det = _det(use_ha=False, period=3, candle_sec=180)
    fires = []
    # 3 ticks all inside the FIRST 180s bucket → no candle close, no event.
    for t in (0.0, 60.0, 120.0):
        fires.extend(det.on_tick(t, 1000 + t))
    assert fires == []


def test_set_candle_sec_resets_state_and_is_noop_when_unchanged():
    det = _det(use_ha=False, period=3, candle_sec=60)
    det.on_tick(0.0, 1000.0)
    det.on_tick(30.0, 1005.0)
    det.set_candle_sec(60)          # unchanged → no reset
    assert det.candle_sec == 60
    det.set_candle_sec(180)         # changed → aggregation resets, SMA re-warms
    assert det.candle_sec == 180
    assert det._cur_minute is None
    assert len(det._closes) == 0
