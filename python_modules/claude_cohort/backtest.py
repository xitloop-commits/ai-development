"""Claude cohort — walk-forward, charge-aware backtest.

Spec: docs/systems/13_claude_cohort.md §8.

Verdict in RUPEES after real charges, not in AUC. Strictly out-of-sample: the
parameter sweep for each test chunk sees only days BEFORE it.

Fills come from the recorded ATM option book in the feature parquet:
  buy  at `opt_0_<leg>_ask`   (we cross the spread)
  sell at `opt_0_<leg>_bid`
Entries are only allowed on minute boundaries; exits are checked on EVERY row,
so the stop has tick resolution rather than minute resolution.

Run:
  python -m claude_cohort.backtest --instrument nifty50 --setup break_with_flow
  python -m claude_cohort.backtest --instrument nifty50 --setup failed_move
  python -m claude_cohort.backtest --instrument banknifty --no-sweep
"""
from __future__ import annotations

import argparse
import glob
import os
import statistics
from dataclasses import dataclass, asdict
from typing import Iterable, Optional

from .config import (
    EOD_CUTS,
    LOT_SIZES,
    Params,
    assert_causal,
    exchange_for,
    round_trip_charges,
    sweep_params,
)
from .book import load_book, quote_at
from .rules import (
    RULE_INPUTS,
    liquidity_gate_quote,
    SETUP_A,
    SETUP_B,
    Position,
    SessionState,
    evaluate_entry,
    evaluate_exit,
)

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FEATURES_DIR = os.path.join(_ROOT, "data", "features")

# Square off this many minutes before the close. Uses `minutes_to_close` so no
# timezone handling is needed; EOD_CUTS documents the intent per instrument.
EOD_EXIT_MIN_TO_CLOSE = 10.0

MIN_TRAIN_DAYS = 20
TEST_CHUNK_DAYS = 5


@dataclass
class Trade:
    date: str
    setup: str
    leg: str
    entry_ts: float
    exit_ts: float
    entry_underlying: float
    exit_underlying: float
    entry_premium: float
    exit_premium: float
    lots: int
    qty: int
    gross: float
    charges: float
    net: float
    exit_reason: str
    held_min: float

    @property
    def is_win(self) -> bool:
        return self.net > 0


# ── data ─────────────────────────────────────────────────────────────────


def available_dates(instrument: str) -> list[str]:
    pat = os.path.join(FEATURES_DIR, "*", f"{instrument}_features.parquet")
    return sorted(os.path.basename(os.path.dirname(p)) for p in glob.glob(pat))


_DAY_CACHE: dict = {}
_BOOK_CACHE: dict = {}


def load_book_cached(instrument: str, date: str):
    key = (instrument, date)
    if key not in _BOOK_CACHE:
        _BOOK_CACHE[key] = load_book(instrument, date)
    return _BOOK_CACHE[key]


def load_day(instrument: str, date: str, cache: bool = True):
    """Load only the columns the rules are allowed to read.

    Cached: the parameter sweep re-runs the same day dozens of times and the
    parquet read is ~6x the cost of the simulation itself (0.95s vs 0.16s).

    Restricting the read is the cheapest possible look-ahead guard: a forward
    label cannot leak into a rule if it was never loaded.
    """
    import pandas as pd

    key = (instrument, date)
    if cache and key in _DAY_CACHE:
        return _DAY_CACHE[key]

    path = os.path.join(FEATURES_DIR, date, f"{instrument}_features.parquet")
    # Read the schema cheaply, then intersect with RULE_INPUTS.
    import pyarrow.parquet as pq

    schema = pq.ParquetFile(path).schema_arrow
    cols = [c for c in RULE_INPUTS if c in set(schema.names)]
    assert_causal(cols)
    df = pd.read_parquet(path, columns=cols)
    if "timestamp" in df.columns:
        df = df.sort_values("timestamp").reset_index(drop=True)
    if cache:
        _DAY_CACHE[key] = df
    return df


# ── simulation ───────────────────────────────────────────────────────────


def pick_atm_strike(book: dict, leg: str, underlying: float, sec: int) -> Optional[float]:
    """Nearest quotable strike to spot for this leg — the contract we buy.

    Quotable matters: the nearest strike with no live quote is not tradeable, and
    silently falling through to it would fabricate fills.
    """
    best, best_d = None, None
    for (strike, otype), series in book.items():
        if otype != leg:
            continue
        d = abs(strike - underlying)
        if best_d is not None and d >= best_d:
            continue
        if quote_at(series, sec, max_stale_sec=30) is None:
            continue
        best, best_d = strike, d
    return best


