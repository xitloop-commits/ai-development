"""Market Status Screen — 2x2, four instruments, order flow across six windows.

Spec: docs/systems/12_market_status_screen.md

    +---------------------+---------------------+
    |      NIFTY 50       |      BANKNIFTY      |
    +---------------------+---------------------+
    |      CRUDE OIL      |     NATURAL GAS     |
    +---------------------+---------------------+

Each quadrant is a table: Partha's 15 order-flow rules down the side, "now" plus
his confirmation windows across the top (now 1m 2m 5m 10m 15m 30m), the MEASURED
edge, and what the reading MEANS in plain English.

"now" is the CURRENT TICK, not a short timeframe: which side the last trade hit,
its size, the price move on that tick, the running delta, and the book as it
stands. Rules needing size over time show an em-dash there - one trade cannot
answer them.

A window with less history than it needs is left BLANK - blank means "no data
yet", a dot means "nothing is happening", and those are different facts. "now"
is live from the first print, and the rest fill in left to right as the tape
reaches each length. On a mid-session restart the tail re-reads today's whole
recording, so they refill immediately.

Two views, toggled with V:
  B  table + meaning  — the default; every row explained in words
  A  table only       — compact, for scanning consistency across timeframes

Keys: V toggle view, 2-7 select detail window, F11 fullscreen, Esc quit.

Run:
  python -m market_screen.app                      # live (tails TFA's recordings)
  python -m market_screen.app --source ws          # live via the server relay
  python -m market_screen.app --replay 2026-09-04  # a recorded day
  python -m market_screen.app --replay latest --speed 120

Live reads TFA's recordings rather than the server's tick relay. The relay only
carries what the SERVER subscribed to, which needs an open trading desk — with
the market open and TFA recording normally it reported totalSubscriptions: 0,
so the screen sat empty with no error. TFA has its own Dhan connection and
records continuously, so its files always have the data. See source.py.
"""
from __future__ import annotations

import argparse
import queue
import tkinter as tk
from datetime import datetime
from typing import Optional

from claude_cohort.flow import FlowState

from .source import INSTRUMENTS, LiveSource, ReplaySource, TailSource, latest_recorded_date
from .verdicts import (
    DEFAULT_WINDOW,
    INSTANTANEOUS,
    NEGATIVE,
    NEUTRAL,
    POSITIVE,
    WATCH,
    ALL_COLUMNS,
    COLUMN_HELP,
    RULE_HELP,
    WINDOW_LABELS,
    WINDOWS,
    agreement,
    combined_meaning,
    read_grid,
    read_now,
)

TITLES = {
    "nifty50": "NIFTY 50",
    "banknifty": "BANKNIFTY",
    "crudeoil": "CRUDE OIL",
    "naturalgas": "NATURAL GAS",
}
# Spec: nifty top-left, banknifty top-right, crude bottom-left, gas bottom-right.
GRID = {"nifty50": (0, 0), "banknifty": (0, 1), "crudeoil": (1, 0), "naturalgas": (1, 1)}

BG = "#0d1117"
PANEL = "#161b22"
BORDER = "#30363d"
HEAD = "#21262d"
FG = "#c9d1d9"
DIM = "#6e7681"
FAINT = "#484f58"
COLOURS = {
    POSITIVE: "#3fb950",
    NEGATIVE: "#f85149",
    WATCH: "#d29922",
    NEUTRAL: "#484f58",
}
# Slightly softer for running text: the arrow colours are tuned for a single
# glyph and read as shouting across a whole sentence.
TEXT_COLOURS = {
    POSITIVE: "#56d364",
    NEGATIVE: "#ff7b72",
    WATCH: "#e3b341",
    NEUTRAL: "#8b949e",
}

# The table spans 1-30 minutes; refreshing faster than once a second only burns
# CPU re-deriving windows that cannot have meaningfully changed.
REFRESH_MS = 1000
N_RULES = 15

VIEW_TABLE = "A"
VIEW_DETAIL = "B"

