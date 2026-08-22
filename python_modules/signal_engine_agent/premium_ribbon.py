"""
premium_ribbon.py — SEA premium-ribbon detectors (T163, 2026-08-13).

Partha's rewrite of the sma5/ma cohorts: entry and exit follow the TREND
RIBBON computed on the SESSION-LOCKED option contract's OWN premium (not the
underlying). This is the causal Python port of the chart's shared trend
engine (client/src/lib/trendRibbon.ts), minus the history-polish passes —
those repaint the past for the eye; a live detector only ever sees the edge.

Per leg (the locked CE and the locked PE contract):

  • Aggregate premium ticks into `candle_sec` candles; smooth the closes with
    the leg's line (SMA-5 of closes, or the 20-EMA for the "ma" source, with
    the same 5-candle warmup the chart uses).
  • Slope = % change of the line over the last `lookback` candles.
  • Noise floor = the `gray_pctile` percentile of all |slope| values seen so
    far TODAY (expanding, causal — needs `min_samples` before it can judge).
  • State: UP when slope > floor, DOWN when slope < −floor, else SIDEWAYS.

Signals (each leg judged ONLY by its own premium; Partha 2026-08-13):

    CE ribbon turns UP    →  LONG_CE     (call premium rising beats decay)
    CE ribbon turns DOWN  →  EXIT_CE
    PE ribbon turns UP    →  LONG_PE     (put premium rising = down-move)
    PE ribbon turns DOWN  →  EXIT_PE
    SIDEWAYS (gray)       →  NOTHING — no entry at all; an open ride holds.

`LockedPremiumFeed` supplies the ticks: a daemon thread polls the server's
/api/sea/locked-premiums endpoint (T161 lock + option-day index), fetching
the full session once (warm-up, emitted-event-free) and then incrementally.
A mid-day relock (drift OK button) resets the leg and re-warms on the new
contract's history.
"""

from __future__ import annotations

import math
import threading
from collections import deque
from typing import Callable

RibbonEvent = str  # "LONG_CE" | "EXIT_CE" | "LONG_PE" | "EXIT_PE"


