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

A window with less history than it needs shows an en-dash, not a dot: a cold 30m
window must not look like "nothing is happening". On a mid-session restart the
tail re-reads today's whole recording, so the windows refill straight away; at
the open, or with TFA not recording, they are genuinely cold and say so.

Two views, toggled with V:
  B  table + meaning  — the default; every row explained in words
  A  table only       — compact, for scanning consistency across timeframes

Keys: V toggle view, 1-7 select window, F11 fullscreen, Esc quit.

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
    WINDOW_LABELS,
    WINDOWS,
    agreement,
    read_grid,
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

# The table spans 1-30 minutes; refreshing faster than once a second only burns
# CPU re-deriving windows that cannot have meaningfully changed.
REFRESH_MS = 1000
N_RULES = 15

VIEW_TABLE = "A"
VIEW_DETAIL = "B"

DETAIL_COL = len(WINDOWS) + 2      # 0 = name, 1..6 = windows, 7 = edge, 8 = detail
EDGE_COL = len(WINDOWS) + 1


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
        for c in range(1, 1 + len(WINDOWS)):
            body.columnconfigure(c, minsize=38)
        body.columnconfigure(EDGE_COL, minsize=60)
        body.columnconfigure(DETAIL_COL, weight=1)

        # header row
        tk.Label(body, text="rule", bg=HEAD, fg=DIM, font=("Segoe UI", 8),
                 anchor="w", padx=3).grid(row=0, column=0, sticky="ew", pady=(0, 2))
        for i, lab in enumerate(WINDOW_LABELS):
            tk.Label(body, text=lab, bg=HEAD, fg=DIM, font=("Consolas", 8),
                     anchor="center").grid(row=0, column=1 + i, sticky="ew", pady=(0, 2))
        tk.Label(body, text="edge", bg=HEAD, fg=DIM, font=("Consolas", 8),
                 anchor="e", padx=3).grid(row=0, column=EDGE_COL, sticky="ew", pady=(0, 2))
        self.hdr_detail = tk.Label(body, text="detail", bg=HEAD, fg=DIM,
                                   font=("Segoe UI", 8), anchor="w", padx=4)

        # rule rows
        self.rows = []
        for r in range(N_RULES):
            name = tk.Label(body, text="", bg=PANEL, fg=DIM, font=("Segoe UI", 8),
                            anchor="w", padx=3)
            name.grid(row=1 + r, column=0, sticky="ew")
            cells = []
            for i in range(len(WINDOWS)):
                c = tk.Label(body, text="", bg=PANEL, fg=FAINT,
                             font=("Consolas", 9), anchor="center")
                c.grid(row=1 + r, column=1 + i, sticky="ew")
                cells.append(c)
            edge = tk.Label(body, text="", bg=PANEL, fg=FAINT,
                            font=("Consolas", 7), anchor="e", padx=3)
            edge.grid(row=1 + r, column=EDGE_COL, sticky="ew")
            detail = tk.Label(body, text="", bg=PANEL, fg=DIM,
                              font=("Consolas", 8), anchor="w", padx=4)
            self.rows.append((name, cells, edge, detail))

        self.footer = tk.Label(self.frame, text="", bg=PANEL, fg=DIM,
                               font=("Consolas", 8), anchor="w")
        self.footer.pack(fill="x", padx=8, pady=(0, 5))
        self.apply_view()

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
                cells[0].grid(row=1 + r, column=1, columnspan=len(WINDOWS), sticky="ew")
                for c in cells[1:]:
                    c.grid_forget()
            else:
                for i, sec in enumerate(WINDOWS):
                    rd = grid[sec][r]
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
                agree = agreement(grid, r, sel)
                text = ref.meaning or ref.detail
                if agree and ref.rule not in INSTANTANEOUS:
                    text = f"{text}   [{agree}]"
                detail_w.config(text=text, fg=FG if ref.verdict != NEUTRAL else DIM)

        if self.app.view == VIEW_TABLE:
            self.footer.config(text=f"{sel_label}: {sel_reads[-1].meaning}", fg=DIM)


class App:
    def __init__(self, root: tk.Tk, src, instruments=INSTRUMENTS,
                 view: str = VIEW_TABLE):
        self.root = root
        self.src = src
        self.view = view
        self.window = DEFAULT_WINDOW
        root.title("Market Status Screen")
        root.configure(bg=BG)

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
            root.bind(f"<KeyPress-{i + 1}>",
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
                  f"– not enough history yet   |   "
                  f"V view, 1-7 window, F11 fullscreen, Esc quit")
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
