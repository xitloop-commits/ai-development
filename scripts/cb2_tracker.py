#!/usr/bin/env python
"""cb2 vs candleblue daily tracker (2026-09-02).

Snapshots the current paper book's candleblue-vs-cb2 head-to-head and appends a
dated row per cohort to `logs/cb2_tracker.csv` (today's rows are upserted, so it
is safe to re-run). Also prints the comparison. Run it near end-of-day (after MCX
close ~23:35) to capture the full session before the book rolls.

Usage:  py scripts/cb2_tracker.py
"""
from __future__ import annotations

import csv
import datetime
import json
import os
import urllib.parse
import urllib.request

API = "http://localhost:3000/api/trpc/portfolio.currentDay"
CSV_PATH = os.path.join("logs", "cb2_tracker.csv")
COHORTS = ("candleblue", "cb2")
FIELDS = ["date", "cohort", "total", "closed", "open", "wins", "losses",
          "win_pct", "net_rs", "per_trade_rs"]


def fetch_trades() -> list[dict]:
    inp = urllib.parse.quote(json.dumps({"json": {"channel": "paper"}}))
    with urllib.request.urlopen(f"{API}?input={inp}", timeout=15) as r:
        data = json.load(r)
    return data["result"]["data"]["json"]["trades"]


def stats(trades: list[dict], cohort: str) -> dict:
    ts = [t for t in trades if t.get("cohort") == cohort]
    closed = [t for t in ts if t.get("pnl") is not None
              and t.get("status") not in ("OPEN", "PENDING", "CANCELLED")]
    open_n = sum(1 for t in ts if t.get("status") == "OPEN")
    wins = [t for t in closed if t["pnl"] > 0]
    losses = [t for t in closed if t["pnl"] < 0]
    net = sum(t["pnl"] for t in closed)
    return {
        "date": datetime.date.today().isoformat(),
        "cohort": cohort,
        "total": len(ts),
        "closed": len(closed),
        "open": open_n,
        "wins": len(wins),
        "losses": len(losses),
        "win_pct": round(len(wins) / len(closed) * 100, 1) if closed else 0.0,
        "net_rs": round(net),
        "per_trade_rs": round(net / len(closed)) if closed else 0,
    }


def upsert(rows: list[dict]) -> None:
    os.makedirs("logs", exist_ok=True)
    today = datetime.date.today().isoformat()
    existing: list[dict] = []
    if os.path.exists(CSV_PATH):
        with open(CSV_PATH, newline="") as f:
            existing = [r for r in csv.DictReader(f) if r.get("date") != today]
    with open(CSV_PATH, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for r in existing:
            w.writerow(r)
        for r in rows:
            w.writerow(r)


def main() -> None:
    trades = fetch_trades()
    rows = [stats(trades, c) for c in COHORTS]
    upsert(rows)
    print(f"cb2 vs candleblue — {datetime.date.today().isoformat()} (paper)")
    print(f"{'cohort':11} {'trades':>7} {'closed':>7} {'open':>5} {'W/L':>7} {'win%':>6} {'net Rs':>11} {'/trade':>9}")
    for r in rows:
        print(f"{r['cohort']:11} {r['total']:>7} {r['closed']:>7} {r['open']:>5} "
              f"{str(r['wins'])+'/'+str(r['losses']):>7} {r['win_pct']:>5}% "
              f"{r['net_rs']:>11,} {r['per_trade_rs']:>9,}")
    print(f"\nappended to {CSV_PATH}")


if __name__ == "__main__":
    main()
