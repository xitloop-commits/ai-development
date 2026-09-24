"""TCS2 - tests for the instrument runtime and its threading guarantees.

Spec: docs/systems/14_tcs2.md  D16

Partha chose to run the screen inside the instrument process rather than beside
it. The conditions that make that safe are not advice, so they are tested here
rather than described in a comment:

  * a stalled GUI must not stop the feed
  * the GUI must never hold live state the feed is mutating
  * when the GUI falls behind, GUI frames are dropped - never ticks

These run headless: the runtime accepts an injected contract list, so no scrip
master and no socket are needed.
"""
from __future__ import annotations

import threading
import time

import pytest

from tcs2.runtime import Snapshot, InstrumentRuntime
from tcs2.scrip import Contract, Resolved
from tcs2.wire import DepthLevel, ResponseCode, Tick

EXPIRY = "2026-10-06"


def _opt(sid: int, strike: float, side: str) -> Contract:
    return Contract(str(sid), f"N {strike:.0f} {side}", "OPTIDX", EXPIRY,
                    strike, side, "W", 65, 0.05)


def resolved(n_strikes: int = 5) -> Resolved:
    opts, sid = [], 1000
    base = 23400.0
    for i in range(n_strikes):
        for side in ("CE", "PE"):
            opts.append(_opt(sid, base + i * 50, side))
            sid += 1
    return Resolved(
        instrument="nifty50", trade_date="2026-10-01",
        index=Contract("13", "Nifty 50", "INDEX", "", 0.0, "XX", "", 1, 0.05),
        vix=Contract("21", "India VIX", "INDEX", "", 0.0, "XX", "", 1, 0.05),
        futures=(Contract("900", "NIFTY FUT", "FUTIDX", EXPIRY, 0.0, "XX", "M",
                          65, 0.05),),
        option_expiries=(EXPIRY,), options=tuple(opts))


def runtime(tmp_path, record: bool = False) -> InstrumentRuntime:
    return InstrumentRuntime("nifty50", health_dir=tmp_path, resolved=resolved(),
                             ticks_dir=tmp_path / "ticks", record=record)


def full(sid: int, ltp=100.0, oi=1000, volume=5000, ts=None) -> Tick:
    depth = tuple(DepthLevel(500, 400, 3, 2, ltp - 1, ltp + 1) for _ in range(5))
    return Tick(security_id=sid, segment=2, kind=ResponseCode.FULL,
                recv_ts=ts if ts is not None else time.time(),
                ltp=ltp, ltq=65, volume=volume, oi=oi,
                bid=ltp - 1, ask=ltp + 1, bid_size=500, ask_size=400, depth=depth)


def index(ltp: float, ts=None) -> Tick:
    return Tick(security_id=13, segment=0, kind=ResponseCode.TICKER,
                recv_ts=ts if ts is not None else time.time(), ltp=ltp)


# -- construction --------------------------------------------------------

def test_runtime_builds_offline(tmp_path):
    r = runtime(tmp_path)
    assert r.instrument == "nifty50"
    assert r.health.legs_subscribed == r.resolved.total_legs
    assert not r.running


def test_futures_get_flow_state_from_the_start(tmp_path):
    """The futures is the one leg always worth tracking flow on."""
    r = runtime(tmp_path)
    assert 900 in r.flow


def test_option_flow_band_waits_for_a_spot(tmp_path):
    """The band is centred on ATM, which is unknown until the underlying ticks."""
    r = runtime(tmp_path)
    r._ensure_flow_band()
    assert not r._flow_band_ready
    r._on_tick(index(23500.0))
    r._ensure_flow_band()
    assert r._flow_band_ready
    assert len(r.flow) > 1


def test_the_flow_band_is_chosen_once_not_re_picked(tmp_path):
    """Re-picking would silently reset a leg's flow history as price drifts."""
    r = runtime(tmp_path)
    r._on_tick(index(23400.0))
    r._ensure_flow_band()
    before = set(r.flow)
    r._on_tick(index(29000.0))
    r._ensure_flow_band()
    assert set(r.flow) == before


