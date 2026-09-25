"""TCS2 - the instrument screen. Tkinter on the MAIN thread.

Spec: docs/systems/14_tcs2.md  (D15, D16, D17, D38)

One window per instrument (D15), living inside that instrument's process (D16).

The rules this file obeys, all of them from D16:
  * **Tkinter owns the main thread.** The feed runs on a worker, started by
    `runtime.InstrumentRuntime.start()`. This module never spawns the feed.
  * **Nothing here touches live state.** Every repaint reads one immutable
    `Snapshot` and renders it. If no new snapshot has arrived, the previous frame
    simply stays on screen.
  * **Falling behind drops frames, never ticks.** A slow repaint cannot apply
    back-pressure to the feed, because there is no queue to fill.

The health row sits at the TOP, not the bottom (D17). On 2026-09-18 the recorder
stopped at 10:00 and it took two and a half hours to notice, with someone at the
desk, because nothing on screen said so.

`formatters` are module-level functions rather than methods so they can be tested
without a display.
"""
from __future__ import annotations

import threading
import time
import tkinter as tk
from tkinter import ttk

from .health import DEAD, IDLE, LATE, OK
from .runtime import InstrumentRuntime, Snapshot

REPAINT_MS = 300

BG = "#101317"
FG = "#d7dde3"
DIM = "#7b8794"
GREEN = "#35c46a"
RED = "#e5484d"
AMBER = "#e8a33d"
BLUE = "#4c9ae8"
MONO = ("Consolas", 10)
MONO_SMALL = ("Consolas", 9)
MONO_BIG = ("Consolas", 15, "bold")

STATUS_COLOUR = {OK: GREEN, IDLE: DIM, LATE: AMBER, DEAD: RED}


def fmt_num(v: float | None, places: int = 2, blank_zero: bool = True) -> str:
    """Blank rather than 0 when we have no answer (D38).

    A printed 0 for an unanswerable IV reads as a cheap option; a blank reads as
    what it is.
    """
    if v is None:
        return ""
    try:
        if v != v:                 # NaN
            return ""
        if blank_zero and v == 0:
            return ""
        return f"{v:,.{places}f}"
    except (TypeError, ValueError):
        return ""


def fmt_oi(v: int | None) -> str:
    if not v:
        return ""
    if abs(v) >= 100_000:
        return f"{v / 100_000:,.1f}L"
    return f"{v:,}"


def fmt_signed(v: int | None) -> str:
    if not v:
        return ""
    return f"{v:+,}" if abs(v) < 100_000 else f"{v / 100_000:+,.1f}L"


# Readings that are good news, and readings that are not. Words rather than
# numbers, because most of the 25 points report a state.
_GOOD_WORDS = {
    "UP", "CONFIRMED", "STRONG", "GOOD", "TRADE", "READY", "CONTINUATION",
    "LONG_BUILDUP", "SHORT_COVER", "CE",
}
_BAD_WORDS = {
    "DOWN", "FALSE", "POOR", "REVERSAL", "NO_TRADE", "SHORT_BUILDUP",
    "LONG_UNWIND", "BUYERS_ABSORBED", "SELLERS_ABSORBED", "PE",
}
_WARN_WORDS = {
    "FLAT", "SUSPECT", "WEAKENING", "BUILDING", "NOT_READY", "NEUTRAL",
    "WEAK", "FAIR", "NONE", "EXPANSION", "CONTRACTION", "NORMAL",
    "ACCEPTABLE",
}


def value_tag(value) -> str:
    """Which colour a reading deserves.

    Partha, 2026-09-25: positive values in green, with their label. So:
      * a number above zero is green, below zero red, exactly zero neutral
      * a state that is good news is green, bad news red, in-between amber
      * a missing reading is dim - never green, because "no answer" is not good
        news, and never red, because it is not bad news either

    A separate function from the widgets on purpose, so the rules can be tested
    without a display.
    """
    if value is None:
        return "dim"
    if isinstance(value, bool):
        # True on an exhaustion or absorption point is a warning, not a win.
        return "warn" if value else "dim"
    if isinstance(value, (int, float)):
        if value != value:              # NaN
            return "dim"
        if value > 0:
            return "good"
        if value < 0:
            return "bad"
        return "plain"
    if isinstance(value, str):
        key = value.strip().upper().replace(" ", "_")
        if key in _GOOD_WORDS:
            return "good"
        if key in _BAD_WORDS:
            return "bad"
        if key in _WARN_WORDS:
            return "warn"
        return "plain"
    return "plain"


