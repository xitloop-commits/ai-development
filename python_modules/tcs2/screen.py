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

from . import chainview as cv
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
# The chain is the thing being read all day, so it gets its own larger size
# (Partha 2026-09-29). The grid is 173 characters wide; at this size that is
# about 1,560 pixels, which fits the display with room to spare.
MONO_CHAIN = ("Consolas", 12)
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


CHAIN_TAGS = (("good", GREEN), ("bad", RED), ("warn", AMBER), ("dim", DIM),
              ("plain", FG), ("head", DIM))

# One declaration of the grid, used by the header and every row alike.
#
# Partha 2026-09-29: the data was not lining up under its headings. The cause was
# two hand-written format strings - the header spent 15 characters around the
# strike and the rows spent 13, so everything from the strike rightward sat two
# characters adrift. The widths now live here and nowhere else, and a test asserts
# every line comes out exactly CHAIN_W wide, so the two cannot drift again.
BAR_W = 6
PHRASE_W = cv.MAX_PHRASE
BUILD_W = 15
WHO_W = 7
LVL_W = 5
OI_W = 10
PX_W = 10
STRIKE_W = 11

REACH_W = 14

HALF_W = BAR_W + PHRASE_W + BUILD_W + WHO_W + LVL_W + OI_W + PX_W

# Where the strike column starts within a line, and the whole line's width. The
# line is NOT symmetric any more - the breakout chance sits beside the strike,
# where it can be read against it, rather than out at an edge. So centring keys
# off the strike column itself (see centre_pad), which is what was actually
# asked for: "strike should be horizontally center always".
STRIKE_AT = HALF_W
CHAIN_W = HALF_W + STRIKE_W + REACH_W + HALF_W


def maximise(win) -> None:
    """Open the window filling the screen (Partha 2026-09-29).

    The chain is 131 characters wide and is read outward from the money, so it
    wants the whole display. `zoomed` is the Windows state; the fallback sizes to
    the screen by hand for anything else.
    """
    try:
        win.state("zoomed")
    except Exception:                                 # noqa: BLE001
        try:
            win.geometry(f"{win.winfo_screenwidth()}x{win.winfo_screenheight()}+0+0")
        except Exception:                             # noqa: BLE001
            pass


def make_chain_widget(parent) -> "tk.Text":
    """A Text widget set up to draw the chain. Used by both windows."""
    w = tk.Text(parent, bg=BG, fg=FG, font=MONO_CHAIN, relief="flat",
                highlightthickness=0, insertwidth=0, wrap="none",
                cursor="arrow")
    for name, colour in CHAIN_TAGS:
        w.tag_configure(name, foreground=colour)
    return w


def chain_header() -> list[tuple[str, str]]:
    """The heading row, as (text, tag) pieces."""
    return [
        (f"{'':{BAR_W}}{'WHAT IS HAPPENING (CALLS)':<{PHRASE_W}}"
         f"{'TODAY':<{BUILD_W}}{'WHO':^{WHO_W}}"
         f"{'LVL':^{LVL_W}}{'OI':>{OI_W}}{'PRICE':>{PX_W}}", "head"),
        (f"{'STRIKE':^{STRIKE_W}}{'GET HERE?':^{REACH_W}}", "head"),
        (f"{'PRICE':<{PX_W}}{'OI':<{OI_W}}{'LVL':^{LVL_W}}"
         f"{'WHO':^{WHO_W}}{'TODAY':<{BUILD_W}}"
         f"{'WHAT IS HAPPENING (PUTS)':<{PHRASE_W}}{'':{BAR_W}}", "head"),
    ]


def chain_row(r) -> list[tuple[str, str]]:
    """One strike, as (text, tag) pieces. Mirror-symmetric about the strike.

    The bars grow outward from the middle on both sides, so the two halves read as
    one picture rather than as two tables that happen to sit side by side.
    """
    c, pu = r.call, r.put
    strike = ("*" if r.is_atm else "") + format(r.strike, ",.0f")
    # Partha 2026-09-29: "we dont need to show the no position left strike / no
    # live market". A strike dead on BOTH sides loses its row in build_rows; one
    # dead side beside a live one keeps the row and leaves its own cell blank,
    # because the live side is the reason the row is still here.
    c_say = "" if c.dead else c.phrase
    p_say = "" if pu.dead else pu.phrase
    return [
        (f"{'#' * c.bar:>{BAR_W}}{c_say:<{PHRASE_W}}", c.tag),
        (f"{c.buildup:<{BUILD_W}}", c.buildup_tag),
        (f"{c.who:^{WHO_W}}", c.who_tag),
        (f"{c.level:^{LVL_W}}", "warn" if c.level else "dim"),
        (f"{fmt_oi(c.oi):>{OI_W}}", "plain"),
        (f"{fmt_num(c.ltp):>{PX_W}}", "plain" if c.live else "dim"),
        (f"{strike:^{STRIKE_W}}", "warn" if r.is_atm else "plain"),
        (f"{r.reach:^{REACH_W}}", r.reach_tag),
        (f"{fmt_num(pu.ltp):<{PX_W}}", "plain" if pu.live else "dim"),
        (f"{fmt_oi(pu.oi):<{OI_W}}", "plain"),
        (f"{pu.level:^{LVL_W}}", "warn" if pu.level else "dim"),
        (f"{pu.who:^{WHO_W}}", pu.who_tag),
        (f"{pu.buildup:<{BUILD_W}}", pu.buildup_tag),
        (f"{p_say:<{PHRASE_W}}{'#' * pu.bar:<{BAR_W}}", pu.tag),
    ]