# -- the tick path -------------------------------------------------------

def test_a_tick_reaches_both_the_chain_and_flow(tmp_path):
    r = runtime(tmp_path)
    r._on_tick(index(23500.0))
    r._ensure_flow_band()
    r._on_tick(full(1000, ltp=132.5))
    assert r.chain.ltp[r.chain._row[1000]] == pytest.approx(132.5)
    assert r.flow[1000].ticks == 1


def test_health_counters_follow_the_ticks(tmp_path):
    r = runtime(tmp_path)
    t0 = time.time()
    r._on_tick(full(1000, ts=t0))
    r._on_tick(full(1001, ts=t0 + 1))
    assert r.health.ticks == 2
    assert r.health.first_tick_at == t0
    assert r.health.last_tick_at == t0 + 1


# -- the snapshot --------------------------------------------------------

def test_snapshot_is_immutable(tmp_path):
    """The GUI must never hold a reference to state the feed is mutating."""
    r = runtime(tmp_path)
    r._on_tick(index(23500.0))
    snap = r.publish()
    assert isinstance(snap, Snapshot)
    with pytest.raises(Exception):
        snap.spot = 1.0                       # frozen dataclass


def test_latest_returns_the_newest_and_drops_the_rest(tmp_path):
    """One slot, not a queue.

    A queue would let the GUI fall behind and then render stale frames in order,
    which is worse than rendering the newest and discarding the rest (D16).
    """
    r = runtime(tmp_path)
    r._on_tick(index(23400.0))
    r.publish()
    r._on_tick(index(23500.0))
    r.publish()
    r._on_tick(index(23600.0))
    last = r.publish()
    assert r.latest() is last
    assert r.latest().spot == pytest.approx(23600.0)


def test_latest_is_none_before_the_first_publish(tmp_path):
    assert runtime(tmp_path).latest() is None


def test_snapshot_carries_what_the_screen_needs(tmp_path):
    r = runtime(tmp_path)
    r._on_tick(index(23500.0))
    r._on_tick(full(900, ltp=23520.0))
    r._ensure_flow_band()
    r._on_tick(full(1000, ltp=132.5, oi=4200))
    snap = r.publish()
    assert snap.spot == pytest.approx(23500.0)
    assert snap.expiries == (EXPIRY,)
    assert len(snap.summaries) == 1
    assert snap.health["feed"]["status"] in ("ok", "idle", "late", "dead")
    assert 900 in snap.flow


def test_publish_records_how_long_the_analytics_took(tmp_path):
    r = runtime(tmp_path)
    r._on_tick(index(23500.0))
    r._on_tick(full(1000, ltp=132.5))
    snap = r.publish()
    assert snap.analytics_ms >= 0.0
    assert snap.health["analytics_ms"] == snap.analytics_ms


# -- the property the whole design rests on -----------------------------

def test_a_stalled_gui_does_not_stop_the_tick_path(tmp_path):
    """D16's central claim, measured rather than asserted.

    A 'GUI' thread holds its read and sleeps, imitating a frozen redraw. Ticks
    must keep arriving throughout - the feed never waits on the reader.
    """
    r = runtime(tmp_path)
    r._on_tick(index(23500.0))
    r.publish()

    stop = threading.Event()
    gui_reads = []

    def frozen_gui() -> None:
        while not stop.is_set():
            gui_reads.append(r.latest())
            time.sleep(0.05)            # a slow, blocking consumer

    gui = threading.Thread(target=frozen_gui, daemon=True)
    gui.start()

    ticks_before = r.health.ticks
    deadline = time.time() + 0.4
    n = 0
    while time.time() < deadline:
        r._on_tick(full(1000 + (n % 10), ltp=100.0 + n, volume=5000 + n))
        n += 1
    stop.set()
    gui.join(timeout=1.0)

    assert r.health.ticks - ticks_before == n
    assert n > 100, "the tick path was throttled by the reader"