def verdict_tag(verdict) -> str:
    """The verdict headline. NO TRADE is amber, not red - it is not a failure."""
    if verdict == "TRADE":
        return "good"
    if verdict == "NO_TRADE":
        return "warn"
    return "dim"


# A score has to move by this much before it blinks. Scores jitter by fractions
# of a point between repaints, and something that blinks constantly is something
# you stop seeing - the same reason D47 stopped the health light crying wolf.
RISE_THRESHOLD = 5.0

# How long a point keeps blinking after it rose.
BLINK_SECONDS = 4.0

# Repaints per half-blink. The phase is driven by the repaint COUNTER, not by
# wall-clock: at a 300 ms repaint a 2 Hz clock-based blink aliases and flickers
# unevenly. Two repaints lit, two dark, is a clean ~600 ms blink.
BLINK_REPAINTS = 2


class RiseTracker:
    """Remembers which points' scores went UP, so the screen can blink them.

    Partha, 2026-09-25: blink a point whose score increases, to catch the eye.

    Deliberately not "any increase". A score drifting from 61.2 to 61.4 between
    repaints is noise, and a row that blinks constantly is a row you stop
    looking at. Only a rise of `RISE_THRESHOLD` counts, and the blink expires
    after `BLINK_SECONDS` so the screen settles.

    Separate from the widgets so the behaviour can be tested without a display.
    """

    def __init__(self, threshold: float = RISE_THRESHOLD,
                 blink_seconds: float = BLINK_SECONDS) -> None:
        self.threshold = threshold
        self.blink_seconds = blink_seconds
        self._last: dict[int, float] = {}
        self._rose_at: dict[int, float] = {}
        self._rise: dict[int, float] = {}

    def update(self, points: dict, now: float) -> None:
        """Take the current scores and note which ones rose materially."""
        for n, p in points.items():
            score = getattr(p, "score", None)
            if score is None or score != score:        # missing or NaN
                # A point that stops reporting should not keep blinking from a
                # rise it made before it went blank.
                self._last.pop(n, None)
                self._rose_at.pop(n, None)
                continue
            prev = self._last.get(n)
            if prev is not None and score - prev >= self.threshold:
                self._rose_at[n] = now
                self._rise[n] = score - prev
            self._last[n] = score

    def blinking(self, now: float) -> set[int]:
        """Which points are still within their blink window."""
        return {n for n, t in self._rose_at.items()
                if now - t < self.blink_seconds}

    def rise_of(self, n: int) -> float:
        return self._rise.get(n, 0.0)

    @staticmethod
    def phase_on(repaint_count: int,
                 per_half: int = BLINK_REPAINTS) -> bool:
        """True on the 'lit' half of the blink cycle.

        Driven by the repaint counter rather than the clock, so the blink is even
        regardless of how the repaint interval divides into a frequency.
        """
        return (repaint_count // max(1, per_half)) % 2 == 0


def point_rows(points: dict) -> list[tuple[int, str, str]]:
    """(number, formatted line, colour tag) for each of the 25 points.

    Missing readings print their REASON rather than a zero (D38), and are dim.
    """
    rows: list[tuple[int, str, str]] = []
    for n in range(1, 26):
        p = points.get(n)
        if p is None:
            continue
        if p.value is None:
            rows.append((n, f"  {n:>3} {p.name:<20}{'':>16}{'':>7}   {p.note}",
                         "dim"))
            continue
        val = p.value
        if isinstance(val, list):
            shown, tag = f"{len(val)} rows", "plain"
        elif isinstance(val, dict):
            shown, tag = "...", "plain"
        elif isinstance(val, float):
            shown, tag = f"{val:,.1f}", value_tag(val)
        else:
            shown, tag = str(val), value_tag(val)
        score = "" if p.score is None else f"{p.score:>6.0f}"
        rows.append((n, f"  {n:>3} {p.name:<20}{shown[:16]:>16}{score:>7}", tag))
    return rows


def fmt_age(seconds: float) -> str:
    if seconds == float("inf"):
        return "never"
    if seconds < 60:
        return f"{seconds:.1f}s"
    if seconds < 3600:
        return f"{seconds / 60:.0f}m"
    return f"{seconds / 3600:.1f}h"


class OptionChainWindow(tk.Toplevel):
    """The D38 comparison window.

    Its whole purpose is to be read side by side against the broker's own option
    chain. We BUILD the chain from ticks (D12) and COMPUTE every Greek (D25), and
    nothing else in the design checks those numbers against an independent
    source - this window is that check.
    """

    COLUMNS = (
        ("c_oi", "OI", 10), ("c_chg", "chg", 9), ("c_vol", "vol", 10),
        ("c_iv", "IV%", 7), ("c_delta", "delta", 7), ("c_bid", "bid", 9),
        ("c_ask", "ask", 9), ("c_ltp", "LTP", 9),
        ("strike", "STRIKE", 10),
        ("p_ltp", "LTP", 9), ("p_bid", "bid", 9), ("p_ask", "ask", 9),
        ("p_delta", "delta", 7), ("p_iv", "IV%", 7), ("p_vol", "vol", 10),
        ("p_chg", "chg", 9), ("p_oi", "OI", 10),
    )

    def __init__(self, master: tk.Misc, rt: InstrumentRuntime) -> None:
        super().__init__(master)
        self.rt = rt
        self.title(f"{rt.instrument} - option chain (built from ticks)")
        self.configure(bg=BG)
        self.geometry("1500x820")

        top = tk.Frame(self, bg=BG)
        top.pack(fill="x", padx=10, pady=(10, 4))
        self.header = tk.Label(top, text="", bg=BG, fg=FG, font=MONO,
                               justify="left", anchor="w")
        self.header.pack(side="left")

        self.expiry_var = tk.StringVar()
        self.expiry_box = ttk.Combobox(top, textvariable=self.expiry_var,
                                       values=list(rt.chain.expiries),
                                       state="readonly", width=14)
        self.expiry_box.pack(side="right")
        if rt.chain.expiries:
            self.expiry_var.set(rt.chain.expiries[0])
        tk.Label(top, text="expiry ", bg=BG, fg=DIM, font=MONO).pack(side="right")

        note = ("compare against your broker's chain - blank means we decline to "
                "compute, never zero")
        tk.Label(self, text=note, bg=BG, fg=DIM, font=MONO_SMALL,
                 anchor="w").pack(fill="x", padx=10)

        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("chain.Treeview", background=BG, foreground=FG,
                        fieldbackground=BG, font=MONO_SMALL, rowheight=19,
                        borderwidth=0)
        style.configure("chain.Treeview.Heading", background="#1a1f26",
                        foreground=DIM, font=MONO_SMALL)

        self.tree = ttk.Treeview(self, style="chain.Treeview", show="headings",
                                 columns=[c[0] for c in self.COLUMNS])
        for key, title, width in self.COLUMNS:
            self.tree.heading(key, text=title)
            anchor = "center" if key == "strike" else "e"
            self.tree.column(key, width=width * 9, anchor=anchor, stretch=False)
        self.tree.tag_configure("atm", background="#20303f")
        self.tree.tag_configure("wall", background="#2c2418")
        self.tree.pack(fill="both", expand=True, padx=10, pady=(4, 10))

        self._repaint()

    def _repaint(self) -> None:
        expiry = self.expiry_var.get()
        if expiry:
            snap = self.rt.latest()
            summary = None
            if snap:
                summary = next((s for s in snap.summaries if s.expiry == expiry), None)
            self._render(expiry, summary)
        self.after(600, self._repaint)

    def _render(self, expiry: str, summary) -> None:
        ch = self.rt.chain
        if summary is not None:
            self.header.config(
                text=(f"{self.rt.instrument}   ref {summary.spot:,.2f}   "
                      f"forward {ch.forward.get(expiry, 0):,.2f}   "
                      f"{summary.days_to_expiry:.2f}d   "
                      f"ATM {summary.atm_strike:,.0f}   "
                      f"straddle {summary.atm_straddle:,.2f}   "
                      f"PCR {summary.pcr_oi:.2f}   "
                      f"max pain {summary.max_pain:,.0f}"))
        atm = summary.atm_strike if summary else 0.0
        walls = {summary.call_wall_strike, summary.put_wall_strike} if summary else set()

        self.tree.delete(*self.tree.get_children())
        for row in ch.rows(expiry):
            c, p = row.get("call", {}), row.get("put", {})
            tags = ("atm",) if row["strike"] == atm else \
                   ("wall",) if row["strike"] in walls else ()
            self.tree.insert("", "end", tags=tags, values=(
                fmt_oi(c.get("oi")), fmt_signed(c.get("oi_change")),
                fmt_oi(c.get("volume")),
                fmt_num((c.get("iv") or float("nan")) * 100),
                fmt_num(c.get("delta"), 3), fmt_num(c.get("bid")),
                fmt_num(c.get("ask")), fmt_num(c.get("ltp")),
                f"{row['strike']:,.0f}",
                fmt_num(p.get("ltp")), fmt_num(p.get("bid")),
                fmt_num(p.get("ask")), fmt_num(p.get("delta"), 3),
                fmt_num((p.get("iv") or float("nan")) * 100),
                fmt_oi(p.get("volume")), fmt_signed(p.get("oi_change")),
                fmt_oi(p.get("oi")),
            ))


class Screen(tk.Tk):
    """One instrument, one window (D15)."""

    def __init__(self, rt: InstrumentRuntime,
                 stopping: "threading.Event | None" = None) -> None:
        super().__init__()
        self.rt = rt
        self._stopping = stopping
        self.title(f"TCS2 - {rt.instrument}")
        self.configure(bg=BG)
        self.geometry("1180x740")
        self._chain_window: OptionChainWindow | None = None

        # Health FIRST, at the top (D17).
        health = tk.Frame(self, bg="#161b21")
        health.pack(fill="x")
        self.health_label = tk.Label(health, text="", bg="#161b21", fg=FG,
                                     font=MONO, anchor="w", padx=10, pady=6)
        self.health_label.pack(side="left")
        self.stale_label = tk.Label(health, text="", bg="#161b21", fg=RED,
                                    font=MONO, anchor="e", padx=10)
        self.stale_label.pack(side="right")

        head = tk.Frame(self, bg=BG)
        head.pack(fill="x", padx=12, pady=(10, 2))
        self.price_label = tk.Label(head, text="", bg=BG, fg=FG, font=MONO_BIG,
                                    anchor="w")
        self.price_label.pack(side="left")
        tk.Button(head, text="OPTION CHAIN", command=self.open_chain,
                  bg=BLUE, fg="#0b0e11", font=MONO, relief="flat",
                  padx=14, pady=4, activebackground=BLUE).pack(side="right")

        self.expiry_text = tk.Label(self, text="", bg=BG, fg=DIM, font=MONO,
                                    justify="left", anchor="w")
        self.expiry_text.pack(fill="x", padx=12, pady=(2, 8))

        body = tk.Frame(self, bg=BG)
        body.pack(fill="both", expand=True, padx=12, pady=(2, 12))

        left = tk.Frame(body, bg=BG)
        left.pack(side="left", fill="both", expand=True)
        tk.Label(left, text="THE 25 POINTS   (scores DESCRIBE, they do not predict)",
                 bg=BG, fg=DIM, font=MONO_SMALL, anchor="w").pack(fill="x")
        # A Text widget, not a Label: a Label paints one colour for the whole
        # block, and the point of this panel is that a positive reading looks
        # different from a negative one at a glance.
        self.points_text = tk.Text(left, bg=BG, fg=FG, font=MONO_SMALL,
                                   relief="flat", highlightthickness=0,
                                   insertwidth=0, wrap="none", cursor="arrow")
        self.points_text.pack(fill="both", expand=True)
        for name, colour in (("good", GREEN), ("bad", RED), ("warn", AMBER),
                             ("dim", DIM), ("plain", FG), ("head", DIM)):
            self.points_text.tag_configure(name, foreground=colour)
        # The lit half of a blink: a background, so it reads as attention rather
        # than as a different value.
        self.points_text.tag_configure("rise", foreground="#0b0e11",
                                       background=GREEN)
        self._rises = RiseTracker()
        self._paints = 0

        right = tk.Frame(body, bg=BG, width=470)
        right.pack(side="right", fill="y")
        right.pack_propagate(False)
        tk.Label(right, text="VERDICT", bg=BG, fg=DIM, font=MONO_SMALL,
                 anchor="w").pack(fill="x")
        self.verdict_text = tk.Text(right, bg=BG, fg=FG, font=MONO, height=16,
                                    relief="flat", highlightthickness=0,
                                    insertwidth=0, wrap="word", cursor="arrow")
        self.verdict_text.pack(fill="x", pady=(2, 10))
        for name, colour in (("good", GREEN), ("bad", RED), ("warn", AMBER),
                             ("dim", DIM), ("plain", FG)):
            self.verdict_text.tag_configure(name, foreground=colour)
        tk.Label(right, text="ORDER FLOW - futures", bg=BG, fg=DIM,
                 font=MONO_SMALL, anchor="w").pack(fill="x")
        self.flow_text = tk.Label(right, text="", bg=BG, fg=FG, font=MONO_SMALL,
                                  justify="left", anchor="nw")
        self.flow_text.pack(fill="both", expand=True)

        self.bind("<KeyPress-c>", lambda _e: self.open_chain())
        self.protocol("WM_DELETE_WINDOW", self._close)
        self.after(REPAINT_MS, self._repaint)

    # -- actions ---------------------------------------------------------

    def open_chain(self) -> None:
        if self._chain_window is not None and self._chain_window.winfo_exists():
            self._chain_window.lift()
            return
        self._chain_window = OptionChainWindow(self, self.rt)

    def _close(self) -> None:
        self.rt.stop()
        self.destroy()

    # -- repaint ---------------------------------------------------------

    def _repaint(self) -> None:
        # A stop signal reaches Tk here rather than through the handler, because
        # Tk cannot be touched from a signal handler safely.
        if self._stopping is not None and self._stopping.is_set():
            self._close()
            return
        self._paints += 1
        # The GUI's own heartbeat. Beaten here, in the repaint, so a frozen
        # window stops beating and says so - rather than being beaten by the
        # feed thread, which would make a dead window look alive.
        self.rt.health.gui.beat()
        snap = self.rt.latest()
        if snap is not None:
            self._render(snap)
        self.after(REPAINT_MS, self._repaint)

    def _render(self, snap: Snapshot) -> None:
        h = snap.health
        dots = []
        for name in ("feed", "recorder", "gui"):
            st = h[name]["status"]
            dots.append((f"{name} {fmt_age(h[name]['age'])}", STATUS_COLOUR[st]))
        self.health_label.config(
            text="   ".join(d[0] for d in dots)
            + f"   |  ticks {h['ticks']:,} ({h['tick_rate']:,.0f}/s)"
            + f"  legs {h['legs_seen']:,}/{h['legs_subscribed']:,}"
            + f"  analytics {h['analytics_ms']:.0f}ms"
            + (f"  bookless {h['unknown_prints']:,}"
               if h["unknown_prints"] else ""))
        worst = h["worst"]
        self.stale_label.config(
            text="" if worst == OK else f"  {worst.upper()}  ",
            fg=STATUS_COLOUR[worst])

        futures = "  ".join(f"{px:,.2f}" for _sid, px in snap.futures)
        self.price_label.config(
            text=(f"{snap.instrument}   {snap.reference:,.2f}"
                  + (f"   fut {futures}" if futures else "")
                  + (f"   vix {snap.vix:.2f}" if snap.vix else "")))

        lines = []
        for s in snap.summaries:
            lines.append(
                f"{s.expiry}  {s.days_to_expiry:6.2f}d   "
                f"ATM {s.atm_strike:>9,.0f}  straddle {s.atm_straddle:>8,.2f}  "
                f"IV {(s.atm_iv * 100 if s.atm_iv == s.atm_iv else 0):>5.2f}%  "
                f"PCR {s.pcr_oi:>5.2f}  pain {s.max_pain:>9,.0f}  "
                f"call wall {s.call_wall_strike:>9,.0f} ({fmt_oi(s.call_wall_oi)})  "
                f"put wall {s.put_wall_strike:>9,.0f} ({fmt_oi(s.put_wall_oi)})")
        self.expiry_text.config(text="\n".join(lines))

        self._render_points(snap)
        self._render_verdict(snap)
        self.flow_text.config(text=self._flow_lines(snap))

    def _point_lines(self, snap: Snapshot) -> str:
        """Kept for tests. `_render_points` is what paints, with colour."""
        return "\n".join(f"{n} {t}" for n, t, _ in point_rows(snap.points))

    def _render_points(self, snap: Snapshot) -> None:
        """Repaint the points panel, colouring each row by its own reading."""
        w = self.points_text
        w.config(state="normal")
        w.delete("1.0", "end")
        if not snap.points:
            w.insert("end", "  waiting for enough prints ...\n", "dim")
            w.config(state="disabled")
            return
        header = f"  {'#':>3} {'point':<20}{'value':>16}{'score':>7}   why not\n"
        w.insert("end", header, "head")
        for _n, line, tag in point_rows(snap.points):
            w.insert("end", line + "\n", tag)
        w.config(state="disabled")

    def _render_verdict(self, snap: Snapshot) -> None:
        w = self.verdict_text
        w.config(state="normal")
        w.delete("1.0", "end")
        p = snap.points.get(25) if snap.points else None
        if p is None or p.value is None:
            w.insert("end", "  no verdict yet\n", "dim")
            w.config(state="disabled")
            return
        d = p.detail
        w.insert("end", f"  {p.value}\n\n", verdict_tag(p.value))
        if d.get("direction"):
            w.insert("end", "  direction   ", "plain")
            w.insert("end", f"{d['direction']}\n", value_tag(d["direction"]))
        if p.score is not None:
            w.insert("end", "  confidence  ", "plain")
            w.insert("end", f"{p.score:.0f} / 100\n", value_tag(p.score))

        # Both sides, always, each with what it is waiting for. We trade up AND
        # down: up means buy a call, down means buy a put. The question is which
        # side is good now, never simply whether there is a trade.
        for key, label in (("call", "CALL"), ("put", "PUT ")):
            side = d.get(key)
            if not side:
                continue
            w.insert("end", f"\n  {label}  ", "plain")
            if side.get("viable"):
                sk = side.get("strike") or {}
                w.insert("end", "GOOD", "good")
                if sk:
                    w.insert("end", f"   {sk['strike']:,.0f} {sk['side']} "
                                    f"{sk['expiry']}", "good")
                w.insert("end", "\n", "plain")
            else:
                w.insert("end", "no\n", "warn")
            for r in side.get("reasons", []):
                tag = "good" if "clear" in r else "dim"
                w.insert("end", f"      - {r}\n", tag)
        # Never let a green verdict look more confident than the evidence.
        w.insert("end",
                 "\n  ADVISORY ONLY. Not one of the 15 flow rules beat the base "
                 "rate over 77 days and 26,671 decision points. These 25 points "
                 "are recorded so they can be scored, not acted on.\n", "dim")
        w.config(state="disabled")

    def _flow_lines(self, snap: Snapshot) -> str:
        fut_ids = [int(c.security_id) for c in self.rt.resolved.futures]
        sid = next((s for s in fut_ids if s in snap.flow), None)
        if sid is None:
            return "  no futures flow yet"
        f = snap.flow[sid]
        out = [f"  prints {f['prints']:,}   cumulative delta "
               f"{f['cum_delta']:+,}   median size {f['median_qty']:,.0f}"
               f"   imbalance {f['imbalance']:+.2f}"
               + (f"   bookless {f['unknown_prints']:,}"
                  if f["unknown_prints"] else ""),
               "",
               f"  {'window':>8}  {'buy%':>6}{'sell%':>7}{'delta':>10}"
               f"{'large%':>8}  {'reading':<40}"]
        for w in sorted(f["windows"]):
            d = f["windows"][w]
            a, ab, pr, ex = (d["aggression"], d["absorption"],
                             d["pressure"], d["exhaustion"])
            notes = []
            if ab["buyer_absorbed"]:
                notes.append("buyers absorbed")
            if ab["seller_absorbed"]:
                notes.append("sellers absorbed")
            if pr["responding"]:
                notes.append("pressure working")
            if ex["exhausted"]:
                notes.append("exhausting")
            if d["rejection"]["rejected_high"]:
                notes.append("rejected high")
            if d["rejection"]["rejected_low"]:
                notes.append("rejected low")
            out.append(
                f"  {w:>7}s  {a['buy_share'] * 100:>5.0f}%{a['sell_share'] * 100:>6.0f}%"
                f"{d['delta']:>10,}{d['print_size']['large_share'] * 100:>7.0f}%"
                f"  {', '.join(notes) or '-':<40}")
        return "\n".join(out)


def run(instrument: str, stopping: "threading.Event | None" = None,
        store=None) -> None:
    """Start the feed on a worker, then give Tkinter the main thread (D16)."""
    rt = InstrumentRuntime(instrument, store=store)
    rt.start()
    try:
        Screen(rt, stopping=stopping).mainloop()
    finally:
        rt.stop()