def verdict_summary(snap) -> tuple[str, str] | None:
    """The verdict on one line, for the top of the chain view.

    The verdict panel is hidden while the chain is on screen, so its headline
    comes with it. Losing a reading because a layout changed would be the worst
    kind of regression - silent.
    """
    p = (snap.points.get(25) if snap is not None and snap.points else None)
    if p is None or p.value is None:
        return None
    bits = [str(p.value)]
    d = p.detail or {}
    if d.get("direction"):
        bits.append(f"direction {d['direction']}")
    if p.score is not None:
        bits.append(f"confidence {p.score:.0f}/100")
    return "  " + "   ".join(bits), verdict_tag(p.value)


def status_lines(control, levels: list, tug=None,
                 verdict: tuple[str, str] | None = None,
                 buildup: tuple[str, str] | None = None) -> list[tuple[str, str]]:
    """The overall reading, in plain words (Partha 2026-09-29).

    Who is in control, how clearly, and why - then the levels that matter, each
    with whether it is being defended or given up. The reasons are printed rather
    than kept behind the verdict, because a claim about who is in control is only
    worth reading if you can see what it rests on.
    """
    out: list[tuple[str, str]] = []
    if verdict is not None:
        out.append((verdict[0], verdict[1]))
        out.append(("\n", "plain"))

    tag = ("good" if control.side == "BUYERS" else
           "bad" if control.side == "SELLERS" else "dim")
    out.append((f"  {control.phrase.upper()}", tag))
    if control.total:
        out.append((f"   ({control.agree} of {control.total} signs agree)", "dim"))
    out.append(("\n", "plain"))
    if control.reasons:
        out.append(("  because: " + "; ".join(control.reasons) + "\n", "dim"))
    else:
        out.append(("  nothing measured yet - waiting for the tape" + "\n", "dim"))

    if buildup:
        # Partha 2026-09-29: "add build up status in layman english". The TODAY
        # column says what happened at each strike; this says what it all amounts
        # to, which is the reading you want before looking at any single row.
        out.append(("  today: ", "dim"))
        out.append((buildup[0] + "\n", buildup[1]))

    if tug is not None and tug.phrase:
        # Partha 2026-09-29: "thug war need to be identified". Both sides
        # committing at the same strikes is the one state where neither the walls
        # nor the tape tells you much on its own.
        out.append(("  " + tug.phrase, "warn"))
        out.append((f"  ({tug.strikes} strikes - {tug.reason})\n", "dim"))

    if levels:
        for lv in levels:
            out.append((f"  {lv.label} {lv.strike:>9,.0f}",
                        "bad" if lv.kind == "R" else "good"))
            note = f"  {lv.tested}"
            if lv.note:
                note += ", built just now"
            out.append((note + "\n", "dim"))
    return out


