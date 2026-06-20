"""
training_dashboard.py — Rich progress dashboard for trainer (Phase 1a, 2026-06-20).

Replaces the trainer's old "print one line per head fit" console output with
the same alt-screen style the replay dashboard uses. One instrument per run
(Phase 1a); Phase 1b will wrap this in a ProcessPoolExecutor for multi-instrument
fan-out.

Visible elements:

    Train  nifty50  (NSE)  ·  14 dates  ·  84 heads  ·  359 features
    ─────────────────────────────────────────────────────────────
    Overall    [██████████░░░░░░░░░░] 45 / 84 heads   Elapsed 00:23:14  ETA 00:18:42
    ─────────────────────────────────────────────────────────────
    Current    direction_60s  (binary)
    Last       direction_30s    val_auc = 0.612    n_train=180,210  n_val=70,800
    Best so far direction_30s   val_auc = 0.612
    ─────────────────────────────────────────────────────────────
    PASS 44   SKIPPED 1   FAIL 0                        (Esc to stop)
    ⚠  Press Esc AGAIN within 3 seconds to STOP training. Any other key to continue.

Mid-fit (inside one head) the dashboard doesn't tick because LightGBM doesn't
expose its iteration count cleanly. Each head's ETA is bounded by recent
heads' wall-time so the bar advances at completion only -- ~10-60 sec per
head depending on the head's complexity.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from rich.console import Console, Group
from rich.live import Live
from rich.table import Table
from rich.text import Text

_IST = timezone(timedelta(hours=5, minutes=30))


def _fmt_hms(seconds: float | None) -> str:
    if seconds is None or seconds != seconds or seconds < 0:  # NaN check via != self
        return "--:--:--"
    s = int(seconds)
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


@dataclass
class HeadResult:
    """A single completed head fit."""

    target: str
    objective: str
    val_metric: float | None  # val_auc for binary; val_rmse for regression
    metric_name: str          # "val_auc" or "val_rmse"
    n_train: int
    n_val: int
    status: str               # "pass" | "skipped" | "failed"
    error: str | None = None


class TrainingDashboard:
    """Rich live dashboard for a single-instrument training run.

    Usage::

        with TrainingDashboard(
            instrument="nifty50",
            exchange="NSE",
            n_dates=14,
            total_heads=84,
            feature_count=359,
        ) as dash:
            dash.start_head("direction_30s", "binary")
            # ... fit ...
            dash.mark_head_done(HeadResult(
                target="direction_30s", objective="binary",
                val_metric=0.612, metric_name="val_auc",
                n_train=180210, n_val=70800, status="pass",
            ))

    Thread-safe for the main thread driving fits.
    """

    def __init__(
        self,
        instrument: str,
        exchange: str,
        n_dates: int,
        total_heads: int,
        feature_count: int,
        *,
        refresh_hz: float = 4.0,
    ) -> None:
        self._instrument = instrument
        self._exchange = exchange
        self._n_dates = n_dates
        self._total_heads = total_heads
        self._feature_count = feature_count
        self._refresh_interval = 1.0 / max(refresh_hz, 1.0)

        self._console = Console(force_terminal=True)
        self._started_monotonic = time.monotonic()
        self._started_wall = datetime.now(_IST)
        self._live: Live | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

        # State updated by the main fitting thread.
        self._lock = threading.Lock()
        self._current_target: str | None = None
        self._current_objective: str | None = None
        self._current_started: float | None = None
        self._results: list[HeadResult] = []
        # For an honest ETA when we have <3 completed heads: track the
        # rolling mean of the LAST 5 head-fit durations.
        self._last_head_durations: list[float] = []
        # Banner that overlays the frame (e.g. Esc confirmation prompt).
        self._banner: tuple[str, str] | None = None  # (text, style)

    # ── public API ──────────────────────────────────────────────────────

    def __enter__(self) -> "TrainingDashboard":
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
            target=self._refresh_loop, name="train-dashboard", daemon=True
        )
        self._thread.start()
        return self

    def __exit__(self, *exc_info) -> bool:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        try:
            if self._live is not None:
                # Snapshot the final frame so the alt-screen tear-down doesn't
                # destroy the result — operator sees the full summary on the
                # primary screen after the dashboard exits.
                final = self._render()
                self._live.update(final, refresh=True)
                self._live.__exit__(*exc_info)
                self._console.print(final)
        except Exception:
            pass
        return False

    def start_head(self, target: str, objective: str) -> None:
        with self._lock:
            self._current_target = target
            self._current_objective = objective
            self._current_started = time.monotonic()

    def mark_head_done(self, result: HeadResult) -> None:
        with self._lock:
            if self._current_started is not None:
                dt = time.monotonic() - self._current_started
                self._last_head_durations.append(dt)
                if len(self._last_head_durations) > 5:
                    self._last_head_durations.pop(0)
            self._results.append(result)
            self._current_target = None
            self._current_objective = None
            self._current_started = None

    def set_banner(self, text: str | None, style: str = "bold yellow") -> None:
        """Push a transient banner (e.g. Esc confirmation prompt)."""
        with self._lock:
            self._banner = (text, style) if text else None

    # ── internal ────────────────────────────────────────────────────────

    def _refresh_loop(self) -> None:
        while not self._stop.is_set():
            try:
                if self._live is not None:
                    self._live.update(self._render(), refresh=True)
            except Exception:
                pass
            self._stop.wait(self._refresh_interval)

    def _render(self) -> Group:
        with self._lock:
            results = list(self._results)
            current_target = self._current_target
            current_objective = self._current_objective
            current_started = self._current_started
            last_durations = list(self._last_head_durations)
            banner = self._banner

        elapsed = time.monotonic() - self._started_monotonic
        n_done = len(results)
        n_pass = sum(1 for r in results if r.status == "pass")
        n_skipped = sum(1 for r in results if r.status == "skipped")
        n_failed = sum(1 for r in results if r.status == "failed")

        pct = n_done / max(self._total_heads, 1)
        if pct > 0 and elapsed > 0:
            eta = elapsed * (1.0 - pct) / pct
        elif last_durations:
            avg = sum(last_durations) / len(last_durations)
            eta = avg * (self._total_heads - n_done)
        else:
            eta = None

        # ── Header
        header_left = Text()
        header_left.append("Train", style="bold cyan")
        header_left.append("  ")
        header_left.append(self._instrument, style="bold")
        header_left.append(f"  ({self._exchange})  ·  ", style="dim")
        header_left.append(f"{self._n_dates} dates", style="cyan")
        header_left.append("  ·  ", style="dim")
        header_left.append(f"{self._total_heads} heads", style="cyan")
        header_left.append("  ·  ", style="dim")
        header_left.append(f"{self._feature_count} features", style="cyan")
        header_right = Text(
            f"started {self._started_wall.strftime('%H:%M:%S')} IST",
            style="dim",
        )
        header_tbl = Table.grid(expand=True)
        header_tbl.add_column(justify="left", ratio=1)
        header_tbl.add_column(justify="right", ratio=1)
        header_tbl.add_row(header_left, header_right)

        # ── Overall progress bar
        bar = self._render_bar(pct, width=24)
        overall_tbl = Table.grid(expand=True, padding=(0, 2))
        overall_tbl.add_column(min_width=10)
        overall_tbl.add_column()
        overall_tbl.add_column()
        overall_tbl.add_column()
        overall_tbl.add_column()
        overall_tbl.add_row(
            Text("Overall", style="bold"),
            bar,
            Text(f"{n_done} / {self._total_heads} heads"),
            Text(f"Elapsed {_fmt_hms(elapsed)}", style="dim"),
            Text(f"ETA {_fmt_hms(eta)}",
                 style="green" if eta is not None else "dim"),
        )

        # ── Current head
        current_line = Text()
        current_line.append("  Current   ", style="dim")
        if current_target:
            current_line.append(current_target, style="bold cyan")
            current_line.append(f"  ({current_objective})", style="dim")
            if current_started is not None:
                in_flight = time.monotonic() - current_started
                current_line.append(f"   {in_flight:.1f}s in flight", style="dim")
        else:
            current_line.append("(between heads — preparing next)", style="dim")

        # ── Last result
        last_line = Text()
        last_line.append("  Last      ", style="dim")
        if results:
            r = results[-1]
            colour = ("green" if r.status == "pass" else
                      "yellow" if r.status == "skipped" else "red")
            last_line.append(r.target, style=f"bold {colour}")
            if r.val_metric is not None and r.metric_name:
                last_line.append(
                    f"    {r.metric_name} = {r.val_metric:.4f}",
                    style=colour,
                )
            last_line.append(
                f"    n_train={r.n_train:,}  n_val={r.n_val:,}", style="dim",
            )
            if r.status == "failed" and r.error:
                last_line.append(f"    FAIL: {r.error[:60]}", style="red")
            elif r.status == "skipped" and r.error:
                last_line.append(f"    SKIP: {r.error[:60]}", style="yellow")
        else:
            last_line.append("(no heads completed yet)", style="dim")

        # ── Best so far (binary heads only — val_auc maximises)
        best_line = Text()
        best_line.append("  Best AUC  ", style="dim")
        best = max(
            (r for r in results if r.status == "pass" and r.metric_name == "val_auc"),
            key=lambda r: r.val_metric or -1,
            default=None,
        )
        if best:
            best_line.append(best.target, style="bold green")
            best_line.append(f"    val_auc = {best.val_metric:.4f}", style="green")
        else:
            best_line.append("(no binary heads completed yet)", style="dim")

        # ── Tally
        tally = Text()
        tally.append(f"PASS {n_pass}", style="bold green")
        tally.append("   ")
        tally.append(f"SKIPPED {n_skipped}", style="bold yellow")
        tally.append("   ")
        tally.append(f"FAIL {n_failed}", style="bold red")
        tally.append("        ")
        tally.append("(Esc to stop)", style="dim")

        rule = Text("─" * 72, style="dim")
        renderables: list = [header_tbl]
        if banner:
            banner_line = Text()
            banner_line.append("  ")
            banner_line.append(banner[0], style=banner[1])
            renderables.append(banner_line)
        renderables.extend([
            rule, overall_tbl, rule, current_line, last_line, best_line, rule, tally,
        ])
        return Group(*renderables)

    def _render_bar(self, fraction: float, width: int = 20) -> Text:
        fraction = max(0.0, min(1.0, fraction))
        filled = int(round(fraction * width))
        if fraction < 1.0 and filled >= width:
            filled = width - 1
        empty = width - filled
        bar = Text()
        bar.append("[")
        bar.append("█" * filled, style="cyan")
        bar.append("░" * empty, style="dim")
        bar.append("]")
        return bar
