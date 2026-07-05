"""
signal_engine_agent/signal_dashboard.py — Live SEA runtime dashboard (2026-07-01).

Parallels the Replay-runner's ProgressDashboard: rich-based alt-screen, live
updating, ESC-to-stop friendly. Replaces the pre-2026-07-01 scrolling-print
runtime output with a fixed 4-panel view:

    SEA — nifty50 — model 20260620_235104 — gate wave2     started 09:14:22 IST
    Feed  ●LIVE   1,247,832 ticks   last @ 14:52:31.442   feed lag 0.4s

    GATE   prob>=0.62  RR>=1.5  pctile>=60  persists60s>=0.55  exit60s<0.35
    TREND  dir>=0.60   cont>=0.55  brk>=0.0   scale 0.5   cooldown 600s

    Signals fired today          Last predictions (tick @ 14:52:31)
    -----------------            ---------------------------------
    GO_CALL   scalp    12        prob_up_60s     0.58  X (<0.62)
    GO_PUT    scalp     8        rr              1.32  X (<1.5)
    GO_CALL   trend     3        upside_pctile     72  OK
    GO_PUT    trend     4        exit_signal_60s 0.11  OK
                       --        trend_dir_1800s 0.71  OK -- TREND OK
    Total              27        magnitude       0.42  OK

    Recent signals                                             tick->fire
    --------------                                             ----------
    14:51:03.221  GO_CALL scalp NIFTY-27000-CE  RR 1.8  0.71    Delta 287ms
    14:47:22.108  GO_PUT  trend NIFTY-26800-PE  RR 2.1  0.64    Delta 341ms
    14:39:11.884  GO_CALL trend NIFTY-27100-CE  RR 1.6  0.68    Delta 402ms

    PASSED 27    REJECTED (scalp) 41,283 : C1 28,914 . C2 9,144 . C3 3,225
                 REJECTED (trend) 43,197 : dir 22,113 . cont 19,004 . brk 2,080
    tick->fire   median 312ms   p95 680ms                        (Esc to stop)

Thread model:
  - Engine calls push_tick / push_signal / push_reject from its main tick loop.
  - A daemon "sea-dashboard" thread re-renders every ~200 ms using a snapshot
    of the shared state (protected by a Lock so mid-render mutations don't tear).
  - Rich's alt-screen (screen=True) keeps the display isolated from any late
    stderr prints (e.g. T41 log_eval errors) that would otherwise scramble
    the frame.

Latency semantics:
  - "tick" timestamp = row["timestamp"] (broker ltt in Unix epoch seconds,
    verified 2026-07-01 against nifty50_live.ndjson). Measures the full
    pipeline: broker WebSocket -> TFA feature emit -> SEA tail read ->
    predict -> gate -> signal write. NOT just SEA-side latency.
  - "fire" timestamp = time.time() at the moment SignalLogger.log is called.
  - median / p95 are computed over the most recent 500 emitted signals.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from rich.console import Console, Group
from rich.rule import Rule
from rich.table import Table
from rich.text import Text

try:
    from rich.live import Live
    _RICH_LIVE_AVAILABLE = True
except ImportError:  # pragma: no cover - rich is a hard dep
    _RICH_LIVE_AVAILABLE = False

_IST = timezone(timedelta(hours=5, minutes=30))

_MAX_RECENT_SIGNALS = 10
_LATENCY_WINDOW = 500
_STALE_FEED_SEC = 5.0  # if last tick older than this, feed marked STALE


@dataclass
class _GateConfig:
    """Snapshot of gate thresholds shown in the header panel."""
    mode: str = ""
    prob_min: float = 0.0
    rr_min: float = 0.0
    pctile_min: float = 0.0
    persists_60s_min: float = 0.0
    exit_signal_60s_max: float = 0.0


@dataclass
class _TrendConfig:
    enabled: bool = False
    dir_prob_min: float = 0.0
    continues_min: float = 0.0
    breakout_min: float = 0.0
    magnitude_scale: float = 0.0
    min_seconds_between_signals: int = 0


@dataclass
class _RecentSignal:
    """One entry in the Recent-signals panel."""
    wall_ts: float
    action: str
    cohort: str
    security: str
    rr: float
    prob: float
    latency_ms: float


@dataclass
class _State:
    """All dashboard state, guarded by SignalDashboard._lock."""
    # Header
    instrument: str = ""
    model_version: str = ""
    feature_count: int = 0
    scalp: _GateConfig = field(default_factory=_GateConfig)
    trend: _TrendConfig = field(default_factory=_TrendConfig)
    started_wall: datetime = field(default_factory=lambda: datetime.now(_IST))
    started_monotonic: float = field(default_factory=time.monotonic)

    # Feed state
    ticks_processed: int = 0
    last_tick_ts: float = 0.0             # broker ltt of last row consumed
    last_tick_wall_ts: float = 0.0        # wall clock when we consumed it

    # Emission counters
    scalp_call: int = 0
    scalp_put: int = 0
    trend_call: int = 0
    trend_put: int = 0

    # Reject counters (by cohort -> reason -> count)
    scalp_rejects_total: int = 0
    trend_rejects_total: int = 0
    scalp_reject_by_reason: dict[str, int] = field(default_factory=dict)
    trend_reject_by_reason: dict[str, int] = field(default_factory=dict)

    # Last-tick predictions (for the right-side "Last predictions" panel)
    last_preds: dict[str, Any] = field(default_factory=dict)
    last_preds_pass: dict[str, bool] = field(default_factory=dict)

    # Recent signals (bounded)
    recent: deque = field(default_factory=lambda: deque(maxlen=_MAX_RECENT_SIGNALS))

    # Latency window (bounded, ms)
    latencies_ms: deque = field(default_factory=lambda: deque(maxlen=_LATENCY_WINDOW))


def _fmt_int(n: int) -> str:
    return f"{n:>7,}"


def _fmt_hms(seconds: float) -> str:
    s = int(max(0, seconds))
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


def _fmt_ms(ms: float) -> str:
    if ms < 0 or ms != ms:  # NaN
        return "   ---"
    if ms >= 10_000:
        return f"{ms / 1000:>4.1f}s"
    return f"{ms:>5.0f}ms"


def _percentile(sorted_vals: list[float], q: float) -> float:
    """Simple nearest-rank percentile — good enough for a status display."""
    if not sorted_vals:
        return 0.0
    k = max(0, min(len(sorted_vals) - 1, int(round(q * (len(sorted_vals) - 1)))))
    return sorted_vals[k]


class SignalDashboard:
    """Rich live dashboard for the SEA runtime.

    Usage::

        with SignalDashboard(instrument, model_version, ...) as dash:
            dash.set_gate_config(scalp=..., trend=...)
            for row in tick_stream:
                # ... predict + gate ...
                dash.push_tick(row_ts=row['timestamp'], preds=preds, pass_map=...)
                if emitted:
                    dash.push_signal(signal, latency_ms=...)
                if rejected:
                    dash.push_reject(cohort='scalp', reasons=[...])

    The dashboard is thread-safe (single lock around all state), never
    blocks the engine's tick loop, and swallows all rendering exceptions
    so a rich glitch can't kill inference.
    """

    def __init__(
        self,
        instrument: str,
        model_version: str,
        feature_count: int,
        refresh_hz: float = 5.0,
    ) -> None:
        self._state = _State(
            instrument=instrument,
            model_version=model_version,
            feature_count=feature_count,
        )
        self._lock = threading.Lock()
        self._refresh_interval = 1.0 / max(refresh_hz, 1.0)
        # force_terminal=True: rich sometimes mis-detects .bat-wrapped
        # PowerShell as a non-TTY and falls back to per-frame append,
        # stacking historical frames in scrollback (same bug the Replay
        # dashboard hit on 2026-05-25).
        self._console = Console(force_terminal=True)
        self._live: Live | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ── public API ──────────────────────────────────────────────────────────

    def __enter__(self) -> "SignalDashboard":
        if not _RICH_LIVE_AVAILABLE:  # pragma: no cover
            return self
        self._live = Live(
            self._render(),
            console=self._console,
            refresh_per_second=int(1.0 / self._refresh_interval),
            transient=False,
            auto_refresh=False,
            screen=True,
        )
        self._live.__enter__()
        self._thread = threading.Thread(
            target=self._refresh_loop, name="sea-dashboard", daemon=True,
        )
        self._thread.start()
        return self

    def __exit__(self, *exc_info) -> bool:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        try:
            if self._live is not None:
                final = self._render()
                self._live.update(final, refresh=True)
                self._live.__exit__(*exc_info)
                # Print the final frame on the primary screen so the
                # last-known state stays visible after the alt-screen
                # tears down (mirrors ProgressDashboard's tear-down
                # policy — the operator can eyeball final counts before
                # closing the cmd window).
                self._console.print(final)
        except Exception:
            pass
        return False

    def set_gate_config(
        self,
        *,
        mode: str,
        prob_min: float,
        rr_min: float,
        pctile_min: float,
        persists_60s_min: float = 0.0,
        exit_signal_60s_max: float = 0.0,
        trend_enabled: bool = False,
        trend_dir_prob_min: float = 0.0,
        trend_continues_min: float = 0.0,
        trend_breakout_min: float = 0.0,
        trend_magnitude_scale: float = 0.0,
        trend_cooldown_sec: int = 0,
    ) -> None:
        with self._lock:
            self._state.scalp = _GateConfig(
                mode=mode, prob_min=prob_min, rr_min=rr_min,
                pctile_min=pctile_min,
                persists_60s_min=persists_60s_min,
                exit_signal_60s_max=exit_signal_60s_max,
            )
            self._state.trend = _TrendConfig(
                enabled=trend_enabled,
                dir_prob_min=trend_dir_prob_min,
                continues_min=trend_continues_min,
                breakout_min=trend_breakout_min,
                magnitude_scale=trend_magnitude_scale,
                min_seconds_between_signals=trend_cooldown_sec,
            )

    def push_tick(
        self,
        *,
        row_ts: float,
        preds: dict[str, Any] | None = None,
        pass_map: dict[str, bool] | None = None,
    ) -> None:
        """Record a tick. `row_ts` is the broker ltt (Unix epoch sec)."""
        with self._lock:
            self._state.ticks_processed += 1
            self._state.last_tick_ts = float(row_ts) if row_ts else 0.0
            self._state.last_tick_wall_ts = time.time()
            if preds is not None:
                # Extract a few "at-a-glance" values -- avoid holding a
                # ref to the full preds dict (may contain many megabytes
                # of head predictions).
                self._state.last_preds = {
                    "prob_up_60s": preds.get("direction_prob_60s"),
                    "rr": preds.get("risk_reward_ratio_60s"),
                    "upside_pctile": preds.get("upside_percentile_60s")
                    or preds.get("upside_percentile_30s"),
                    "exit_signal_60s": preds.get("exit_signal_60s"),
                    "trend_dir_1800s": preds.get("trend_direction_1800s"),
                    # Part B down head — makes the PUT-side trend conviction as
                    # visible as the call side (both-direction signals).
                    "trend_dir_down_1800s": preds.get("trend_direction_down_1800s"),
                    "magnitude": preds.get("trend_magnitude_1800s")
                    or preds.get("max_upside_30s"),
                }
                self._state.last_preds_pass = dict(pass_map or {})

    def push_signal(
        self,
        *,
        signal: dict[str, Any],
        latency_ms: float,
    ) -> None:
        """Record an emitted signal."""
        cohort = str(signal.get("cohort", "scalp"))
        direction = str(signal.get("direction", "GO_CALL"))
        with self._lock:
            if cohort == "trend":
                if direction == "GO_CALL":
                    self._state.trend_call += 1
                else:
                    self._state.trend_put += 1
            else:
                if direction == "GO_CALL":
                    self._state.scalp_call += 1
                else:
                    self._state.scalp_put += 1
            self._state.latencies_ms.append(float(latency_ms))
            self._state.recent.appendleft(_RecentSignal(
                wall_ts=time.time(),
                action=str(signal.get("action", "")),
                cohort=cohort,
                security=str(signal.get("atm_ce_security_id"))
                    if direction == "GO_CALL"
                    else str(signal.get("atm_pe_security_id")),
                rr=float(signal.get("rr") or 0.0),
                prob=float(signal.get("direction_prob_30s")
                           or signal.get("trend_dir_prob_1800s") or 0.0),
                latency_ms=float(latency_ms),
            ))

    def push_reject(self, *, cohort: str, reasons: list[str]) -> None:
        """Record a gate rejection. `reasons` is the list from gate_reasons."""
        if not reasons:
            return
        with self._lock:
            if cohort == "trend":
                self._state.trend_rejects_total += 1
                bucket = self._state.trend_reject_by_reason
            else:
                self._state.scalp_rejects_total += 1
                bucket = self._state.scalp_reject_by_reason
            for r in reasons:
                # Canonicalise the reason to its short code (e.g. "C1",
                # "dir", "cont") -- take the first token before "_"
                # since gate codes look like "C1_prob_low" / "dir_below".
                short = r.split("_")[0] if "_" in r else r
                bucket[short] = bucket.get(short, 0) + 1

    # ── internal ────────────────────────────────────────────────────────────

    def _refresh_loop(self) -> None:
        while not self._stop.is_set():
            try:
                if self._live is not None:
                    self._live.update(self._render(), refresh=True)
            except Exception:
                # Never let a render glitch kill the engine.
                pass
            self._stop.wait(self._refresh_interval)

    def _render(self) -> Group:
        with self._lock:
            snap = _snapshot(self._state)

        # ── Header ─────────────────────────────────────────────────────────
        started_str = snap["started_wall"].strftime("%H:%M:%S IST")
        elapsed_str = _fmt_hms(time.monotonic() - snap["started_monotonic"])
        header = Text.assemble(
            (" SEA ", "bold cyan"),
            "— ",
            (snap["instrument"], "bold"),
            " — model ",
            (snap["model_version"] or "(none)", "dim"),
            " — gate ",
            (snap["scalp_mode"] or "(none)", "yellow"),
            "     ",
            f"started {started_str}   elapsed {elapsed_str}",
        )

        # Feed liveness
        feed_lag = time.time() - snap["last_tick_wall_ts"] if snap["last_tick_wall_ts"] else -1
        if snap["last_tick_wall_ts"] == 0:
            feed_style, feed_label = "dim", "●IDLE"
        elif feed_lag > _STALE_FEED_SEC:
            feed_style, feed_label = "red", "●STALE"
        else:
            feed_style, feed_label = "green", "●LIVE"
        last_tick_str = (
            datetime.fromtimestamp(snap["last_tick_ts"], _IST).strftime("%H:%M:%S.%f")[:-3]
            if snap["last_tick_ts"] else "--:--:--"
        )
        feed_line = Text.assemble(
            " Feed  ",
            (feed_label, f"bold {feed_style}"),
            "   ",
            (f"{snap['ticks_processed']:,} ticks", "cyan"),
            "   last @ ",
            (last_tick_str, "dim"),
            "   feed lag ",
            (f"{feed_lag:.1f}s" if feed_lag >= 0 else "--", feed_style),
        )

        # ── Gate config lines ──────────────────────────────────────────────
        s = snap["scalp"]
        gate_line = Text.assemble(
            " GATE   ",
            (f"prob≥{s.prob_min:.2f}  ", "dim"),
            (f"RR≥{s.rr_min:.2f}  ", "dim"),
            (f"pctile≥{s.pctile_min:.0f}  ", "dim"),
            (f"persists60s≥{s.persists_60s_min:.2f}  ", "dim"),
            (f"exit60s<{s.exit_signal_60s_max:.2f}", "dim"),
        )
        t = snap["trend"]
        if t.enabled:
            trend_line = Text.assemble(
                " TREND  ",
                (f"dir≥{t.dir_prob_min:.2f}   ", "dim"),
                (f"cont≥{t.continues_min:.2f}  ", "dim"),
                (f"brk≥{t.breakout_min:.2f}   ", "dim"),
                (f"scale {t.magnitude_scale:.2f}   ", "dim"),
                (f"cooldown {t.min_seconds_between_signals}s", "dim"),
            )
        else:
            trend_line = Text(" TREND  disabled", style="dim")

        # ── Counters (left) + last predictions (right) ─────────────────────
        counters = Table.grid(padding=(0, 2))
        counters.add_column(justify="left", style="bold")
        counters.add_column(justify="left")
        counters.add_column(justify="right", style="cyan")
        counters.add_row(Text("Signals fired today", style="bold"), "", "")
        counters.add_row(Text("─────────────────", style="dim"), "", "")
        counters.add_row("GO_CALL", "scalp", _fmt_int(snap["scalp_call"]))
        counters.add_row("GO_PUT ", "scalp", _fmt_int(snap["scalp_put"]))
        counters.add_row("GO_CALL", "trend", _fmt_int(snap["trend_call"]))
        counters.add_row("GO_PUT ", "trend", _fmt_int(snap["trend_put"]))
        total = (
            snap["scalp_call"] + snap["scalp_put"]
            + snap["trend_call"] + snap["trend_put"]
        )
        counters.add_row("", "", Text("─────", style="dim"))
        counters.add_row("Total", "", Text(_fmt_int(total), style="bold green"))

        preds_tbl = Table.grid(padding=(0, 1))
        preds_tbl.add_column(justify="left")
        preds_tbl.add_column(justify="right", style="cyan")
        preds_tbl.add_column(justify="left")
        preds_tbl.add_row(Text("Last predictions", style="bold"), "", "")
        preds_tbl.add_row(Text("─────────────────", style="dim"), "", "")
        for label, key, threshold, cmp in [
            ("prob_up_60s",     "prob_up_60s",     s.prob_min,               "ge"),
            ("rr",              "rr",              s.rr_min,                 "ge"),
            ("upside_pctile",   "upside_pctile",   s.pctile_min,             "ge"),
            ("exit_signal_60s", "exit_signal_60s", s.exit_signal_60s_max,    "lt"),
            ("trend_dir_1800s", "trend_dir_1800s", t.dir_prob_min,           "ge"),
            ("trend_dn_1800s",  "trend_dir_down_1800s", t.dir_prob_min,      "ge"),
            ("magnitude",       "magnitude",       0.0,                      "any"),
        ]:
            v = snap["last_preds"].get(key)
            if v is None:
                preds_tbl.add_row(label, Text("—", style="dim"), "")
                continue
            try:
                vf = float(v)
            except (TypeError, ValueError):
                preds_tbl.add_row(label, Text("—", style="dim"), "")
                continue
            val_str = f"{vf:.2f}" if abs(vf) < 100 else f"{vf:,.0f}"
            if cmp == "ge":
                ok = vf >= threshold
            elif cmp == "lt":
                ok = vf < threshold
            else:
                ok = True
            marker = Text("✓", style="green") if ok else Text(
                f"✗ (thr {threshold:.2f})", style="red",
            )
            preds_tbl.add_row(label, val_str, marker)

        middle = Table.grid(padding=(0, 4))
        middle.add_column(); middle.add_column()
        middle.add_row(counters, preds_tbl)

        # ── Recent signals ─────────────────────────────────────────────────
        recent_tbl = Table.grid(padding=(0, 2))
        recent_tbl.add_column(); recent_tbl.add_column(); recent_tbl.add_column()
        recent_tbl.add_column(); recent_tbl.add_column(); recent_tbl.add_column()
        recent_tbl.add_column(justify="right")
        recent_tbl.add_row(
            Text("time", style="bold"),
            Text("action", style="bold"),
            Text("cohort", style="bold"),
            Text("security", style="bold"),
            Text("RR", style="bold"),
            Text("prob", style="bold"),
            Text("tick→fire", style="bold"),
        )
        recent_tbl.add_row(*([Text("─" * 8, style="dim")] * 7))
        if not snap["recent"]:
            recent_tbl.add_row(
                Text("(no signals yet)", style="dim"),
                "", "", "", "", "", "",
            )
        else:
            for rs in snap["recent"]:
                wall = datetime.fromtimestamp(rs.wall_ts, _IST)
                recent_tbl.add_row(
                    wall.strftime("%H:%M:%S.%f")[:-3],
                    Text(rs.action, style="cyan"),
                    rs.cohort,
                    rs.security[:22] if rs.security else "—",
                    f"{rs.rr:.2f}",
                    f"{rs.prob:.2f}",
                    Text(_fmt_ms(rs.latency_ms), style="magenta"),
                )

        # ── Footer: aggregate counters + latency stats ─────────────────────
        scalp_rej = snap["scalp_rejects_total"]
        trend_rej = snap["trend_rejects_total"]
        scalp_breakdown = " · ".join(
            f"{k} {v:,}" for k, v in
            sorted(snap["scalp_reject_by_reason"].items(),
                   key=lambda kv: -kv[1])[:4]
        ) or "—"
        trend_breakdown = " · ".join(
            f"{k} {v:,}" for k, v in
            sorted(snap["trend_reject_by_reason"].items(),
                   key=lambda kv: -kv[1])[:4]
        ) or "—"

        # Latency stats
        lats = sorted(snap["latencies_ms"])
        if lats:
            med = _percentile(lats, 0.5)
            p95 = _percentile(lats, 0.95)
            lat_line = Text.assemble(
                " tick→fire   ",
                (f"median {_fmt_ms(med).strip()}   ", "magenta"),
                (f"p95 {_fmt_ms(p95).strip()}", "magenta"),
                "                        ",
                ("(Esc to stop)", "dim"),
            )
        else:
            lat_line = Text.assemble(
                " tick→fire   ",
                ("median —   p95 —", "dim"),
                "                            ",
                ("(Esc to stop)", "dim"),
            )
        passed = total
        footer1 = Text.assemble(
            (f" PASSED {passed:,}", "bold green"),
            "    ",
            (f"REJECTED (scalp) {scalp_rej:,} : {scalp_breakdown}", "red"),
        )
        footer2 = Text.assemble(
            "              ",
            (f"REJECTED (trend) {trend_rej:,} : {trend_breakdown}", "red"),
        )

        return Group(
            header,
            feed_line,
            Text(""),
            gate_line,
            trend_line,
            Rule(style="dim"),
            middle,
            Rule(style="dim"),
            Text(" Recent signals", style="bold"),
            recent_tbl,
            Rule(style="dim"),
            footer1,
            footer2,
            lat_line,
        )


def _snapshot(state: _State) -> dict[str, Any]:
    """Return a lock-free copy of everything _render needs.

    We copy scalars directly and shallow-copy the mutable containers.
    _RecentSignal is a frozen-ish dataclass so shallow copy is safe.
    """
    return {
        "instrument": state.instrument,
        "model_version": state.model_version,
        "feature_count": state.feature_count,
        "scalp": state.scalp,
        "scalp_mode": state.scalp.mode,
        "trend": state.trend,
        "started_wall": state.started_wall,
        "started_monotonic": state.started_monotonic,
        "ticks_processed": state.ticks_processed,
        "last_tick_ts": state.last_tick_ts,
        "last_tick_wall_ts": state.last_tick_wall_ts,
        "scalp_call": state.scalp_call,
        "scalp_put": state.scalp_put,
        "trend_call": state.trend_call,
        "trend_put": state.trend_put,
        "scalp_rejects_total": state.scalp_rejects_total,
        "trend_rejects_total": state.trend_rejects_total,
        "scalp_reject_by_reason": dict(state.scalp_reject_by_reason),
        "trend_reject_by_reason": dict(state.trend_reject_by_reason),
        "last_preds": dict(state.last_preds),
        "last_preds_pass": dict(state.last_preds_pass),
        "recent": list(state.recent),
        "latencies_ms": list(state.latencies_ms),
    }


__all__ = ["SignalDashboard"]
