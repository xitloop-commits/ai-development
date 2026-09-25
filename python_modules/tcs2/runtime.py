"""TCS2 - the instrument process: feed on a worker, screen on the main thread.

Spec: docs/systems/14_tcs2.md  (D9, D13, D14, D16, D17)

One process per instrument, containing feed, chain, flow, recorder and screen
(D16). Partha chose same-process over the separate screen process I recommended,
so the arrangement below is not advice - it is the set of conditions that makes
that choice safe:

  * **Tkinter owns the MAIN thread** (required on Windows), and the feed and
    recorder run on workers. A frozen redraw therefore cannot stop the feed: a
    blocked Tk mainloop releases the GIL, so the workers keep running.
  * **The GUI never touches the tick path.** It reads an immutable `Snapshot`
    published on a timer. The feed thread never waits on the GUI.
  * **If the GUI falls behind, GUI updates are dropped - never ticks, never
    writes.** The snapshot slot holds one item and is overwritten.
  * **Each thread beats separately** (`health.py`), so a live screen can never
    make a stopped recorder look alive.

This module holds no Tkinter. The screen imports it, not the other way round, so
the whole runtime can be exercised headless - which is what the tests do.
"""
from __future__ import annotations

import asyncio
import threading
import time
import datetime as dt
from dataclasses import dataclass, field
from pathlib import Path

from . import config as cfg
from . import feed as feedmod
from . import scrip
from .analysis import Analysis
from .chain import Chain, ChainSummary
from .flow import FlowState
from .health import Health
from .recorder import TickRecorder
from .store import Store, current_rows, eod_rows
from .wire import Disconnect, RequestCode, Tick

# How often the analytics pass and the snapshot run. IV for a full chain costs
# about 14 ms, so four times a second is roughly 6% of one core - far below what
# a human reads, and far above what the eye needs.
DEFAULT_REFRESH_SEC = 0.25

# How often health is appended to disk (D17).
HEALTH_INTERVAL_SEC = 10.0

# How often the 25 points are recorded (kind D, D28). Every minute, per spec 15.
# Written even when the verdict is NO TRADE - the rejected setups are half the
# evidence, and without them the points can never be scored.
ANALYSIS_INTERVAL_SEC = 60.0

# How often the database tiers are flushed (D23: batched, never per change).
# Nothing live reads the database - the screen reads memory (D16) - so this can
# be generous. Measured: a full 1,484-leg upsert takes 113 ms, so five seconds
# is a 2% duty cycle on a worker thread.
STORE_INTERVAL_SEC = 5.0

# Flow state is kept for the futures and for option legs near the money. One
# FlowState per leg across 1,500 legs is affordable in memory but pointless:
# the far strikes barely print.
FLOW_BAND_STRIKES = 10


@dataclass(frozen=True)
class Snapshot:
    """What the screen reads. Immutable, replaced wholesale.

    Frozen on purpose: the GUI must never hold a reference to live state that the
    feed thread is mutating underneath it.
    """

    ts: float
    instrument: str
    spot: float
    reference: float
    vix: float
    futures: tuple[tuple[int, float], ...]
    expiries: tuple[str, ...]
    summaries: tuple[ChainSummary, ...]
    flow: dict
    health: dict
    analytics_ms: float
    points: dict