N_COLS = len(ALL_COLUMNS)          # now + six windows
DETAIL_COL = N_COLS + 2            # 0 = name, 1 = now, 2..7 = windows, 8 = edge
EDGE_COL = N_COLS + 1


class Tooltip:
    """Hover help. One shared popup, reused by every widget that registers.

    Deliberately delayed: the rule names sit in a dense grid and an instant
    tooltip would flash constantly as the cursor crosses the table.
    """

    DELAY_MS = 450
    WRAP_PX = 460

    def __init__(self, root: tk.Tk):
        self.root = root
        self.win: Optional[tk.Toplevel] = None
        self.after_id = None

    def attach(self, widget: tk.Widget, text: str) -> None:
        if not text:
            return
        widget.bind("<Enter>", lambda e, t=text: self._schedule(e, t), add="+")
        widget.bind("<Leave>", lambda e: self.hide(), add="+")
        widget.bind("<Button-1>", lambda e: self.hide(), add="+")

    def _schedule(self, event, text: str) -> None:
        self.hide()
        self.after_id = self.root.after(
            self.DELAY_MS, lambda: self._show(event.x_root, event.y_root, text))

    def _show(self, x: int, y: int, text: str) -> None:
        self.hide()
        win = tk.Toplevel(self.root)
        win.wm_overrideredirect(True)
        win.attributes("-topmost", True)
        frame = tk.Frame(win, bg="#30363d", padx=1, pady=1)
        frame.pack()
        tk.Label(frame, text=text, bg="#1c2128", fg="#d6dae0",
                 font=("Segoe UI", 9), justify="left", anchor="w",
                 wraplength=self.WRAP_PX, padx=10, pady=8).pack()
        win.update_idletasks()
        # Keep it on screen when hovering near the right or bottom edge.
        w, h = win.winfo_width(), win.winfo_height()
        sw, sh = win.winfo_screenwidth(), win.winfo_screenheight()
        px = min(x + 16, sw - w - 8)
        py = y + 20
        if py + h > sh - 8:
            py = y - h - 12
        win.wm_geometry(f"+{max(8, px)}+{max(8, py)}")
        self.win = win

    def hide(self) -> None:
        if self.after_id is not None:
            try:
                self.root.after_cancel(self.after_id)
            except Exception:
                pass
            self.after_id = None
        if self.win is not None:
            try:
                self.win.destroy()
            except Exception:
                pass
            self.win = None