def test_the_gui_never_blocks_the_publisher_for_long(tmp_path):
    """`latest()` is a pointer swap under a lock, nothing more."""
    r = runtime(tmp_path)
    r._on_tick(index(23500.0))
    r.publish()
    t0 = time.perf_counter()
    for _ in range(10_000):
        r.latest()
    assert (time.perf_counter() - t0) < 1.0


def test_reader_and_publisher_can_run_concurrently(tmp_path):
    """No torn reads: every snapshot a reader sees is internally consistent."""
    r = runtime(tmp_path)
    r._on_tick(index(23500.0))
    r.publish()

    stop = threading.Event()
    seen: list[Snapshot] = []

    def reader() -> None:
        while not stop.is_set():
            s = r.latest()
            if s is not None:
                seen.append(s)

    th = threading.Thread(target=reader, daemon=True)
    th.start()
    for i in range(200):
        r._on_tick(index(23500.0 + i))
        r.publish()
    stop.set()
    th.join(timeout=1.0)

    assert seen
    for s in seen:
        assert s.spot == s.reference        # consistent within one snapshot


# -- health on disk ------------------------------------------------------

def test_health_path_is_dated_and_per_instrument(tmp_path):
    r = runtime(tmp_path)
    assert r.health_path.name == "nifty50.ndjson"
    assert r.health_path.parent.name == "2026-10-01"


def test_health_can_be_written(tmp_path):
    r = runtime(tmp_path)
    r.health.feed.beat()
    r.health.append_to(r.health_path)
    assert r.health_path.exists()
    assert r.health_path.read_text(encoding="utf-8").count("\n") == 1


# -- recording (D8, D44) -------------------------------------------------

def test_recording_is_off_when_asked_and_on_by_default(tmp_path):
    assert runtime(tmp_path).recorder is None
    assert runtime(tmp_path, record=True).recorder is not None


def test_every_tick_reaches_the_recorder(tmp_path):
    from tcs2.recorder import read_json
    r = runtime(tmp_path, record=True)
    r.recorder.start()
    r._on_tick(index(23500.0))
    for i in range(20):
        r._on_tick(full(1000, ltp=100.0 + i, volume=5000 + i))
    r.recorder.stop()
    rows = list(read_json(r.recorder.path))
    assert len(rows) == 21


def test_recorded_rows_carry_what_arrived_not_what_we_computed(tmp_path):
    """D8: store what arrived. IV, Greeks and flow are all rebuildable.

    Keeping derived values out is what lets a changed analysis be replayed
    against the same data rather than compared against a frozen answer.
    """
    from tcs2.recorder import read_json
    r = runtime(tmp_path, record=True)
    r.recorder.start()
    r._on_tick(full(1000, ltp=132.5, oi=4200, volume=9100))
    r.recorder.stop()
    row = list(read_json(r.recorder.path))[0]
    assert row["ltp"] == pytest.approx(132.5)
    assert row["oi"] == 4200
    assert row["bid"] and row["ask"] and row["d"]        # the book, 5 levels
    for derived in ("iv", "delta", "gamma", "theta", "vega"):
        assert derived not in row


def test_the_recorder_beat_comes_from_writes_not_from_being_alive(tmp_path):
    """The 2026-09-18 failure, guarded.

    A recorder thread that is running but writing nothing must NOT report
    healthy. The beat is taken from the last actual write.
    """
    from tcs2.health import IDLE
    r = runtime(tmp_path, record=True)
    r.recorder.start()
    try:
        r.publish()
        assert r.health.recorder.status() == IDLE, (
            "a running-but-silent recorder must not look healthy")
        r._on_tick(full(1000, ltp=100.0))
        import time as _t
        _t.sleep(0.05)
        r.publish()
        assert r.health.recorder.beats > 0
        assert r.health.recorder.last_beat > 0
    finally:
        r.recorder.stop()


def test_rows_written_is_reported_in_health(tmp_path):
    r = runtime(tmp_path, record=True)
    r.recorder.start()
    for i in range(10):
        r._on_tick(full(1000, ltp=100.0 + i, volume=5000 + i))
    import time as _t
    _t.sleep(0.1)
    snap = r.publish()
    r.recorder.stop()
    assert snap.health["rows_written"] == 10