class InstrumentRuntime:
    """Everything one instrument's process does, minus the window."""

    def __init__(self, instrument: str, refresh_sec: float = DEFAULT_REFRESH_SEC,
                 health_dir: Path | None = None,
                 resolved: scrip.Resolved | None = None,
                 ticks_dir: Path | None = None,
                 record: bool = True,
                 store: Store | None = None,
                 analyser_dir: Path | None = None) -> None:
        self.instrument = instrument
        self.cap = cfg.CAPABILITIES[instrument]
        self.refresh_sec = refresh_sec
        # `resolved` is injectable so the whole runtime can be exercised offline,
        # with no scrip master download and no socket. The threading guarantees
        # in D16 are exactly the kind that must be tested, not asserted.
        self.resolved = resolved or scrip.resolve(instrument,
                                                  path=scrip.ensure_master())
        self.chain = Chain(self.resolved)
        self.health = Health(instrument=instrument,
                             trade_date=self.resolved.trade_date)
        self.health.legs_subscribed = self.resolved.total_legs
        self.health_path = (health_dir or cfg.HEALTH_DIR) / \
            self.resolved.trade_date / f"{instrument}.ndjson"

        # Kind A (D8): every tick, exactly as received. Sealed every 10 seconds
        # (D44), so a crash costs ten seconds rather than a day.
        self.recorder: TickRecorder | None = None
        if record:
            day = (ticks_dir or cfg.TICKS_DIR) / self.resolved.trade_date
            self.recorder = TickRecorder(day / f"{instrument}_ticks.ndjson.gz")

        # The database tiers (D23/D24). Optional: a headless probe or a test
        # runs perfectly well without one, and nothing live depends on it.
        self.store = store
        self._last_store_flush = 0.0
        self._eod_written = False
        self._last_analysis = 0.0
        self.analysis_recorder: TickRecorder | None = None
        if record:
            day = (analyser_dir or cfg.ANALYSER_DIR) / self.resolved.trade_date
            self.analysis_recorder = TickRecorder(
                day / f"{instrument}.ndjson.gz", seal_every_sec=60.0)
        # Whether this process has ever seen the market open. End-of-day rows are
        # written on the session ENDING WHILE WE WATCHED, never merely on being
        # outside session hours - otherwise a process started at 02:30 writes an
        # almost-empty chain and overwrites a good day. Found 2026-09-25 when
        # 1,496 end-of-day rows became 1.
        self._was_in_session = False

        # Flow is tracked per security, for the futures and a band of options.
        self.flow: dict[int, FlowState] = {}
        for c in self.resolved.futures:
            self.flow[int(c.security_id)] = FlowState()
        self._flow_band_ready = False

        # The one-slot snapshot. A lock, not a queue: a queue would let the GUI
        # fall behind and then show stale frames in order, which is worse than
        # showing the newest and dropping the rest.
        self._snap: Snapshot | None = None
        self._snap_lock = threading.Lock()

        self._stop = threading.Event()
        self._feed_thread: threading.Thread | None = None
        self._feed: feedmod.DhanFeed | None = None
        self._last_health_write = 0.0

    # -- session ---------------------------------------------------------

    def in_session(self, now: float | None = None) -> bool:
        """Is the market open for this instrument right now?

        Health uses it so a quiet market reads IDLE rather than DEAD. Measured
        2026-09-25 with the market closed: the recorder had nothing to write and
        its age climbed past every threshold, which would have shown DEAD all
        night. A light that cries wolf is one you stop looking at, which is how
        2026-09-18 went unnoticed for two and a half hours.
        """
        import datetime as _dt
        t = _dt.datetime.fromtimestamp(now if now is not None else time.time())
        if t.weekday() >= 5:
            return False
        opens = _dt.time(*(int(x) for x in self.cap.session_open.split(":")))
        closes = _dt.time(*(int(x) for x in self.cap.session_close.split(":")))
        return opens <= t.time() <= closes

    # -- the tick path, on the feed thread -------------------------------

    def _on_tick(self, t: Tick) -> None:
        """Runs on the feed thread. Must stay cheap and must never block."""
        if self.recorder is not None:
            # Queued, never written here: the feed thread must not wait on disk.
            self.recorder.write(_tick_row(t))
        self.chain.on_tick(t)
        fs = self.flow.get(t.security_id)
        if fs is not None:
            fs.on_tick(t)
        h = self.health
        h.ticks += 1
        if h.first_tick_at == 0.0:
            h.first_tick_at = t.recv_ts
        h.last_tick_at = t.recv_ts

    def _ensure_flow_band(self) -> None:
        """Start tracking flow for the legs near the money, once spot is known.

        Deferred because the ATM strike is not known until the underlying ticks,
        and re-picked never: the band is chosen once per session so a leg's flow
        history is not silently reset when price drifts (D26's spirit - nothing
        re-resolves mid-session).
        """
        if self._flow_band_ready:
            return
        atm = self.chain.atm_strike(self.chain.expiries[0])
        if not atm:
            return
        step = self.cap.strike_step
        lo, hi = atm - FLOW_BAND_STRIKES * step, atm + FLOW_BAND_STRIKES * step
        for i, sid in enumerate(self.chain.security_id):
            if lo <= self.chain.strike[i] <= hi:
                self.flow.setdefault(int(sid), FlowState())
        self._flow_band_ready = True

    # -- the publish path, on the feed thread ---------------------------

    def publish(self, now: float | None = None) -> Snapshot:
        """Build an immutable snapshot and hand it to the GUI."""
        now = now if now is not None else time.time()
        self._ensure_flow_band()
        ms = self.chain.refresh_analytics(now) * 1000.0

        h = self.health
        h.legs_seen = int((self.chain.tick_count > 0).sum())
        h.analytics_ms = ms
        h.unknown_prints = sum(f.unknown_prints for f in self.flow.values())
        h.in_session = self.in_session(now)
        if self.recorder is not None:
            rs = self.recorder.stats
            h.rows_written = rs.lines
            if rs.last_write_at:
                # The recorder's beat comes from an actual write reaching the
                # writer thread - never from the fact that the thread is alive.
                # A thread that is running but writing nothing is precisely the
                # 2026-09-18 failure.
                self.health.recorder.last_beat = rs.last_write_at
                self.health.recorder.beats = rs.lines
                if self.health.recorder.started_at == 0.0:
                    self.health.recorder.started_at = rs.last_write_at
            if rs.errors:
                self.health.recorder.note = rs.errors[-1]
        if self._feed is not None:
            h.frames = self._feed.stats.frames
            h.disconnects = len(self._feed.stats.disconnects)
            if self._feed.stats.disconnects:
                d = self._feed.stats.disconnects[-1]
                h.last_disconnect = f"{d.code}: {d.reason}"

        points = self._maybe_record_analysis(now)

        snap = Snapshot(
            ts=now,
            instrument=self.instrument,
            spot=self.chain.spot,
            reference=self.chain.reference,
            vix=self.chain.vix,
            futures=tuple(sorted(self.chain.futures.items())),
            expiries=self.chain.expiries,
            summaries=tuple(self.chain.summary(e, now) for e in self.chain.expiries),
            flow={sid: fs.snapshot(now=now) for sid, fs in self.flow.items()
                  if fs.ticks > 0},
            health=h.to_dict(now),
            analytics_ms=ms,
            points=points,
        )
        with self._snap_lock:
            self._snap = snap
        return snap

    def latest(self) -> Snapshot | None:
        """What the GUI calls. Never blocks for longer than a pointer swap."""
        with self._snap_lock:
            return self._snap

    # -- the 25 points ---------------------------------------------------

    def analyse(self, now: float | None = None) -> dict:
        """The 25 points right now (spec 15). Descriptive, never predictive."""
        a = Analysis(self.chain, self.flow, tuple(self.chain._futures_ids))
        return {n: p for n, p in a.all().items()}

    def _maybe_record_analysis(self, now: float) -> dict:
        """Recompute the points, and write them once a minute (kind D, D28).

        Separated from `publish` so the screen gets fresh points on every repaint
        while the RECORD stays at one row a minute - the screen wants current, the
        record wants a comparable series.
        """
        try:
            a = Analysis(self.chain, self.flow, tuple(self.chain._futures_ids))
            pts = a.all()
        except Exception as exc:                      # noqa: BLE001
            # The analysis must never be the thing that stops the feed. It is
            # the least proven part of the system (spec 15 §5.4) and the most
            # likely to hit an unexpected shape.
            self.health.gui.note = f"analysis: {exc}"[:120]
            return {}

        if (self.analysis_recorder is not None
                and now - self._last_analysis >= ANALYSIS_INTERVAL_SEC):
            if not self.analysis_recorder.running:
                self.analysis_recorder.start()
            row = a.record()
            row["ts"] = round(now, 3)
            row["instrument"] = self.instrument
            row["spot"] = self.chain.reference
            self.analysis_recorder.write(row)
            self._last_analysis = now
        return pts

    # -- the database ----------------------------------------------------

    def flush_store(self, now: float | None = None) -> tuple[int, int]:
        """Push the Now tier and the intraday rows. Returns (upserts, rows).

        Drains the chain's pending OI changes whether or not a store is
        configured, so the list cannot grow without bound in a headless run.
        """
        changes = self.chain.drain_oi_changes()
        if self.store is None:
            return 0, 0
        try:
            upserts = self.store.upsert_current(
                self.instrument, current_rows(self.chain), now)
            rows = self.store.write_intraday(
                self.instrument, changes, self.resolved.trade_date)
            return upserts, rows
        except Exception as exc:                      # noqa: BLE001
            # A database problem must never stop the feed or the recorder. The
            # ticks are already on disk; the tiers are rebuildable from them.
            self.store.stats.errors.append(f"{type(exc).__name__}: {exc}"[:200])
            self.health.recorder.note = f"store: {exc}"[:120]
            return 0, 0

    def write_end_of_day(self, now: float | None = None) -> int:
        """One row per strike for today, plus the daily record (D23 tier 3, D29).

        Tagged as coming from our feed. The exchange revises OI after the close -
        crude was out by 15.5% - so the post-session job (D34) rewrites these
        rows as `official` once Dhan publishes.

        Safe to call twice: the day is cleared first, and the daily record is
        replaced rather than appended, so a re-run cannot leave two disagreeing
        records for one day.
        """
        if self.store is None:
            return 0
        day = self.resolved.trade_date
        self.store.clear_eod(self.instrument, day)
        n = self.store.write_eod(self.instrument, day, eod_rows(self.chain))
        self.store.write_daily(self.build_daily_record(now))
        self._eod_written = True
        return n

    def build_daily_record(self, now: float | None = None) -> dict:
        """Kind C, the six-part daily record (D29).

        Part 6, the data-quality stamp, is the one that pays for itself: it lets
        a later study drop a bad day automatically instead of silently averaging
        it in - which is what went wrong when blast's crude dataset held
        2026-08-21 with two rows and nothing noticed (T185).
        """
        now = now if now is not None else time.time()
        h = self.health
        ch = self.chain
        expiries = []
        for e in ch.expiries:
            sm = ch.summary(e, now)
            expiries.append({
                "exp": e, "dte": round(sm.days_to_expiry, 4),
                "forward": ch.forward.get(e, 0.0),
                "call_oi": sm.total_call_oi, "put_oi": sm.total_put_oi,
                "call_vol": sm.total_call_volume, "put_vol": sm.total_put_volume,
                "pcr_oi": round(sm.pcr_oi, 4), "pcr_vol": round(sm.pcr_volume, 4),
                "max_pain": sm.max_pain, "atm": sm.atm_strike,
                "atm_straddle": sm.atm_straddle,
                "atm_iv": None if sm.atm_iv != sm.atm_iv else round(sm.atm_iv, 6),
                "call_wall": [sm.call_wall_strike, sm.call_wall_oi],
                "put_wall": [sm.put_wall_strike, sm.put_wall_oi],
                "legs_ticked": sm.legs_seen,
            })
        futures = [{"sid": sid, "ltp": px} for sid, px in sorted(ch.futures.items())]
        span = (h.last_tick_at - h.first_tick_at) if h.first_tick_at else 0.0
        return {
            "instrument": self.instrument,
            "trade_date": self.resolved.trade_date,
            "written_at": dt.datetime.fromtimestamp(now).isoformat(timespec="seconds"),
            "expiries": expiries,
            "futures": futures,
            "underlying": {
                "spot": ch.spot, "reference": ch.reference, "vix": ch.vix,
                "session_high": max((f.session_high for f in self.flow.values()),
                                    default=0.0),
                "session_low": min((f.session_low for f in self.flow.values()
                                    if f.session_low > 0), default=0.0),
            },
            "quality": {
                # D29 part 6. `complete` is deliberately conservative: it says
                # only that data spanned most of the session, never that the data
                # is correct.
                "complete": span >= 0.8 * self._session_seconds(),
                "ticks": h.ticks, "frames": h.frames,
                "legs_subscribed": h.legs_subscribed, "legs_seen": h.legs_seen,
                "coverage": round(h.coverage(), 4),
                "first_tick": (dt.datetime.fromtimestamp(h.first_tick_at).isoformat(
                    timespec="seconds") if h.first_tick_at else None),
                "last_tick": (dt.datetime.fromtimestamp(h.last_tick_at).isoformat(
                    timespec="seconds") if h.last_tick_at else None),
                "span_seconds": round(span, 1),
                "rows_written": h.rows_written,
                "disconnects": h.disconnects,
                "last_disconnect": h.last_disconnect,
                "bookless_prints": h.unknown_prints,
            },
        }

    def _session_seconds(self) -> float:
        o = [int(x) for x in self.cap.session_open.split(":")]
        c = [int(x) for x in self.cap.session_close.split(":")]
        return max(1.0, ((c[0] * 60 + c[1]) - (o[0] * 60 + o[1])) * 60.0)

    # -- the feed thread -------------------------------------------------

    def _full_legs(self) -> list[tuple[str, str]]:
        """Options and futures - these need FULL for the book and OI (D36)."""
        r, seg = self.resolved, self.cap.segment
        legs = [(seg, c.security_id) for c in r.options]
        legs += [(seg, c.security_id) for c in r.futures]
        return legs

    def _quote_legs(self) -> list[tuple[str, str]]:
        """Index and VIX - these send NOTHING in FULL mode (D51).

        Measured live 2026-09-25: ids 13, 21 and 25 subscribed in FULL returned
        zero packets, while QUOTE returned price and day OHLC. So they go in
        their own group on the same connection.
        """
        r = self.resolved
        legs = []
        if r.index:
            legs.append(("IDX_I", r.index.security_id))
        if r.vix:
            legs.append(("IDX_I", r.vix.security_id))
        return legs

    def _legs(self) -> list[tuple[str, str]]:
        """Everything, for a leg count. Not used to subscribe - see above."""
        return self._full_legs() + self._quote_legs()

    async def _feed_loop(self) -> None:
        if self.recorder is not None and not self.recorder.running:
            self.recorder.start()
        token, cid = feedmod.load_credentials()
        self._feed = feedmod.DhanFeed(token, cid, on_tick=self._on_tick,
                                      mode=RequestCode.SUBSCRIBE_FULL)
        await self._feed.connect()
        # Two groups, two modes, one connection (D51). An index in FULL mode
        # returns nothing at all, so subscribing everything together silently
        # loses spot and VIX.
        await self._feed.subscribe(self._full_legs(), RequestCode.SUBSCRIBE_FULL)
        quote_legs = self._quote_legs()
        if quote_legs:
            await self._feed.subscribe(quote_legs, RequestCode.SUBSCRIBE_QUOTE)
        self.health.feed.beat(note="connected")

        next_pub = time.time()
        while not self._stop.is_set():
            try:
                buf = await asyncio.wait_for(self._feed._ws.recv(), timeout=0.2)
                if isinstance(buf, bytes):
                    self._feed._handle_frame(buf)
                    self.health.feed.beat()
            except asyncio.TimeoutError:
                # Quiet socket is not a dead socket. The beat still fires so a
                # thin market does not read as a stall; only a genuinely stopped
                # loop goes silent.
                self.health.feed.beat(note="idle")
            except Exception as exc:                  # noqa: BLE001
                self.health.feed.note = f"error: {exc}"[:120]
                break

            now = time.time()
            if now >= next_pub:
                self.publish(now)
                next_pub = now + self.refresh_sec
            if now - self._last_store_flush >= STORE_INTERVAL_SEC:
                self.flush_store(now)
                self._last_store_flush = now
                # Write the end-of-day rows once, on the transition out of the
                # session, rather than at shutdown. A process killed after the
                # close would otherwise never produce them.
                if self.in_session(now):
                    self._was_in_session = True
                elif (self._was_in_session and not self._eod_written
                        and self.health.ticks > 0):
                    try:
                        self.write_end_of_day(now)
                    except Exception as exc:          # noqa: BLE001
                        self.health.recorder.note = f"eod: {exc}"[:120]
            if now - self._last_health_write >= HEALTH_INTERVAL_SEC:
                self.health.append_to(self.health_path, now)
                self._last_health_write = now

        await self._feed.close()

    def start(self) -> None:
        """Start the feed on a worker. The caller keeps the main thread."""
        if self._feed_thread is not None:
            raise RuntimeError("already started")
        self._stop.clear()

        def run() -> None:
            asyncio.run(self._feed_loop())

        self._feed_thread = threading.Thread(target=run, name="tcs2-feed",
                                             daemon=True)
        self._feed_thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._feed_thread is not None:
            self._feed_thread.join(timeout=timeout)
            self._feed_thread = None
        # A last flush before shutting down, so the final few seconds of OI
        # changes reach the database rather than dying with the process.
        try:
            self.flush_store()
        except Exception:                             # noqa: BLE001
            pass
        # The recorder stops LAST and is given longer, because a graceful stop
        # must drain the queue and seal the open member. Cutting it short here
        # would throw away the final seconds that D44 exists to protect.
        if self.recorder is not None and self.recorder.running:
            self.recorder.stop(timeout=30.0)
        if self.analysis_recorder is not None and self.analysis_recorder.running:
            self.analysis_recorder.stop(timeout=15.0)

    @property
    def running(self) -> bool:
        return self._feed_thread is not None and self._feed_thread.is_alive()