class Quadrant:
    def __init__(self, parent: tk.Widget, instrument: str, app: "App"):
        self.instrument = instrument
        self.app = app
        self.flow = FlowState()
        self.last_tick_ts: Optional[float] = None
        self.tick_count = 0

        self.frame = tk.Frame(parent, bg=PANEL, highlightbackground=BORDER,
                              highlightthickness=1)

        head = tk.Frame(self.frame, bg=PANEL)
        head.pack(fill="x", padx=8, pady=(6, 0))
        self.title = tk.Label(head, text=TITLES[instrument], bg=PANEL, fg=FG,
                              font=("Segoe UI", 12, "bold"), anchor="w")
        self.title.pack(side="left")
        self.price = tk.Label(head, text="-", bg=PANEL, fg=FG,
                              font=("Consolas", 12, "bold"), anchor="e")
        self.price.pack(side="right")

        self.summary = tk.Label(self.frame, text="waiting for ticks", bg=PANEL,
                                fg=DIM, font=("Segoe UI", 9, "bold"), anchor="w")
        self.summary.pack(fill="x", padx=8, pady=(0, 3))

        body = tk.Frame(self.frame, bg=PANEL)
        body.pack(fill="both", expand=True, padx=8, pady=(0, 6))
        self.body = body
        body.columnconfigure(0, minsize=112)
        for c in range(1, 1 + N_COLS):
            body.columnconfigure(c, minsize=38)
        body.columnconfigure(EDGE_COL, minsize=60)
        body.columnconfigure(DETAIL_COL, weight=1)

        # header row
        tip = app.tooltip
        hdr_rule = tk.Label(body, text="rule", bg=HEAD, fg=DIM, font=("Segoe UI", 8),
                            anchor="w", padx=3)
        hdr_rule.grid(row=0, column=0, sticky="ew", pady=(0, 2))
        tip.attach(hdr_rule, COLUMN_HELP["rule"])
        for i, lab in enumerate(ALL_COLUMNS):
            h = tk.Label(body, text=lab, bg=HEAD, fg=DIM,
                         font=("Consolas", 8, "bold") if lab == "now" else ("Consolas", 8),
                         anchor="center")
            h.grid(row=0, column=1 + i, sticky="ew", pady=(0, 2))
            tip.attach(h, COLUMN_HELP["now"] if lab == "now" else COLUMN_HELP["window"])
        hdr_edge = tk.Label(body, text="edge", bg=HEAD, fg=DIM, font=("Consolas", 8),
                            anchor="e", padx=3)
        hdr_edge.grid(row=0, column=EDGE_COL, sticky="ew", pady=(0, 2))
        tip.attach(hdr_edge, COLUMN_HELP["edge"])
        self.hdr_detail = tk.Label(body, text="detail", bg=HEAD, fg=DIM,
                                   font=("Segoe UI", 8), anchor="w", padx=4)

        # rule rows
        self.rows = []
        for r in range(N_RULES):
            name = tk.Label(body, text="", bg=PANEL, fg=DIM, font=("Segoe UI", 8),
                            anchor="nw", padx=3, cursor="question_arrow")
            name.grid(row=1 + r, column=0, sticky="ew")
            tip.attach(name, RULE_HELP.get(r + 1, ""))
            cells = []
            for i in range(N_COLS):
                c = tk.Label(body, text="", bg=PANEL, fg=FAINT,
                             font=("Consolas", 9), anchor="center")
                c.grid(row=1 + r, column=1 + i, sticky="ew")
                cells.append(c)
            edge = tk.Label(body, text="", bg=PANEL, fg=FAINT,
                            font=("Consolas", 7), anchor="e", padx=3)
            edge.grid(row=1 + r, column=EDGE_COL, sticky="ew")
            detail = tk.Label(body, text="", bg=PANEL, fg=DIM,
                              font=("Consolas", 8), anchor="nw", padx=4,
                              justify="left", wraplength=400)
            self.rows.append((name, cells, edge, detail))

        self.footer = tk.Label(self.frame, text="", bg=PANEL, fg=DIM,
                               font=("Consolas", 8), anchor="w",
                               justify="left", wraplength=700)
        self.footer.pack(fill="x", padx=8, pady=(0, 5))
        body.bind("<Configure>", self._on_resize)
        self.apply_view()

    def _on_resize(self, event) -> None:
        """Wrap the explanations to whatever width the column actually has.

        Tkinter wraps on a pixel count, not on the cell, so without this the
        text either overflows a narrow quadrant or stops short in a wide one.
        """
        used = sum(self.body.grid_bbox(column=c, row=0)[2] for c in range(0, EDGE_COL + 1))             if self.body.grid_bbox(column=0, row=0) else 0
        avail = max(220, event.width - used - 16)
        for _, _, _, detail in self.rows:
            detail.config(wraplength=avail)
        self.footer.config(wraplength=max(300, event.width - 16))

    # ── layout ───────────────────────────────────────────────────────────

    def apply_view(self) -> None:
        """Show or hide the detail column without rebuilding the table."""
        if self.app.view == VIEW_DETAIL:
            self.hdr_detail.grid(row=0, column=DETAIL_COL, sticky="ew", pady=(0, 2))
            for r, (_, _, _, detail) in enumerate(self.rows):
                detail.grid(row=1 + r, column=DETAIL_COL, sticky="ew")
            self.footer.pack_forget()
        else:
            self.hdr_detail.grid_forget()
            for _, _, _, detail in self.rows:
                detail.grid_forget()
            self.footer.pack(fill="x", padx=8, pady=(0, 5))

    # ── data ─────────────────────────────────────────────────────────────

    def on_tick(self, tick: dict) -> None:
        self.flow.on_tick(tick)
        self.tick_count += 1
        ts = tick.get("recv_ts")
        if ts:
            self.last_tick_ts = ts

    def redraw(self) -> None:
        px = self.flow._last_price
        self.price.config(text=f"{px:,.2f}" if px else "-")

        grid = read_grid(self.flow, now=self.last_tick_ts)
        now_reads = read_now(self.flow)
        sel = self.app.window
        sel_label = WINDOW_LABELS[WINDOWS.index(sel)]
        sel_reads = grid[sel]

        overall = sel_reads[-1]
        self.summary.config(
            text=f"{overall.verdict}  {overall.detail}   |   "
                 f"{self.tick_count:,} ticks   |   detail {sel_label}",
            fg=COLOURS.get(overall.verdict, DIM),
        )

        for r in range(N_RULES):
            name_w, cells, edge_w, detail_w = self.rows[r]
            ref = sel_reads[r]
            is_last = ref.rule == 15
            name_w.config(
                text=f"{ref.rule:>2} {ref.name}",
                fg=COLOURS.get(ref.verdict, DIM) if is_last else DIM,
                font=("Segoe UI", 8, "bold") if is_last else ("Segoe UI", 8),
            )

            if ref.rule in INSTANTANEOUS:
                # The book is only ever "now", so it lives in the now column and
                # spans the rest. A 30-minute depth reading does not exist and
                # inventing one would be fabricating data.
                cells[0].config(text=ref.detail, fg=FG, anchor="w",
                                font=("Consolas", 8))
                cells[0].grid(row=1 + r, column=1, columnspan=N_COLS, sticky="ew")
                for c in cells[1:]:
                    c.grid_forget()
            else:
                for i, rd in enumerate([now_reads[r]] + [grid[sec][r] for sec in WINDOWS]):
                    cells[i].grid(row=1 + r, column=1 + i, columnspan=1, sticky="ew")
                    cells[i].config(
                        text=rd.symbol,
                        fg=COLOURS.get(rd.verdict, FAINT),
                        anchor="center",
                        font=("Consolas", 9, "bold") if is_last else ("Consolas", 9),
                    )

            edge_w.config(text=ref.edge_label,
                          fg=DIM if ref.edge is not None and abs(ref.edge) >= 3 else FAINT)
            if self.app.view == VIEW_DETAIL:
                # One statement covering ALL the timeframes, not just the
                # selected one. "buys lead on 1m, 2m and 5m; sells lead on 10m,
                # 15m and 30m" is the story; a single window cannot tell it.
                detail_w.config(text=combined_meaning(grid, r),
                                fg=TEXT_COLOURS.get(ref.verdict, DIM))

        if self.app.view == VIEW_TABLE:
            last = sel_reads[-1]
            self.footer.config(text=combined_meaning(grid, N_RULES - 1),
                               fg=TEXT_COLOURS.get(last.verdict, DIM))


