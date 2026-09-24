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


def runtime(tmp_path) -> InstrumentRuntime:
    return InstrumentRuntime("nifty50", health_dir=tmp_path, resolved=resolved())


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