def _tick_row(t: Tick) -> dict:
    """One tick as a record. Everything received, nothing derived.

    D8's rule: store what arrived, never what we computed from it. IV, Greeks,
    flow readings and the chain are all rebuildable from these rows, and keeping
    them out means a change to the analysis can be replayed against the same
    data rather than compared against a frozen answer.
    """
    row = {
        "sid": t.security_id, "k": t.kind, "ts": round(t.recv_ts, 6),
        "ltp": t.ltp, "ltq": t.ltq, "ltt": t.ltt, "vol": t.volume,
        "oi": t.oi, "bid": t.bid, "ask": t.ask,
        "bq": t.bid_size, "aq": t.ask_size,
    }
    if t.atp:
        row["atp"] = t.atp
    if t.total_buy or t.total_sell:
        row["tb"], row["ts_"] = t.total_buy, t.total_sell
    if t.high_oi or t.low_oi:
        row["hoi"], row["loi"] = t.high_oi, t.low_oi
    if t.day_open or t.day_high or t.day_low or t.day_close:
        row["o"], row["h"] = t.day_open, t.day_high
        row["l"], row["c"] = t.day_low, t.day_close
    if t.prev_close or t.prev_oi:
        row["pc"], row["poi"] = t.prev_close, t.prev_oi
    if t.depth:
        row["d"] = [[l.bid_qty, l.ask_qty, l.bid_orders, l.ask_orders,
                     l.bid_price, l.ask_price] for l in t.depth]
    return row