def test_recorded_ticks_can_be_replayed_back_into_a_fresh_runtime(tmp_path):
    """Replay is what rebuilds opening OI, cumulative delta and session high/low
    after a crash (D44). If it does not round-trip, the guarantee is empty.
    """
    from tcs2.recorder import read_json
    live = runtime(tmp_path, record=True)
    live.recorder.start()
    live._on_tick(index(23500.0))
    for i in range(30):
        live._on_tick(full(1000, ltp=100.0 + i, oi=4000 + i * 10,
                           volume=5000 + i * 100))
    live.recorder.stop()

    rows = list(read_json(live.recorder.path))
    assert len(rows) == 31
    # The values needed to rebuild state are all present.
    opts = [r for r in rows if r["sid"] == 1000]
    assert opts[0]["oi"] == 4000
    assert opts[-1]["oi"] == 4000 + 29 * 10
    assert opts[-1]["ltp"] == pytest.approx(129.0)


# -- end of day (D29) ----------------------------------------------------

def test_the_daily_record_has_all_six_parts(tmp_path):
    """D29 locked six parts; a record missing one is not the record."""
    r = runtime(tmp_path)
    r._on_tick(index(23500.0))
    r._on_tick(full(900, ltp=23520.0))
    r._ensure_flow_band()
    for i in range(10):
        r._on_tick(full(1000, ltp=100.0 + i, oi=4000 + i * 10, volume=5000 + i))
    rec = r.build_daily_record()
    for part in ("instrument", "trade_date", "expiries", "futures",
                 "underlying", "quality"):
        assert part in rec, part
    assert rec["expiries"][0]["exp"] == EXPIRY
    assert rec["futures"][0]["ltp"] == pytest.approx(23520.0)


def test_the_quality_stamp_says_whether_the_day_is_usable(tmp_path):
    """D29 part 6 - so a study can drop a bad day instead of averaging it in.

    That is what went wrong when blast's crude dataset held 2026-08-21 with two
    rows and nothing noticed (T185).
    """
    r = runtime(tmp_path)
    r._on_tick(index(23500.0))
    r._on_tick(full(1000, ltp=100.0))
    q = r.build_daily_record()["quality"]
    for key in ("complete", "ticks", "legs_subscribed", "legs_seen", "coverage",
                "first_tick", "last_tick", "span_seconds", "disconnects",
                "bookless_prints"):
        assert key in q, key
    # Two ticks is not a session.
    assert q["complete"] is False


def test_a_short_day_is_not_marked_complete(tmp_path):
    """The 2026-08-21 case: two rows must never read as a full day."""
    r = runtime(tmp_path)
    t0 = time.time()
    r._on_tick(full(1000, ltp=100.0, ts=t0))
    r._on_tick(full(1000, ltp=101.0, ts=t0 + 30))
    assert r.build_daily_record()["quality"]["complete"] is False


def test_atm_iv_is_none_rather_than_nan_in_the_record(tmp_path):
    """NaN does not survive JSON or Mongo cleanly; absent is the honest value."""
    r = runtime(tmp_path)
    r._on_tick(index(23500.0))
    rec = r.build_daily_record()
    assert rec["expiries"][0]["atm_iv"] is None


def test_end_of_day_without_a_store_is_a_no_op(tmp_path):
    r = runtime(tmp_path)
    r._on_tick(index(23500.0))
    assert r.write_end_of_day() == 0


def test_flush_drains_oi_changes_even_without_a_store(tmp_path):
    """Otherwise the pending list grows all day in a headless run."""
    r = runtime(tmp_path)
    r._on_tick(index(23500.0))
    r._on_tick(full(1000, oi=1000))
    r._on_tick(full(1000, oi=1200, volume=5001))
    assert r.chain.oi_changes
    r.flush_store()
    assert not r.chain.oi_changes
