"""Market Status Screen — 2x2, four instruments, order flow read live.

Spec: docs/systems/12_market_status_screen.md

    +---------------------+---------------------+
    |      NIFTY 50       |      BANKNIFTY      |
    +---------------------+---------------------+
    |      CRUDE OIL      |     NATURAL GAS     |
    +---------------------+---------------------+

Each quadrant shows Partha's 15 order-flow rules, each with a POSITIVE /
NEGATIVE / WATCH light and its MEASURED track record.

Run:
  python -m market_screen.app                      # live (tails TFA's recordings)
  python -m market_screen.app --source ws          # live via the server relay
  python -m market_screen.app --replay 2026-09-11  # a recorded day
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
from .verdicts import NEGATIVE, NEUTRAL, POSITIVE, WATCH, read_all

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
FG = "#c9d1d9"
DIM = "#6e7681"
COLOURS = {
    POSITIVE: "#3fb950",
    NEGATIVE: "#f85149",
    WATCH: "#d29922",
    NEUTRAL: "#6e7681",
}

REFRESH_MS = 500        # redraw twice a second; the tape is read continuously
WINDOW_SEC = 300        # rule 15 confirmation window shown on screen


class Quadrant:
    def __init__(self, parent: tk.Widget, instrument: str):
        self.instrument = instrument
        self.flow = FlowState()
        self.last_tick_ts: Optional[float] = None
        self.tick_count = 0

        self.frame = tk.Frame(parent, bg=PANEL, highlightbackground=BORDER,
                              highlightthickness=1)
        head = tk.Frame(self.frame, bg=PANEL)
        head.pack(fill="x", padx=10, pady=(8, 2))
        self.title = tk.Label(head, text=TITLES[instrument], bg=PANEL, fg=FG,
                              font=("Segoe UI", 13, "bold"), anchor="w")
        self.title.pack(side="left")
        self.price = tk.Label(head, text="-", bg=PANEL, fg=FG,
                              font=("Consolas", 13, "bold"), anchor="e")
        self.price.pack(side="right")

        self.summary = tk.Label(self.frame, text="waiting for ticks", bg=PANEL,
                                fg=DIM, font=("Segoe UI", 10, "bold"), anchor="w")
        self.summary.pack(fill="x", padx=10, pady=(0, 4))

        body = tk.Frame(self.frame, bg=PANEL)
        body.pack(fill="both", expand=True, padx=10, pady=(0, 8))
        body.columnconfigure(1, weight=1)

        self.rows = []
        for i in range(15):
            name = tk.Label(body, text="", bg=PANEL, fg=DIM,
                            font=("Segoe UI", 9), anchor="w")
            detail = tk.Label(body, text="", bg=PANEL, fg=FG,
                              font=("Consolas", 9), anchor="w")
            light = tk.Label(body, text="", bg=PANEL, fg=DIM,
                             font=("Segoe UI", 9, "bold"), anchor="e", width=9)
            edge = tk.Label(body, text="", bg=PANEL, fg=DIM,
                            font=("Consolas", 8), anchor="e", width=14)
            name.grid(row=i, column=0, sticky="w", padx=(0, 6))
            detail.grid(row=i, column=1, sticky="ew")
            light.grid(row=i, column=2, sticky="e", padx=(6, 4))
            edge.grid(row=i, column=3, sticky="e")
            self.rows.append((name, detail, light, edge))

    def on_tick(self, tick: dict) -> None:
        self.flow.on_tick(tick)
        self.tick_count += 1
        ts = tick.get("recv_ts")
        if ts:
            self.last_tick_ts = ts

    def redraw(self) -> None:
        px = self.flow._last_price
        self.price.config(text=f"{px:,.2f}" if px else "-")

        snap = self.flow.snapshot(now=self.last_tick_ts)
        reads = read_all(snap, WINDOW_SEC)

        overall = reads[-1] if reads and reads[-1].rule == 15 else None
        if overall:
            self.summary.config(
                text=f"{overall.verdict}  -  {overall.detail}   |   {self.tick_count:,} ticks",
                fg=COLOURS.get(overall.verdict, DIM),
            )

        for i, (name_w, detail_w, light_w, edge_w) in enumerate(self.rows):
            if i >= len(reads):
                name_w.config(text=""); detail_w.config(text="")
                light_w.config(text=""); edge_w.config(text="")
                continue
            r = reads[i]
            colour = COLOURS.get(r.verdict, DIM)
            name_w.config(text=f"{r.rule:>2}. {r.name}")
            detail_w.config(text=r.detail, fg=FG if r.verdict != NEUTRAL else DIM)
            light_w.config(
                text="" if r.verdict == NEUTRAL else r.verdict,
                fg=colour,
            )
            edge_w.config(text=r.edge_label if r.edge is not None else "",
                          fg="#8b949e" if r.edge is not None and abs(r.edge) < 3 else DIM)
            if r.rule == 15:
                name_w.config(fg=colour, font=("Segoe UI", 9, "bold"))
                detail_w.config(fg=colour)


class App:
    def __init__(self, root: tk.Tk, src, instruments=INSTRUMENTS):
        self.root = root
        self.src = src
        root.title("Market Status Screen")
        root.configure(bg=BG)

        grid = tk.Frame(root, bg=BG)
        grid.pack(fill="both", expand=True)
        for i in range(2):
            grid.rowconfigure(i, weight=1, uniform="q")
            grid.columnconfigure(i, weight=1, uniform="q")

        self.quads = {}
        for inst in instruments:
            q = Quadrant(grid, inst)
            r, c = GRID[inst]
            q.frame.grid(row=r, column=c, sticky="nsew", padx=3, pady=3)
            self.quads[inst] = q

        self.status = tk.Label(root, text="", bg=BG, fg=DIM,
                               font=("Consolas", 9), anchor="w")
        self.status.pack(fill="x", padx=6, pady=(0, 4))

        root.bind("<Escape>", lambda e: self.quit())
        root.bind("<F11>", lambda e: root.attributes(
            "-fullscreen", not root.attributes("-fullscreen")))
        root.protocol("WM_DELETE_WINDOW", self.quit)
        self.tick()

    def tick(self) -> None:
        drained = 0
        while drained < 8000:
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

        self.status.config(
            text=(f"{getattr(self.src, 'status', '?')}   |   "
                  f"{datetime.now():%H:%M:%S}   |   window {WINDOW_SEC // 60}m   |   "
                  f"edge = measured vs base rate, 77 nifty days; inside +/-3pp is noise   |   "
                  f"F11 fullscreen, Esc quit")
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
    root.geometry("1600x1000")
    if args.fullscreen:
        root.attributes("-fullscreen", True)
    App(root, src)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