def centre_pad(w: "tk.Text", width: int = CHAIN_W) -> str:
    """Spaces that put the STRIKE column at the middle of the WINDOW.

    Partha 2026-09-29: the strike column is centred horizontally, always. Two
    things follow from "the strike", not "the line":

      * it is measured against the WINDOW, not against this widget - the widget
        can sit beside a panel, and centring inside it would leave the strike
        visibly off-centre on screen, which is not what was asked
      * it centres the strike COLUMN, so the line either side of it does not have
        to be symmetric - which is what lets the breakout chance sit next to the
        strike instead of out at an edge

    Clamped so the line never runs off the right of the widget.
    """
    try:
        char = getattr(w, "_char_px", 0)
        if not char:
            import tkinter.font as tkfont
            char = max(1, tkfont.Font(font=w.cget("font")).measure("0"))
            w._char_px = char
        top = w.winfo_toplevel()
        offset = w.winfo_rootx() - top.winfo_rootx()
        mid = top.winfo_width() / 2 - offset
        cols = max(1, w.winfo_width() // char)
        pad = int(round(mid / char)) - (STRIKE_AT + STRIKE_W // 2)
        return " " * max(0, min(pad, cols - width))
    except Exception:                                 # noqa: BLE001
        return ""


def render_chain(w: "tk.Text", rt, expiry: str,
                 status: "tk.Text | None" = None, snap=None) -> str:
    """Draw the plain-English chain into `w`. Returns the one-line summary.

    Shared by the main screen and the comparison window so the two can never drift
    apart - a chain that reads differently in two places is worse than having only
    one.

    `status` is a separate widget for the overall reading. It has to be separate:
    the chain scrolls to keep the at-the-money strike centred, and a status block
    drawn inside it would scroll away exactly when the chain got interesting.
    """
    ch = rt.chain
    w.config(state="normal")
    w.delete("1.0", "end")

    rows = cv.build_rows(ch, expiry, rt.flow)
    hidden = cv.hidden_count(ch, expiry, rows)
    levels = cv.key_levels(ch, expiry, tracker=getattr(rt, "levels", None))
    tug = cv.tug_zone(ch, expiry)
    # The same futures ids the verdict reads (runtime.py), so the control panel
    # and the verdict can never disagree about whose tape they are looking at.
    control = cv.control_status(
        ch, expiry, rt.flow,
        futures_ids=tuple(getattr(ch, "_futures_ids", ()) or ()))

    board = status if status is not None else w
    if board is not w:
        board.config(state="normal")
        board.delete("1.0", "end")
    for text, tag in status_lines(control, levels, tug, verdict_summary(snap),
                                  cv.overall_buildup(ch, expiry)):
        board.insert("end", text, tag)
    if board is not w:
        board.config(state="disabled")
    else:
        w.insert("end", "\n")

    pad = centre_pad(w)
    w.insert("end", pad)
    for text, tag in chain_header():
        w.insert("end", text, tag)
    w.insert("end", "\n")

    # How many lines stand above the first strike, so the at-the-money row can be
    # centred vertically: the status block, the blank line, and the heading.
    head_lines = int(w.index("end-1c").split(".")[0])

    atm_line = None
    for n, r in enumerate(rows):
        if r.is_atm:
            atm_line = n + head_lines
        w.insert("end", pad)
        for text, tag in chain_row(r):
            w.insert("end", text, tag)
        w.insert("end", "\n")

    if hidden:
        # Say what was left out. Filtering silently is the same fault as a blank
        # cell that means zero: the reader cannot tell "nothing there" from "we did
        # not show you".
        w.insert("end", "\n" + pad +
                 f"  {hidden} strike(s) hidden - no live market" + "\n", "dim")
    w.config(state="disabled")

    centre_on(w, atm_line, len(rows) + head_lines)
    spot = ch.reference
    return (f"{spot:,.2f}   {cv.summary_line(rows, spot)}"
            if rows else "waiting for the chain to fill ...")


def centre_on(w: "tk.Text", line: int | None, total: int) -> None:
    """Put the at-the-money row in the middle of the window.

    A chain is read outward from where price actually is, so the spot row belongs
    in the centre rather than wherever the scroll happens to sit - and it is
    re-centred on every repaint, because the at-the-money strike moves during the
    session.
    """
    if not line or total <= 0:
        return
    try:
        px = w.winfo_height()
        row_px = max(1, w.dlineinfo("1.0")[3]) if w.dlineinfo("1.0") else 16
        visible = max(1, px // row_px)
        top = max(0, line - visible // 2)
        w.yview_moveto(min(1.0, top / max(total, 1)))
    except Exception:                                 # noqa: BLE001
        try:
            w.see(f"{line}.0")
        except Exception:                             # noqa: BLE001
            pass


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
        maximise(self)

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

        # Plain English is the DEFAULT view (Partha 2026-09-29). The numbers are
        # still there on `v` - they were never the thing being read.
        self.view = "words"
        self.bind("<KeyPress-v>", lambda _e: self._toggle_view())

        self.words = make_chain_widget(self)

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
        self._show_view()
        self._repaint()

    def _toggle_view(self) -> None:
        self.view = "numbers" if self.view == "words" else "words"
        self._show_view()

    def _show_view(self) -> None:
        self.tree.pack_forget()
        self.words.pack_forget()
        if self.view == "words":
            self.words.pack(fill="both", expand=True, padx=10, pady=(4, 10))
        else:
            self.tree.pack(fill="both", expand=True, padx=10, pady=(4, 10))

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
        if self.view == "words":
            self._render_words(expiry, summary)
        else:
            self._render_numbers(expiry, summary)

    def _render_words(self, expiry: str, summary) -> None:
        """The chain in plain English - one phrase per strike, per side."""
        line = render_chain(self.words, self.rt, expiry)
        if summary is not None and line:
            self.header.config(text=f"{self.rt.instrument}   {line}")

    def _render_numbers(self, expiry: str, summary) -> None:
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
        maximise(self)
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
        # The chain IS the main screen (Partha 2026-09-29), with the 25 points
        # behind `p`. That is the right way round: the chain is measurement, the
        # points are unproven (spec 15 §5.4), and the chain is what gets read.
        self.body_view = "chain"
        self.body_label = tk.Label(left, text="", bg=BG, fg=DIM,
                                   font=MONO_SMALL, anchor="w")
        self.body_label.pack(fill="x")
        # Who is in control and the levels that matter, above the chain and always
        # on screen (Partha 2026-09-29).
        self.status_text = make_chain_widget(left)
        # Tall enough for the verdict, who is in control and why, the tug of war
        # and all five levels. Too short and the levels fall off the bottom
        # silently, which is the failure this panel exists to prevent.
        self.status_text.config(height=10)
        self.chain_text = make_chain_widget(left)

        # A Text widget, not a Label: a Label paints one colour for the whole
        # block, and the point of this panel is that a positive reading looks
        # different from a negative one at a glance.
        self.points_text = tk.Text(left, bg=BG, fg=FG, font=MONO_SMALL,
                                   relief="flat", highlightthickness=0,
                                   insertwidth=0, wrap="none", cursor="arrow")
        for name, colour in CHAIN_TAGS:
            self.points_text.tag_configure(name, foreground=colour)
        # The lit half of a blink: a background, so it reads as attention rather
        # than as a different value.
        self.points_text.tag_configure("rise", foreground="#0b0e11",
                                       background=GREEN)
        self._rises = RiseTracker()
        self._paints = 0

        # Kept as an attribute: in chain view it is hidden, so the chain has the
        # full width and the strike column can sit at the middle of the WINDOW
        # (Partha 2026-09-29). Nothing is lost - the verdict headline moves to the
        # top of the chain, and `p` brings the whole panel back with the points.
        self.right = right = tk.Frame(body, bg=BG, width=470)
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

        # LAST, not earlier: it shows or hides the right panel, so every widget it
        # touches has to exist first. Crashed on startup once for this exact
        # reason (2026-09-29) - the window is built in one order and there is no
        # test that builds it, so the order is load-bearing.
        self._show_body()

        self.bind("<KeyPress-c>", lambda _e: self.open_chain())
        self.bind("<KeyPress-p>", lambda _e: self._toggle_body())
        self.protocol("WM_DELETE_WINDOW", self._close)
        self._paint_errors = 0
        self.after(REPAINT_MS, self._repaint)

    def report_callback_exception(self, exc_type, exc, tb) -> None:
        """Tk's own handler. Default prints to stderr, which pythonw discards."""
        cfg.log_error(self.rt.instrument, exc, "tk callback")

    # -- actions ---------------------------------------------------------

    def _toggle_body(self) -> None:
        self.body_view = "points" if self.body_view == "chain" else "chain"
        self._show_body()

    def _show_body(self) -> None:
        self.status_text.pack_forget()
        self.chain_text.pack_forget()
        self.points_text.pack_forget()
        if self.body_view == "chain":
            self.right.pack_forget()
            self.body_label.config(
                text="THE OPTION CHAIN      [p] the 25 points and the verdict")
            self.status_text.pack(fill="x", pady=(0, 4))
            self.chain_text.pack(fill="both", expand=True)
        else:
            self.body_label.config(
                text="THE 25 POINTS   (scores DESCRIBE, they do not predict)"
                     "      [p] back to the chain")
            self.right.pack(side="right", fill="y")
            self.points_text.pack(fill="both", expand=True)

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
        try:
            snap = self.rt.latest()
            if snap is not None:
                self._render(snap)
        except Exception as exc:                      # noqa: BLE001
            # The repaint must be rescheduled whatever happened. An exception
            # escaping here breaks the `after` chain, and a window that has
            # stopped updating but is still on screen is worse than one that
            # closed: nothing about it looks wrong.
            self._paint_errors += 1
            if self._paint_errors <= 5:
                cfg.log_error(self.rt.instrument, exc, "repaint")
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

        if self.body_view == "chain":
            expiry = snap.expiries[0] if snap.expiries else ""
            if expiry:
                line = render_chain(self.chain_text, self.rt, expiry,
                                    status=self.status_text, snap=snap)
                self.body_label.config(text=f"OPTION CHAIN  {expiry}   {line}"
                                            f"      [p] the 25 points   "
                                            f"[c] compare with your broker")
        else:
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
               f"{'large%':>8}  {'reading':<36}"]
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
                f"  {', '.join(notes) or '-':<36}")
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
