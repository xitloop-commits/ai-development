"""
replay/progress_dashboard.py — Multi-worker replay progress dashboard (T47).

Renders a `rich`-based live display while a fan-out replay is running:

    TFA Replay — nifty50 — 16 workers   started 09:42:15 IST
    ──────────────────────────────────────────────────────────────────
    Overall    [████████░░░░░░░░░░] 12 / 30 dates   Elapsed 02:47:30  ETA 04:09:00
    ──────────────────────────────────────────────────────────────────
    2026-04-15 [█████████████░░] 78%  1,250,000 ev  1,420/s  ETA 02:30  chunk 14/18
    2026-04-16 [██████░░░░░░░░░] 41%    690,000 ev  1,510/s  ETA 06:14  chunk  8/19
    ... (one row per active worker)
    ──────────────────────────────────────────────────────────────────
    PASS 8   WARN 1   FAIL 0   SKIP 3        (Ctrl+C to stop)

Per-worker progress is fed via a ``multiprocessing.Manager().dict()`` proxy that
the parent and every replay worker share. Workers write entries like:

    progress_dict[date_str] = {
        "status": "running",          # pending|running|pass|warn|fail|skip
        "event_idx": 1_250_000,
        "total_events_est": 1_600_000,
        "rate": 1420.0,
        "elapsed_seconds": 880.0,
        "chunk_done": 14,
        "chunks_total_est": 18,
    }

The dashboard is a context manager — start it before submitting workers, exit
after the pool drains. Designed to be a no-op safety net if `rich` is missing
(falls back to plain print every few seconds).

Single-date / single-worker replays use the same dashboard (collapses to one
worker row + overall row). The legacy `\\r`-style heartbeat in replay_runner is
suppressed when a progress callback is wired up, so the two displays never
fight for the cursor.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any

from rich.console import Console, Group
from rich.live import Live
from rich.progress import (
    BarColumn,
    Progress,
    TaskProgressColumn,
    TextColumn,
    TimeRemainingColumn,
)
from rich.table import Table
from rich.text import Text

_IST = timezone(timedelta(hours=5, minutes=30))


# Status colors mirror the existing TFA convention (green=ok, yellow=warn, red=fail)
_STATUS_STYLE = {
    "pending": "dim",
    "running": "cyan",
    "pass": "green",
    "warn": "yellow",
    "fail": "red",
    "skip": "dim",
}


def _fmt_hms(seconds: float | None) -> str:
    """Format seconds as HH:MM:SS, or '--:--:--' if None / NaN."""
    if seconds is None or seconds != seconds or seconds < 0:  # noqa: PLR0124
        return "--:--:--"
    s = int(seconds)
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


def _fmt_int(n: int | None) -> str:
    if n is None:
        return "—"
    return f"{n:>11,}"


def _fmt_rate(rate: float | None) -> str:
    if rate is None or rate <= 0:
        return "       —"
    return f"{rate:>7,.0f}/s"


def _fmt_chunk(done: int | None, total: int | None) -> str:
    if not total or total <= 0:
        if done:
            return f"chunk {done}"
        return ""
    if done is None:
        done = 0
    if done > total:
        return f"chunk {done} (est. ~{total})"
    return f"chunk {done:>2}/{total:<2}"


class ProgressDashboard:
    """Rich live dashboard for multi-worker replay.

    Usage::

        with ProgressDashboard(instrument, dates, workers, manager_dict) as dash:
            with ProcessPoolExecutor(max_workers=workers) as pool:
                ...
                for fut in as_completed(futures):
                    verdict = fut.result()
                    dash.mark_terminal(date_str, verdict)
            summary = dash.summary()

    The dashboard owns a background thread that re-renders every 100 ms from
    the manager dict. It never blocks the parent process.
    """

    def __init__(
        self,
        instrument: str,
        dates: list[str],
        workers: int,
        progress_dict: Mapping[str, Any],
        refresh_hz: float = 10.0,
    ) -> None:
        self._instrument = instrument
        self._dates = list(dates)
        self._workers = workers
        self._d = progress_dict
        self._refresh_interval = 1.0 / max(refresh_hz, 1.0)
        # ``force_terminal=True`` makes rich treat stdout as a TTY even when
        # running under a .bat wrapper in PowerShell (where the heuristic
        # otherwise picks the wrong strategy and falls back to per-frame
        # append, stacking ~20 historical frames in the scrollback before
        # painting the live one at the bottom — first seen 2026-05-25).
        self._console = Console(force_terminal=True)
        self._started_monotonic = time.monotonic()
        self._started_wall = datetime.now(_IST)
        self._live: Live | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        # Seed any unseen dates as "pending" so the dict has a baseline.
        for d in self._dates:
            if d not in self._d:
                self._d[d] = {"status": "pending"}

    # ── public API ──────────────────────────────────────────────────────────

    def __enter__(self) -> "ProgressDashboard":
        self._live = Live(
            self._render(),
            console=self._console,
            refresh_per_second=10,
            transient=False,
            auto_refresh=False,
            # Alternate-screen buffer: terminal switches to a "second page"
            # for the dashboard (like vim / htop), so we can redraw cleanly
            # without ever appending to the scrollback. On exit, the original
            # scrollback returns intact. Without this, PowerShell stacked
            # frames; the bottom of the buffer showed the live dashboard,
            # everything above was historical paint debris.
            screen=True,
        )
        self._live.__enter__()
        self._thread = threading.Thread(
            target=self._refresh_loop, name="replay-dashboard", daemon=True
        )
        self._thread.start()
        return self

    def __exit__(self, *exc_info) -> bool:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        try:
            if self._live is not None:
                self._live.update(self._render(), refresh=True)
                self._live.__exit__(*exc_info)
        except Exception:
            pass
        return False

    def mark_terminal(self, date_str: str, verdict: str, reason: str | None = None) -> None:
        """Called by parent when a worker future resolves.

        ``reason`` is for cases where the failure happens at the future
        boundary (e.g. worker process crashed) — run_one_date doesn't get
        a chance to stash anything in that case. Reasons stashed by
        run_one_date itself are already in the dict and preserved here.
        """
        entry = dict(self._d.get(date_str) or {})
        entry["status"] = verdict
        if reason is not None:
            entry["reason"] = reason
        self._d[date_str] = entry

    def summary(self) -> dict[str, int]:
        """Aggregate counts for the final summary line."""
        counts = {"pass": 0, "warn": 0, "fail": 0, "skip": 0, "running": 0, "pending": 0}
        for d in self._dates:
            status = (self._d.get(d) or {}).get("status", "pending")
            counts[status] = counts.get(status, 0) + 1
        return counts

    # ── internal ────────────────────────────────────────────────────────────

    def _refresh_loop(self) -> None:
        while not self._stop.is_set():
            try:
                if self._live is not None:
                    self._live.update(self._render(), refresh=True)
            except Exception:
                # Don't let a rendering glitch kill the worker pool.
                pass
            self._stop.wait(self._refresh_interval)

    def _render(self) -> Group:
        elapsed = time.monotonic() - self._started_monotonic

        # Snapshot the manager dict once per render so we render a consistent
        # frame even if workers update mid-frame.
        snapshot: dict[str, dict[str, Any]] = {}
        for d in self._dates:
            snapshot[d] = dict(self._d.get(d) or {})

        counts = {
            "pass": 0, "warn": 0, "fail": 0, "skip": 0,
            "running": 0, "pending": 0,
        }
        completed_dates = 0
        for d in self._dates:
            status = snapshot[d].get("status", "pending")
            counts[status] = counts.get(status, 0) + 1
            if status in ("pass", "warn", "fail", "skip"):
                completed_dates += 1

        # Aggregate ETA — three signal sources, used in priority order so
        # we keep showing a useful number throughout the run:
        #
        #   1) After at least one date completes, the average completed-date
        #      duration is the most accurate (real CPU + I/O cost). Use it
        #      for the remaining dates.
        #   2) Before any date completes but workers are running with a
        #      measured rate, fall back to per-date ETAs already computed
        #      below. The overall run finishes when the slowest currently-
        #      running worker finishes plus any time taken by pending dates
        #      (which average the running dates' total durations and replay
        #      ``workers`` at a time).
        #   3) If neither is available (no rates yet — workers just spun up),
        #      ETA stays "—".
        agg_eta = None
        if completed_dates > 0:
            avg_per_date = elapsed / completed_dates
            remaining_dates = len(self._dates) - completed_dates
            agg_eta = remaining_dates * avg_per_date
        else:
            # Minimum "still finishing" hint when a running date has
            # overshot its event estimate. Without a floor, ETA would
            # collapse to 00:00 the moment a worker burns past the
            # estimate even though it's still in flush_all / merge /
            # validate (none of which emit progress callbacks). 15s
            # is the rough wall-clock cost of those tail phases on a
            # typical instrument-day; conservative so the operator
            # doesn't think the cmd window is hung.
            _OVERSHOOT_ETA_FLOOR_SEC = 15.0
            running_etas: list[float] = []
            running_full_durations: list[float] = []
            for d in self._dates:
                entry = snapshot[d]
                if entry.get("status") != "running":
                    continue
                ev = entry.get("event_idx") or 0
                total = entry.get("total_events_est") or 0
                rate = entry.get("rate") or 0.0
                if not (total and rate > 0):
                    continue
                remaining_eta = max(0.0, (total - ev) / rate)
                if ev >= total:
                    # Overshoot — estimator was wrong; we can't compute
                    # a meaningful "events remaining" ETA. Floor at the
                    # finalisation cost so Overall doesn't read 00:00.
                    remaining_eta = max(remaining_eta, _OVERSHOOT_ETA_FLOOR_SEC)
                running_etas.append(remaining_eta)
                running_full_durations.append(total / rate)
            if running_etas:
                # Wall-clock finish for the running batch = slowest worker.
                slowest_running_eta = max(running_etas)
                pending_dates_count = counts.get("pending", 0)
                if pending_dates_count > 0 and running_full_durations:
                    avg_full = sum(running_full_durations) / len(running_full_durations)
                    # Pending dates fan out over the worker pool — one
                    # ``avg_full`` per ``self._workers`` of them.
                    batches = -(-pending_dates_count // max(self._workers, 1))
                    pending_eta = batches * avg_full
                else:
                    pending_eta = 0.0
                agg_eta = slowest_running_eta + pending_eta

        # Header
        header_left = Text()
        header_left.append("TFA Replay", style="bold cyan")
        header_left.append("  —  ")
        header_left.append(self._instrument, style="bold")
        header_left.append("  —  ")
        header_left.append(f"{self._workers} worker", style="dim")
        if self._workers != 1:
            header_left.append("s", style="dim")
        header_right = Text(
            f"started {self._started_wall.strftime('%H:%M:%S')} IST",
            style="dim",
        )
        header_tbl = Table.grid(expand=True)
        header_tbl.add_column(justify="left", ratio=1)
        header_tbl.add_column(justify="right", ratio=1)
        header_tbl.add_row(header_left, header_right)

        # Overall progress (one-line table — bar + counters + ETA).
        # The bar fill folds in partial progress from each currently-
        # running date (event_idx / total_events_est, clamped to 1.0)
        # so the operator sees the bar move from the first chunk
        # onwards instead of staying empty until the first date hits
        # a terminal verdict. The counter text below stays integer-
        # completion-only — "0 / 3 dates" is accurate while three
        # workers are still running.
        #
        # CRITICAL UX rule: 100% Overall means "all dates terminal".
        # While ANY date is still in `running` status, the bar caps at
        # 99% — even when every running date's event_idx exceeds its
        # ``total_events_est`` (the estimator under-counts MCX evening
        # sessions; we saw pct=246% in real runs). Without this cap,
        # Overall reads "DONE" while the worker is still in
        # flush_all / _flush_chunk(force=True) / _merge_chunks_to_final
        # / validate — none of which emit progress callbacks.
        running_partial = 0.0
        for d in self._dates:
            entry = snapshot[d]
            if entry.get("status") != "running":
                continue
            ev = entry.get("event_idx") or 0
            total = entry.get("total_events_est") or 0
            if total > 0:
                running_partial += min(1.0, ev / total)
        if self._dates:
            agg_done_pct = (completed_dates + running_partial) / len(self._dates)
            agg_done_pct = min(1.0, agg_done_pct)
            # Cap below 100% while any worker is still running. The
            # 0.99 floor leaves a visible sliver in the bar so the
            # operator sees "almost done, finalising" instead of "done".
            if counts.get("running", 0) > 0:
                agg_done_pct = min(0.99, agg_done_pct)
        else:
            agg_done_pct = 0.0
        agg_bar = self._render_bar(agg_done_pct, width=24)
        overall_tbl = Table.grid(expand=True, padding=(0, 2))
        overall_tbl.add_column(justify="left", min_width=10)
        overall_tbl.add_column(justify="left")
        overall_tbl.add_column(justify="left")
        overall_tbl.add_column(justify="left")
        overall_tbl.add_column(justify="left")
        overall_tbl.add_row(
            Text("Overall", style="bold"),
            agg_bar,
            Text(f"{completed_dates} / {len(self._dates)} dates"),
            Text(f"Elapsed {_fmt_hms(elapsed)}", style="dim"),
            Text(f"ETA {_fmt_hms(agg_eta)}", style="green" if agg_eta is not None else "dim"),
        )

        # Per-date table (show running first, then pending, then finished)
        per_date_tbl = Table.grid(expand=True, padding=(0, 2))
        per_date_tbl.add_column(min_width=10)       # date
        per_date_tbl.add_column()                    # bar
        per_date_tbl.add_column(justify="right")     # %
        per_date_tbl.add_column(justify="right")     # events
        per_date_tbl.add_column(justify="right")     # rate
        per_date_tbl.add_column(justify="right")     # eta
        per_date_tbl.add_column(justify="left")      # chunk / status

        rows_running: list[tuple] = []
        rows_terminal: list[tuple] = []
        rows_pending: list[tuple] = []

        for d in self._dates:
            entry = snapshot[d]
            status = entry.get("status", "pending")
            style = _STATUS_STYLE.get(status, "white")
            if status == "running":
                ev = entry.get("event_idx") or 0
                total = entry.get("total_events_est") or 0
                pct = (ev / total) if total else 0.0
                rate = entry.get("rate") or 0.0
                eta = ((total - ev) / rate) if (total and rate > 0) else None
                phase = entry.get("phase", "running")
                # Overshoot guard — same root cause as the Overall-bar
                # cap above. When ev > total, the worker has burned
                # past its event-count estimate (MCX evening sessions
                # under-estimate by ~2x) and is racing toward
                # flush_all → merge → validate. The post-event-loop
                # phases don't emit progress callbacks, so without a
                # visible marker the row reads "100% ETA 00:00" while
                # the cmd window is still busy for ~10-30s.
                overshoot = bool(total) and ev >= total
                # Tail phases ARE post-event-loop work. When the worker
                # transitions out of the event loop into flush/merge/
                # validate, it emits a phase= callback. The dashboard
                # paints these rows magenta so the operator can spot at
                # a glance "this date has moved past event-loop".
                _TAIL_PHASES = {
                    "flushing", "merging", "merging:concat",
                    "merging:writing", "validating",
                }
                # During the warmup re-feed (resume of a partially-completed
                # date) we visually mark the row so the user knows the
                # "low %" is expected: the worker is re-replaying events
                # it's already saved to chunks, just to rebuild adapter
                # state. Bar paints yellow instead of cyan.
                if phase == "warmup":
                    row_style = "yellow"
                    bar_style = "yellow"
                elif phase in _TAIL_PHASES:
                    row_style = "magenta"
                    bar_style = "magenta"
                else:
                    row_style = style
                    bar_style = "cyan"
                # Cap the per-date bar at the same 0.99 ceiling as
                # Overall so an overshooting date looks visibly
                # almost-done, not done.
                display_pct = min(0.99, pct) if status == "running" else pct
                chunk_text = _fmt_chunk(
                    entry.get("chunk_done"), entry.get("chunks_total_est")
                )
                # Tail-phase rendering. The worker emits phase=
                # "flushing" / "merging" / "merging:concat" /
                # "merging:writing" / "validating" via _emit_phase
                # after the event loop ends, so the dashboard shows
                # MOVEMENT through those ~10-30s tail phases instead
                # of looking frozen at the last in-loop frame.
                if phase == "warmup":
                    chunk_text = (
                        f"warmup re-feed · {chunk_text}" if chunk_text else "warmup re-feed"
                    )
                elif phase == "flushing":
                    n_done = entry.get("chunk_done") or 0
                    n_total = entry.get("chunks_total_est") or 0
                    chunk_text = (
                        f"flushing pending {n_done:,}/{n_total:,} rows..."
                        if n_total else "flushing pending rows..."
                    )
                elif phase == "merging":
                    n_done = entry.get("chunk_done") or 0
                    n_total = entry.get("chunks_total_est") or 0
                    chunk_text = (
                        f"merging chunks {n_done}/{n_total}..."
                        if n_total else "merging chunks..."
                    )
                elif phase == "merging:concat":
                    chunk_text = "concat tables..."
                elif phase == "merging:writing":
                    chunk_text = "writing final parquet..."
                elif phase == "validating":
                    chunk_text = "validating..."
                elif overshoot:
                    # Replace the chunk M/N text with a "finalising"
                    # marker — informs the operator that the event
                    # loop is done and the worker is in the tail
                    # phases (flush_all / merge / validate).
                    chunk_text = "finalising (estimate exceeded)"
                if overshoot:
                    # Floor the per-date ETA to the same "still
                    # finishing" hint used by the Overall ETA so the
                    # row doesn't flash 00:00:00 either.
                    eta = max(eta or 0.0, 15.0)
                # Tail-phase + warmup chunk text needs to be VISIBLE,
                # not dim — that's where the "what's happening right
                # now" signal lives. Default "dim" is fine for normal
                # event-loop "chunk N/M".
                if phase in _TAIL_PHASES:
                    chunk_text_style = "bold magenta"
                elif phase == "warmup":
                    chunk_text_style = "yellow"
                else:
                    chunk_text_style = "dim"
                rows_running.append((
                    Text(d, style=row_style),
                    self._render_bar(display_pct, width=18, filled_style=bar_style),
                    Text(f"{pct * 100:5.1f}%" if total else "  --.-%", style=row_style),
                    Text(_fmt_int(ev), style=row_style),
                    Text(_fmt_rate(rate), style=row_style),
                    Text(_fmt_hms(eta), style="dim" if eta is None else row_style),
                    Text(chunk_text, style=chunk_text_style),
                ))
            elif status == "pending":
                rows_pending.append((
                    Text(d, style="dim"),
                    self._render_bar(0.0, width=18, pending=True),
                    Text("  --.-%", style="dim"),
                    Text("—", style="dim"),
                    Text("       —", style="dim"),
                    Text("--:--:--", style="dim"),
                    Text("queued", style="dim"),
                ))
            else:
                # terminal: pass / warn / fail / skip
                ev = entry.get("event_idx") or 0
                rows_terminal.append((
                    Text(d, style=style),
                    self._render_bar(1.0 if status != "skip" else 0.0, width=18,
                                     filled_style=style),
                    Text(status.upper(), style=f"bold {style}"),
                    Text(_fmt_int(ev) if ev else "—", style="dim"),
                    Text("       —", style="dim"),
                    Text("done" if status != "skip" else "skip", style="dim"),
                    Text("", style="dim"),
                ))

        # Cap the visible pending list so a 250-date run doesn't paint 250
        # rows. Show all running rows, the first few pending, and a summary.
        MAX_PENDING_VISIBLE = 5
        pending_overflow = max(0, len(rows_pending) - MAX_PENDING_VISIBLE)
        visible_rows = rows_running + rows_pending[:MAX_PENDING_VISIBLE]
        for r in visible_rows:
            per_date_tbl.add_row(*r)
        if pending_overflow > 0:
            per_date_tbl.add_row(
                Text(f"…+{pending_overflow}", style="dim"),
                Text("", style="dim"),
                Text("queued", style="dim"),
                Text("—", style="dim"),
                Text("       —", style="dim"),
                Text("--:--:--", style="dim"),
                Text(f"more dates queued", style="dim"),
            )
        # Also show the last 3 terminal rows so user sees recent completions
        if rows_terminal:
            per_date_tbl.add_row(*([Text("─" * 9, style="dim")] * 7))
            for r in rows_terminal[-3:]:
                per_date_tbl.add_row(*r)

        # Warnings & errors block — one row per date that finished with
        # a non-PASS verdict AND has a reason recorded. Reasons come from
        # the validator's non-PASS checks (most common) or worker / stream
        # exception messages. Source of truth lives in the validation JSON
        # at data/validation/<date>/<inst>_validation.json — this is just
        # a triage glance.
        warn_err_lines: list[Text] = []
        for d in self._dates:
            entry = snapshot[d]
            status = entry.get("status", "pending")
            reason = entry.get("reason")
            if status not in ("warn", "fail") or not reason:
                continue
            icon = "⚠" if status == "warn" else "✗"
            row_style = "yellow" if status == "warn" else "red"
            line = Text()
            line.append(f"  {icon} ", style=row_style)
            line.append(f"{d}  ", style=row_style)
            line.append(f"{status.upper():<4}  ", style=f"bold {row_style}")
            line.append(str(reason), style="white")
            warn_err_lines.append(line)

        # Tally
        tally = Text()
        tally.append(f"PASS {counts['pass']}", style="bold green")
        tally.append("   ")
        tally.append(f"WARN {counts['warn']}", style="bold yellow")
        tally.append("   ")
        tally.append(f"FAIL {counts['fail']}", style="bold red")
        tally.append("   ")
        tally.append(f"SKIP {counts['skip']}", style="dim")
        if counts["running"]:
            tally.append("   ")
            tally.append(f"RUNNING {counts['running']}", style="bold cyan")
        if counts["pending"]:
            tally.append("   ")
            tally.append(f"PENDING {counts['pending']}", style="dim")
        tally.append("        ")
        tally.append("(Ctrl+C to stop)", style="dim")

        rule = Text("─" * 72, style="dim")
        renderables: list = [
            header_tbl, rule, overall_tbl, rule, per_date_tbl, rule,
        ]
        if warn_err_lines:
            header_we = Text("Warnings & errors", style="bold yellow")
            renderables.append(header_we)
            renderables.extend(warn_err_lines)
            renderables.append(rule)
        renderables.append(tally)
        return Group(*renderables)

    def _render_bar(
        self,
        fraction: float,
        width: int = 20,
        pending: bool = False,
        filled_style: str = "cyan",
    ) -> Text:
        fraction = max(0.0, min(1.0, fraction))
        filled = int(round(fraction * width))
        # Guarantee a visible empty sliver whenever fraction is strictly
        # below 1.0 — otherwise rounding turns 0.99 × 24 = 23.76 into
        # 24 filled cells, hiding the "not quite done" signal that
        # callers use the sub-1.0 cap to convey (see Overall-bar
        # while-running cap above).
        if fraction < 1.0 and filled >= width:
            filled = width - 1
        empty = width - filled
        bar = Text()
        bar.append("[")
        if pending:
            bar.append("░" * width, style="dim")
        else:
            bar.append("█" * filled, style=filled_style)
            bar.append("░" * empty, style="dim")
        bar.append("]")
        return bar