def simulate_day(
    instrument: str,
    date: str,
    df,
    p: Params,
    allow: tuple[str, ...],
    lots: int = 1,
    book: Optional[dict] = None,
) -> list[Trade]:
    """Run one day. Returns closed trades.

    `book` is the per-contract option book from book.py and is REQUIRED — every
    fill is priced on the contract the trade actually holds.
    """
    lot_size = LOT_SIZES[instrument]
    qty = lot_size * lots
    exch = exchange_for(instrument)

    if book is None:
        raise ValueError(
            f"No per-contract book for {instrument} {date}. Build it first: "
            f"python -m claude_cohort.book --instrument {instrument}. "
            f"Pricing off the rolling ATM slot is what produced profitable stop-losses."
        )

    state = SessionState()
    trades: list[Trade] = []
    last_minute = -1

    records = df.to_dict("records")
    for row in records:
        ts = row.get("timestamp")
        if ts is None:
            continue
        mtc = row.get("minutes_to_close")
        eod = mtc is not None and mtc == mtc and mtc <= EOD_EXIT_MIN_TO_CLOSE

        # ---- manage an open position on EVERY row (tick-resolution stops)
        pos = state.position
        if pos is not None:
            reason = evaluate_exit(row, pos, p, state=state, eod=eod)
            if reason == "target_half" and lots < 2:
                # A half exit is impossible with one lot. Degrade to a full exit
                # at the target rather than silently ignoring the rule.
                reason = "target"
            leg_series = book.get((pos.strike, pos.leg))
            q = quote_at(leg_series, int(ts), max_stale_sec=300 if eod else 30) if leg_series else None

            if reason == "target_half":
                if q and q[0] > 0:
                    pos.half_done = True
                    pos.half_premium = float(q[0])
            elif reason is not None:
                if q is None or q[0] <= 0:
                    # No usable quote. HOLD rather than invent a price — booking a
                    # frozen or zero fill is findings bugs 2 and 6.
                    continue
                exit_prem = float(q[0])   # we sell into the bid

                if pos.half_done:
                    half_qty = qty // 2
                    rest_qty = qty - half_qty
                    buy_value = pos.entry_premium * qty
                    sell_value = pos.half_premium * half_qty + exit_prem * rest_qty
                    gross = sell_value - buy_value
                    eff_exit = sell_value / qty
                else:
                    buy_value = pos.entry_premium * qty
                    sell_value = exit_prem * qty
                    gross = sell_value - buy_value
                    eff_exit = exit_prem

                charges = round_trip_charges(buy_value, sell_value, exch)
                net = gross - charges
                trades.append(
                    Trade(
                        date=date,
                        setup=pos.setup,
                        leg=pos.leg,
                        entry_ts=pos.entry_ts,
                        exit_ts=float(ts),
                        entry_underlying=pos.entry_underlying,
                        exit_underlying=float(row.get("underlying_ltp") or 0.0),
                        entry_premium=pos.entry_premium,
                        exit_premium=eff_exit,
                        lots=lots,
                        qty=qty,
                        gross=round(gross, 2),
                        charges=charges,
                        net=round(net, 2),
                        exit_reason=reason,
                        held_min=round((float(ts) - pos.entry_ts) / 60.0, 2),
                    )
                )
                state.position = None
                state.trades_today += 1
                if net <= 0:
                    state.losses_today += 1
            continue  # one position at a time — never enter on an exit row

        # ---- entries only on minute boundaries
        minute = int(ts // 60)
        if minute == last_minute:
            continue
        last_minute = minute
        state.note_decision_point(float(ts), row)
        if eod:
            continue

        sig = evaluate_entry(row, state, p, allow=allow)
        if sig is None:
            continue

        # Lock the contract: nearest strike to spot that is actually quotable.
        strike = pick_atm_strike(book, sig.leg, sig.underlying, int(ts))
        if strike is None:
            continue
        q = quote_at(book[(strike, sig.leg)], int(ts), max_stale_sec=30)
        if q is None:
            continue
        bid, ask = float(q[0]), float(q[1])
        delta = row.get("atm_ce_delta" if sig.leg == "CE" else "atm_pe_delta") or 0.0
        ok, _why = liquidity_gate_quote(bid, ask, float(delta), sig.target_pts, p)
        if not ok:
            continue

        ofi = row.get("underlying_ofi_20") or 0.0
        state.position = Position(
            setup=sig.setup,
            leg=sig.leg,
            entry_ts=sig.ts,
            entry_underlying=sig.underlying,
            entry_premium=ask,      # we buy the offer
            strike=strike,
            stop_pts=sig.stop_pts,
            target_pts=sig.target_pts,
            entry_ofi_sign=1 if ofi > 0 else (-1 if ofi < 0 else 0),
            lots=lots,
        )

    return trades


def run_days(
    instrument: str, dates: Iterable[str], p: Params, allow: tuple[str, ...], lots: int = 1
) -> list[Trade]:
    out: list[Trade] = []
    for d in dates:
        try:
            df = load_day(instrument, d)
            bk = load_book_cached(instrument, d)
        except Exception as exc:  # truncated / corrupt recordings are expected
            print(f"  [skip] {d}: {type(exc).__name__}: {exc}")
            continue
        if bk is None:
            continue  # no contract book for this day -> cannot price it honestly
        out.extend(simulate_day(instrument, d, df, p, allow, lots, book=bk))
    return out


# ── walk-forward ─────────────────────────────────────────────────────────


def walk_forward(
    instrument: str, dates: list[str], allow: tuple[str, ...], lots: int, sweep: bool
) -> tuple[list[Trade], list[dict]]:
    """Out-of-sample trades plus the parameter chosen for each test chunk."""
    oos: list[Trade] = []
    chosen: list[dict] = []

    if not sweep:
        p = Params()
        print(f"  fixed params, no sweep — zero selection bias")
        oos = run_days(instrument, dates, p, allow, lots)
        chosen.append({"chunk": "all", "params": asdict(p)})
        return oos, chosen

    i = MIN_TRAIN_DAYS
    while i < len(dates):
        test = dates[i : i + TEST_CHUNK_DAYS]
        train = dates[:i]
        best_p, best_net = None, None
        for cand in sweep_params():
            t = run_days(instrument, train[-40:], cand, allow, lots)
            if not t:
                continue
            net = sum(x.net for x in t)
            if best_net is None or net > best_net:
                best_p, best_net = cand, net
        if best_p is None:
            best_p = Params()
        chosen.append(
            {
                "chunk": f"{test[0]}..{test[-1]}",
                "train_days": len(train),
                "train_net": round(best_net or 0.0, 2),
                "params": {k: getattr(best_p, k) for k in ("adx_min", "stop_pct", "target_r", "time_stop_min")},
            }
        )
        oos.extend(run_days(instrument, test, best_p, allow, lots))
        i += TEST_CHUNK_DAYS
    return oos, chosen


# ── reporting ────────────────────────────────────────────────────────────


def _fmt(n: float) -> str:
    return f"Rs {n:,.0f}"


def report(trades: list[Trade], label: str, dates: list[str], instrument: str) -> dict:
    print(f"\n{'=' * 68}\n{label}\n{'=' * 68}")
    if not trades:
        print("NO TRADES. Either the gates never opened or the data was unusable.")
        return {"trades": 0}

    nets = [t.net for t in trades]
    wins = [t for t in trades if t.is_win]
    gross = sum(t.gross for t in trades)
    charges = sum(t.charges for t in trades)
    net = sum(nets)

    print(f"trades          {len(trades)}   over {len(set(t.date for t in trades))} trading days")
    print(f"win rate        {100.0 * len(wins) / len(trades):.0f}%")
    print(f"gross           {_fmt(gross)}")
    print(f"charges         {_fmt(charges)}")
    print(f"NET             {_fmt(net)}    ({_fmt(net / len(trades))}/trade)")
    print(f"median trade    {_fmt(statistics.median(nets))}")
    if wins and len(wins) < len(trades):
        aw = statistics.mean(t.net for t in wins)
        al = abs(statistics.mean(t.net for t in trades if not t.is_win))
        wr = len(wins) / len(trades)
        need = 1.0 / wr - 1.0
        print(f"avg win/loss    {aw / al:.2f}   (needs > {need:.2f} at this win rate)")

    # -- concentration (spec §8: always run this)
    print("\nconcentration — net excluding the biggest winners:")
    ordered = sorted(nets, reverse=True)
    for k in (1, 3, 5):
        if len(ordered) > k:
            print(f"  ex-top{k}       {_fmt(net - sum(ordered[:k]))}")

    # -- per month, judged independently
    print("\nper month (judged independently):")
    months: dict[str, list[float]] = {}
    for t in trades:
        months.setdefault(t.date[:7], []).append(t.net)
    pos_months = 0
    for m in sorted(months):
        s = sum(months[m])
        pos_months += s > 0
        print(f"  {m}      {_fmt(s):>14}   ({len(months[m])} trades)")
    print(f"  -> {pos_months} of {len(months)} months positive")

    # -- is this just market direction?
    print("\nmarket-direction check:")
    by_leg: dict[str, list[float]] = {}
    for t in trades:
        by_leg.setdefault(t.leg, []).append(t.net)
    for leg in sorted(by_leg):
        v = by_leg[leg]
        print(f"  {leg}          {_fmt(sum(v)):>14}   ({len(v)} trades, {_fmt(sum(v) / len(v))}/trade)")

    # -- exit reasons tell you which rule is doing the work
    print("\nexit reasons:")
    reasons: dict[str, list[float]] = {}
    for t in trades:
        reasons.setdefault(t.exit_reason, []).append(t.net)
    for r in sorted(reasons, key=lambda r: -len(reasons[r])):
        v = reasons[r]
        print(f"  {r:<16} {len(v):>4} trades   {_fmt(sum(v)):>14}")

    held = [t.held_min for t in trades]
    print(f"\nhold time       median {statistics.median(held):.0f} min, max {max(held):.0f} min")

    # -- verdict against the standing bar (spec §8)
    print("\nstanding validation bar:")
    n_days = len(dates)
    checks = [
        (f">= 60 OOS days", n_days >= 60, f"{n_days} days"),
        ("majority of months positive", pos_months * 2 > len(months), f"{pos_months}/{len(months)}"),
        ("survives removing top 3", len(ordered) > 3 and (net - sum(ordered[:3])) > 0, _fmt(net - sum(ordered[:3])) if len(ordered) > 3 else "n/a"),
        ("net positive after charges", net > 0, _fmt(net)),
    ]
    for name, ok, detail in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:<32} {detail}")

    return {
        "trades": len(trades),
        "win_rate": len(wins) / len(trades),
        "gross": gross,
        "charges": charges,
        "net": net,
        "months_positive": pos_months,
        "months": len(months),
    }