class App:
    def __init__(self, root: tk.Tk, src, instruments=INSTRUMENTS,
                 view: str = VIEW_TABLE):
        self.root = root
        self.src = src
        self.view = view
        self.window = DEFAULT_WINDOW
        root.title("Market Status Screen")
        root.configure(bg=BG)
        self.tooltip = Tooltip(root)

        grid = tk.Frame(root, bg=BG)
        grid.pack(fill="both", expand=True)
        for i in range(2):
            grid.rowconfigure(i, weight=1, uniform="q")
            grid.columnconfigure(i, weight=1, uniform="q")

        self.quads = {}
        for inst in instruments:
            q = Quadrant(grid, inst, self)
            r, c = GRID[inst]
            q.frame.grid(row=r, column=c, sticky="nsew", padx=3, pady=3)
            self.quads[inst] = q

        self.status = tk.Label(root, text="", bg=BG, fg=DIM,
                               font=("Consolas", 8), anchor="w")
        self.status.pack(fill="x", padx=6, pady=(0, 4))

        root.bind("<Escape>", lambda e: self.quit())
        root.bind("<F11>", lambda e: root.attributes(
            "-fullscreen", not root.attributes("-fullscreen")))
        for key in ("v", "V"):
            root.bind(f"<KeyPress-{key}>", lambda e: self.toggle_view())
        for i in range(len(WINDOWS)):
            root.bind(f"<KeyPress-{i + 2}>",
                      lambda e, idx=i: self.set_window(WINDOWS[idx]))
        root.protocol("WM_DELETE_WINDOW", self.quit)
        self.tick()

    def toggle_view(self) -> None:
        self.view = VIEW_DETAIL if self.view == VIEW_TABLE else VIEW_TABLE
        for q in self.quads.values():
            q.apply_view()

    def set_window(self, sec: int) -> None:
        self.window = sec

    def tick(self) -> None:
        drained = 0
        while drained < 20000:
            try:
                inst, t = self.src.q.get_nowait()
            except queue.Empty:
                break
            q = self.quads.get(inst)
            if q:
                q.on_tick(t)
            drained += 1

        for q in self.quads.values():
            q.redraw()

        view_label = "table" if self.view == VIEW_TABLE else "table + detail"
        self.status.config(
            text=(f"{getattr(self.src, 'status', '?')}   |   {datetime.now():%H:%M:%S}   |   "
                  f"view {self.view} ({view_label})   |   "
                  f"▲ positive  ▼ negative  ◆ watch  · nothing   |   "
                  f"edge = measured vs base rate, 77 nifty days; inside ±3pp is noise   |   "
                  f"blank = window still filling   |   hover a rule name for help   |   "
                  f"V view, 2-7 window, F11 fullscreen, Esc quit")
        )
        self.root.after(REFRESH_MS, self.tick)

    def quit(self) -> None:
        try:
            self.src.stop()
        except Exception:
            pass
        self.root.destroy()


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="Market Status Screen")
    ap.add_argument("--replay", metavar="DATE",
                    help="replay a recorded day (YYYY-MM-DD, or 'latest')")
    ap.add_argument("--speed", type=float, default=60.0,
                    help="replay speed multiplier (0 = as fast as possible)")
    ap.add_argument("--source", default="tfa", choices=["tfa", "ws"],
                    help="live source: tfa = tail TFA's recordings (default, always "
                         "flowing); ws = the server relay (only carries data when a "
                         "desk is subscribed)")
    ap.add_argument("--view", default=VIEW_DETAIL, choices=[VIEW_TABLE, VIEW_DETAIL],
                    help="A = table only, B = table + detail column (toggle with V)")
    ap.add_argument("--fullscreen", action="store_true")
    args = ap.parse_args(argv)

    if args.replay:
        date = latest_recorded_date() if args.replay == "latest" else args.replay
        if not date:
            print("No recorded days found under data/raw/")
            return 1
        src = ReplaySource(date, speed=args.speed)
        if not src.instruments:
            print(f"No underlying tick recordings for {date}")
            return 1
        print(f"Replaying {date} at {args.speed:g}x: {', '.join(src.instruments)}")
    elif args.source == "ws":
        src = LiveSource()
        if not src.security_map:
            print("Could not resolve security ids from the recordings.")
            return 1
        print(f"Live via the server relay. Watching: "
              f"{', '.join(sorted(set(src.security_map.values())))}")
        print("NOTE: the relay only carries instruments the SERVER has subscribed to, "
              "which needs an open trading desk. If the screen stays empty, use the "
              "default --source tfa.")
    else:
        src = TailSource()
        have = src.live_instruments()
        if not have:
            print(f"No recordings for {src.date} yet under data/raw/ — is TFA running?")
            print("To look at a past day instead:  --replay latest")
            return 1
        print(f"Live, tailing TFA: {', '.join(have)}")

    src.start()
    root = tk.Tk()
    root.geometry("1750x1050")
    if args.fullscreen:
        root.attributes("-fullscreen", True)
    App(root, src, view=args.view)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