class RibbonLeg:
    """One contract's premium ribbon: candles → line → slope → UP/DOWN/GRAY.

    ``on_tick(ts, price)`` returns the leg's NEW state (-1 / 0 / +1) on the
    tick that closes a candle, else None. ``state`` holds the last closed
    state (0 during warmup). Pure state, never raises.
    """

    def __init__(
        self,
        source: str = "sma5",          # "sma5" | "ma" (20-EMA)
        candle_sec: int = 120,
        lookback: int = 5,             # candles the slope compares across
        gray_pctile: float = 40.0,     # noise-floor percentile of |slope|
        min_samples: int = 15,         # slopes needed before judging
        min_noise_pct: float = 0.002,  # absolute floor under the percentile
    ) -> None:
        self.source = source
        self.candle_sec = max(1, int(candle_sec))
        self.lookback = max(1, int(lookback))
        self.gray_pctile = min(90.0, max(10.0, float(gray_pctile)))
        self.min_samples = max(5, int(min_samples))
        self.min_noise_pct = max(0.0, float(min_noise_pct))
        self.reset()

    def reset(self) -> None:
        """Fresh contract / timeframe: drop candles, line, noise history."""
        self._bucket: int | None = None
        self._close = 0.0
        self._ema: float | None = None
        self._n_closes = 0
        self._line: deque[float | None] = deque(maxlen=self.lookback + 1)
        self._closes5: deque[float] = deque(maxlen=5)
        self._abs_hist: list[float] = []
        self.state: int = 0
        self.last_pct: float | None = None
        self.last_ltp: float | None = None
        # T169-B — the last CLOSED candle's line value + its bucket, so the engine
        # can push the authoritative line to the chart (set in _close_candle).
        self.last_line: float | None = None
        self.last_close: float = 0.0
        self.last_bucket: int | None = None

    def set_candle_sec(self, sec: int) -> None:
        sec = max(1, int(sec))
        if sec == self.candle_sec:
            return
        self.candle_sec = sec
        self.reset()

    def set_gray_pctile(self, pctile: float) -> None:
        """Live noise-floor percentile change — applies at the next candle
        close (the |slope| history stays valid, only the cut moves).
        0 (or below) = BINARY mode: no gray, sign-of-slope only."""
        p = float(pctile)
        self.gray_pctile = 0.0 if p <= 0 else min(90.0, max(10.0, p))

    def set_lookback(self, lookback: int) -> bool:
        """Live slope-lookback change. The line window AND the |slope| history
        are lookback-scaled, so the leg resets — the caller re-warms it from
        the feed's history. Returns True when it actually changed."""
        lookback = max(1, int(lookback))
        if lookback == self.lookback:
            return False
        self.lookback = lookback
        self.reset()
        return True

    def on_tick(self, ts: float, price: float) -> int | None:
        if not (math.isfinite(ts) and math.isfinite(price) and price > 0):
            return None
        self.last_ltp = price
        bucket = int(ts // self.candle_sec)
        if self._bucket is None:
            self._bucket = bucket
            self._close = price
            return None
        if bucket == self._bucket:
            self._close = price
            return None
        st = self._close_candle()
        self._bucket = bucket
        self._close = price
        return st

    def _close_candle(self) -> int:
        close = self._close
        self._n_closes += 1

        # The smoothing line (chart parity: 20-EMA with 5-candle warmup, or
        # the plain 5-SMA of closes).
        line: float | None
        if self.source == "ma":
            k = 2.0 / 21.0
            self._ema = close if self._ema is None else close * k + self._ema * (1.0 - k)
            line = self._ema if self._n_closes > 5 else None
        else:
            self._closes5.append(close)
            line = (
                sum(self._closes5) / len(self._closes5)
                if len(self._closes5) >= 5 else None
            )
        self._line.append(line)

        # T169-B — remember this closed candle's line so the engine can push the
        # authoritative value to the chart (bucket is still the CLOSING one here;
        # on_tick advances it after this returns). Line is None during warmup.
        self.last_line = line
        self.last_close = close
        self.last_bucket = self._bucket

        # Slope over the lookback + the causal noise floor.
        if (
            len(self._line) <= self.lookback
            or line is None
            or self._line[0] is None
            or not (self._line[0] > 0)
        ):
            self.state = 0
            self.last_pct = None
            return 0
        pct = (line - self._line[0]) / self._line[0] * 100.0
        self.last_pct = pct
        # BINARY mode (gray_pctile <= 0, Partha 2026-08-14: SMA5 line has no
        # gray — only green and red): state is the SIGN of the slope, no noise
        # floor, no sample warm-up. An exactly-flat line keeps the prior state.
        if self.gray_pctile <= 0:
            self.state = 1 if pct > 0 else -1 if pct < 0 else self.state
            return self.state
        self._abs_hist.append(abs(pct))
        if len(self._abs_hist) < self.min_samples:
            self.state = 0
            return 0
        srt = sorted(self._abs_hist)
        idx = min(len(srt) - 1, int(len(srt) * self.gray_pctile / 100.0))
        noise = max(srt[idx], self.min_noise_pct)
        self.state = 1 if pct > noise else -1 if pct < -noise else 0
        return self.state


class PremiumRibbonDetector:
    """Two RibbonLegs (locked CE + locked PE) → LONG/EXIT events.

    ``on_leg_tick(leg, ts, price)`` feeds one premium tick and returns the
    events fired by the candle it may have closed (usually []). Transitions:
    into UP → LONG_<leg>; LEAVING UP (gray or down at a candle close) →
    EXIT_<leg> (Partha 2026-08-13: "sideways gray formed → fire the exit";
    set ``exit_on_gray=False`` for the original hold-through-gray rule, where
    only a DOWN turn exits). Gray never ENTERS either way. ``warm(leg,
    ticks)`` replays history WITHOUT emitting, so a freshly-started engine
    doesn't fire on the past.
    """

    def __init__(
        self,
        source: str,
        candle_sec: int = 120,
        lookback: int = 5,
        gray_pctile: float = 40.0,
        min_samples: int = 15,
        min_noise_pct: float = 0.002,
        exit_on_gray: bool = True,
    ) -> None:
        self.source = source
        self.exit_on_gray = bool(exit_on_gray)
        mk: Callable[[], RibbonLeg] = lambda: RibbonLeg(
            source, candle_sec, lookback, gray_pctile, min_samples, min_noise_pct,
        )
        self._legs = {"CE": mk(), "PE": mk()}
        # T169-B — closed-candle line samples pending push to the chart:
        # (leg, t_epoch, line, state, close). Filled in on_leg_tick, drained by
        # the engine each loop.
        self.closed_samples: list[tuple[str, int, float, int, float]] = []

    def leg(self, leg: str) -> RibbonLeg:
        return self._legs[leg]

    def set_candle_sec(self, sec: int) -> None:
        for leg_state in self._legs.values():
            leg_state.set_candle_sec(sec)

    def set_gray_pctile(self, pctile: float) -> None:
        for leg_state in self._legs.values():
            leg_state.set_gray_pctile(pctile)

    def set_lookback(self, lookback: int) -> bool:
        """Returns True when the lookback changed (legs were reset — re-warm)."""
        changed = False
        for leg_state in self._legs.values():
            if leg_state.set_lookback(lookback):
                changed = True
        return changed

    def reset_leg(self, leg: str) -> None:
        """Contract changed (mid-day relock) — re-warm on the new one."""
        self._legs[leg].reset()

    def warmup(self) -> dict:
        """Warm-up progress for the liveness heartbeat: the slowest leg's
        noise-floor sample count vs the requirement. ready=True → this
        detector can judge (signals possible). Binary legs (gray<=0) need no
        noise samples — only the line+slope build-up (last_pct exists)."""
        legs = self._legs.values()
        if all(l.gray_pctile <= 0 for l in legs):
            ready = all(l.last_pct is not None for l in legs)
            return {"ready": ready, "samples": 0, "need": 0}
        samples = min(len(l._abs_hist) for l in legs)
        need = max(l.min_samples for l in legs)
        return {"ready": samples >= need, "samples": samples, "need": need}

    def on_leg_tick(self, leg: str, ts: float, price: float) -> list[RibbonEvent]:
        leg_state = self._legs[leg]
        prev = leg_state.state
        st = leg_state.on_tick(ts, price)
        # T169-B — a candle closed (st is not None) → queue its line for the chart,
        # even when the state didn't change (the line still moves). Warmup candles
        # (line None) are skipped. Independent of the event logic below.
        if st is not None and leg_state.last_line is not None and leg_state.last_bucket is not None:
            self.closed_samples.append((
                leg,
                int(leg_state.last_bucket) * int(leg_state.candle_sec),
                float(leg_state.last_line),
                int(leg_state.state),
                float(leg_state.last_close),
            ))
        if st is None or st == prev:
            return []
        if st == 1:
            return [f"LONG_{leg}"]
        if self.exit_on_gray:
            # Exit the moment the ribbon LEAVES UP — a gray candle close ends
            # the ride, it doesn't hold it. (No exit on gray↔down shuffles
            # while already out.)
            return [f"EXIT_{leg}"] if prev == 1 else []
        if st == -1:
            return [f"EXIT_{leg}"]
        return []  # gray — hold, never enter (legacy rule)

    def warm(self, leg: str, ticks: list[tuple[float, float]]) -> None:
        """Replay history silently: state ends where the past leaves it, so
        only NEW transitions (after the warm-up) fire signals."""
        leg_state = self._legs[leg]
        for ts, price in ticks:
            leg_state.on_tick(ts, price)
        # T169-B — warm-up must NOT push history to the chart (that would spam the
        # store with the whole session every restart); drop anything queued while
        # replaying the past. Live ticks (on_leg_tick) queue as normal after this.
        self.closed_samples.clear()

    def drain_closed(self) -> list[tuple[str, int, float, int, float]]:
        """T169-B — pull + clear the queued closed-candle line samples
        (leg, t_epoch, line, state, close) for the engine to push to the chart."""
        out = self.closed_samples
        self.closed_samples = []
        return out


class LockedPremiumFeed:
    """Daemon poller of the server's locked-contract premium ticks.

    Polls GET /api/sea/locked-premiums?instrument=… every ``poll_sec``. The
    FIRST batch per contract carries the whole session (live=False → the
    engine warms detectors silently); later batches are incremental
    (live=True → events fire). A securityId change (mid-day relock) yields a
    reset batch, then the new contract's full history as another warm batch.

    ``drain()`` (engine thread) returns the queued batches:
        (leg, reset, live, [(ts, ltp), …])
    Never raises out of the thread; connection errors just retry next poll.
    """

    def __init__(self, instrument: str, poll_sec: float = 6.0) -> None:
        self.instrument = instrument
        self.poll_sec = max(2.0, float(poll_sec))
        self._q: deque[tuple[str, bool, bool, list[tuple[float, float]]]] = deque()
        self._mu = threading.Lock()
        self._stop = threading.Event()
        self._since = {"CE": 0.0, "PE": 0.0}
        self._sec_ids: dict[str, str | None] = {"CE": None, "PE": None}
        self.strikes: dict[str, float | None] = {"CE": None, "PE": None}
        self.last_ltp: dict[str, float | None] = {"CE": None, "PE": None}
        self.lock_seen = False
        # T169-B — the lock's DATE (today live, or the replayed date in a live
        # simulation), so the pushed chart line lands under the day the chart shows.
        self.date: str | None = None
        self._thread: threading.Thread | None = None

    # ── lifecycle ────────────────────────────────────────────────────
    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._loop, name=f"sea-premium-feed-{self.instrument}", daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    # ── engine side ──────────────────────────────────────────────────
    def sec_id(self, leg: str) -> str | None:
        """T169-B — the locked contract's securityId for a leg (CE/PE), so a
        pushed chart line can be keyed to the pane showing that contract."""
        return self._sec_ids.get(leg)

    def drain(self) -> list[tuple[str, bool, bool, list[tuple[float, float]]]]:
        with self._mu:
            out = list(self._q)
            self._q.clear()
        return out

    def rewarm(self) -> None:
        """Force a full re-fetch of both legs' history as WARM batches (used
        after a detector-knob change resets the ribbon legs). The next poll
        returns the whole session; events fire only on ticks after that."""
        with self._mu:
            for leg in ("CE", "PE"):
                self._sec_ids[leg] = None
                self._since[leg] = 0.0
            self._q.clear()

    # ── poller thread ────────────────────────────────────────────────
    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._poll_once()
            except Exception:
                pass  # server hiccup — next poll retries
            if self._stop.wait(self.poll_sec):
                break

    def _poll_once(self) -> None:
        import requests
        from signal_engine_agent.risk_control_client import _broker_url, _headers

        url = f"{_broker_url()}/api/sea/locked-premiums"
        params = {
            "instrument": self.instrument,
            "sinceCe": f"{self._since['CE']:.3f}",
            "sincePe": f"{self._since['PE']:.3f}",
        }
        resp = requests.get(url, params=params, headers=_headers(), timeout=8.0)
        if resp.status_code >= 400:
            return
        body = resp.json()
        if not body.get("success") or not body.get("lock"):
            return
        self.lock_seen = True
        self.date = str((body.get("lock") or {}).get("date") or self.date or "") or None
        for leg, key in (("CE", "ce"), ("PE", "pe")):
            d = body.get(key)
            if not d:
                continue
            sid = str(d.get("securityId") or "")
            if not sid:
                continue
            prev_sid = self._sec_ids[leg]
            if prev_sid is not None and sid != prev_sid:
                # Contract changed (mid-day relock, or the server switched
                # to/from a live-simulation) → reset the leg and re-fetch from
                # scratch on the NEXT poll (this batch was sliced against the
                # old since). Leaving _sec_ids as None makes that next full
                # fetch a WARM batch — history must never fire events.
                self._sec_ids[leg] = None
                self.strikes[leg] = d.get("strike")
                self._since[leg] = 0.0
                with self._mu:
                    self._q.append((leg, True, False, []))
                continue
            first = prev_sid is None
            self._sec_ids[leg] = sid
            self.strikes[leg] = d.get("strike")
            t = d.get("t") or []
            ltp = d.get("ltp") or []
            n = min(len(t), len(ltp))
            if n == 0:
                continue
            ticks = [(float(t[i]), float(ltp[i])) for i in range(n)]
            self._since[leg] = ticks[-1][0]
            self.last_ltp[leg] = ticks[-1][1]
            with self._mu:
                # First fetch of a contract = warm-up history (live=False).
                self._q.append((leg, False, not first, ticks))