# ── cli ──────────────────────────────────────────────────────────────────


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Claude cohort walk-forward backtest")
    ap.add_argument("--instrument", default="nifty50", choices=sorted(LOT_SIZES))
    ap.add_argument("--setup", default="both", choices=[SETUP_A, SETUP_B, "both"])
    ap.add_argument("--lots", type=int, default=1)
    ap.add_argument("--no-sweep", action="store_true", help="fixed default params (no selection bias)")
    ap.add_argument("--limit-days", type=int, default=0, help="debug: only the first N days")
    args = ap.parse_args(argv)

    dates = available_dates(args.instrument)
    if args.limit_days:
        dates = dates[: args.limit_days]
    if not dates:
        print(f"No feature parquets for {args.instrument} under {FEATURES_DIR}")
        return 1

    allow = (SETUP_A, SETUP_B) if args.setup == "both" else (args.setup,)
    print(f"instrument   {args.instrument}   lot={LOT_SIZES[args.instrument]}   lots={args.lots}")
    print(f"days         {len(dates)}   {dates[0]} -> {dates[-1]}")
    print(f"setup(s)     {', '.join(allow)}")
    print(f"charges      production DEFAULT_CHARGES (STT 0.15% sell, txn 0.03553%)")

    trades, chosen = walk_forward(args.instrument, dates, allow, args.lots, sweep=not args.no_sweep)
    label = f"{args.instrument} / {'+'.join(allow)} / {'fixed params' if args.no_sweep else 'walk-forward sweep'}"
    report(trades, label, dates, args.instrument)

    if not args.no_sweep and chosen:
        print("\nparameters chosen per chunk (stability matters more than the values):")
        for c in chosen[:12]:
            print(f"  {c['chunk']}  {c.get('params')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
