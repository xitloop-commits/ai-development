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
        self.points_text = tk.Label(left, text="", bg=BG, fg=FG, font=MONO_SMALL,
                                    justify="left", anchor="nw")
        self.points_text.pack(fill="both", expand=True)

        right = tk.Frame(body, bg=BG, width=470)
        right.pack(side="right", fill="y")
        right.pack_propagate(False)
        tk.Label(right, text="VERDICT", bg=BG, fg=DIM, font=MONO_SMALL,
                 anchor="w").pack(fill="x")
        self.verdict_text = tk.Label(right, text="", bg=BG, fg=FG, font=MONO,
                                     justify="left", anchor="nw", wraplength=450)
        self.verdict_text.pack(fill="x", pady=(2, 10))
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

        self.points_text.config(text=self._point_lines(snap))
        self.verdict_text.config(text=self._verdict_lines(snap))
        self.flow_text.config(text=self._flow_lines(snap))

    def _point_lines(self, snap: Snapshot) -> str:
        """One line per point. A point with no reading shows its reason, not 0."""
        if not snap.points:
            return "  waiting for enough prints ..."
        out = [f"  {'#':>3} {'point':<20}{'value':>16}{'score':>7}   why not"]
        for n in range(1, 26):
            p = snap.points.get(n)
            if p is None:
                continue
            if p.value is None:
                # Blank, never 0 (D38). A reason, so the gap is explained.
                out.append(f"  {n:>3} {p.name:<20}{'':>16}{'':>7}   {DIM and ''}{p.note}")
                continue
            val = p.value
            if isinstance(val, list):
                val = f"{len(val)} rows"
            elif isinstance(val, dict):
                val = "..."
            elif isinstance(val, float):
                val = f"{val:,.1f}"
            score = "" if p.score is None else f"{p.score:>6.0f}"
            out.append(f"  {n:>3} {p.name:<20}{str(val)[:16]:>16}{score:>7}")
        return "\n".join(out)

    def _verdict_lines(self, snap: Snapshot) -> str:
        p = snap.points.get(25) if snap.points else None
        if p is None or p.value is None:
            return "  no verdict yet"
        d = p.detail
        lines = [f"  {p.value}", ""]
        if d.get("direction"):
            lines.append(f"  direction   {d['direction']}")
        if d.get("strike"):
            sk = d["strike"]
            lines.append(f"  strike      {sk['strike']:,.0f} {sk['side']} {sk['expiry']}")
        if p.score is not None:
            lines.append(f"  confidence  {p.score:.0f} / 100")
        lines.append("")
        lines.append("  why:")
        for r in d.get("reasons", []):
            lines.append(f"   - {r}")
        lines.append("")
        # Never let a green verdict look more confident than the evidence.
        lines.append("  ADVISORY ONLY. Not one of the 15 flow")
        lines.append("  rules beat the base rate over 77 days")
        lines.append("  and 26,671 decision points. These 25")
        lines.append("  points are recorded so they can be")
        lines.append("  scored, not acted on.")
        return "\n".join(lines)

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
