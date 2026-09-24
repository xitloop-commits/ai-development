"""TCS2 - replace the feed's closing OI with the exchange's official figure.

Spec: docs/systems/14_tcs2.md  (D34, D32, D43)

**What the feed sees at the close is not the official number.** Measured against
Dhan's daily candles on 2026-09-23/24:

    CRUDEOIL 15 OCT 9500 CE   feed 6,678      official 5,643    -15.5%
    NIFTY 29 SEP 23500 CE     feed 10,461,425 official 10,282,090  -179,335
    NIFTY 29 SEP 23400 PE     feed 6,240,390  official 6,111,560   -128,830

Every revision measured was downward - the exchange nets positions at settlement.
15.5% is enough to change what a multi-day OI build looks like, so an end-of-day
row has to say which number it holds.

**It cannot be had for free.** The next session's first value differs from the
previous official close too, because the first minute's candle already contains
trading, so the pristine opening value is not observable.

**Post-session, never pre-session** (D34). The official data only exists after the
close, and fetching is rate-limited at ~1.3 s a call: 4,060 legs is about 88
minutes, and even the ~40% carrying OI is ~35 minutes. The 08:54 startup cannot
absorb that when MCX opens six minutes later.

**It CATCHES UP rather than targeting one day** (D50). Dhan publishes late, and by
more than a night: measured 02:35 on 2026-09-25, the most recent daily candle for
NIFTY, CRUDEOIL futures and CRUDEOIL options alike was **2026-09-23** - so
2026-09-24 was still absent eleven hours after its close. Any fixed rule, whether
"the same night" or "07:30 the next morning", would therefore skip days, and MCX
closing at 23:30 leaves even less margin than NSE's 15:30.

So each run asks a different question: *which recent days still hold only feed
rows, and which of those has Dhan published?* Whatever is ready gets corrected.
Nothing is missed because a run happened too early, and running twice costs
nothing.

    python -m tcs2.oi_correct --instrument nifty50            # catch up
    python -m tcs2.oi_correct --instrument crudeoil --date 2026-09-24
    python -m tcs2.oi_correct --instrument nifty50 --dry-run
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
import time
from dataclasses import dataclass, field

from . import config as cfg
from . import feed as feedmod
from . import store as st
from .history import DhanHistory, HistoryError, estimate_runtime
from .store import Store


@dataclass
class CorrectionReport:
    instrument: str
    trade_date: str
    considered: int = 0
    fetched: int = 0
    corrected: int = 0
    unchanged: int = 0
    missing: int = 0          # Dhan had nothing for that contract/date
    skipped_no_oi: int = 0
    failed: int = 0
    total_abs_change: int = 0
    largest_change_pct: float = 0.0
    largest_change_leg: str = ""
    seconds: float = 0.0
    errors: list[str] = field(default_factory=list)

    def summary(self) -> str:
        return (
            f"{self.instrument} {self.trade_date}: "
            f"{self.corrected:,} corrected of {self.fetched:,} fetched "
            f"({self.considered:,} legs considered, "
            f"{self.skipped_no_oi:,} skipped with no OI), "
            f"{self.missing:,} missing, {self.failed:,} failed, "
            f"{self.seconds / 60:.1f} min"
            + (f"  | largest change {self.largest_change_pct:+.1f}% on "
               f"{self.largest_change_leg}" if self.largest_change_leg else ""))


def correct_day(instrument: str, trade_date: str, store: Store,
                history: DhanHistory, dry_run: bool = False,
                limit: int | None = None,
                progress_every: int = 100) -> CorrectionReport:
    """Rewrite one day's end-of-day rows with the exchange's official OI.

    Reads the rows we already wrote from the feed, asks Dhan for each contract's
    official closing OI, and writes a fresh set tagged `official` — leaving the
    `feed` rows in place. Both are kept on purpose: the difference between them is
    a measurement of how much the exchange revised, and throwing away the feed
    version would make that unrecoverable.
    """
    rep = CorrectionReport(instrument=instrument, trade_date=trade_date)
    started = time.time()
    cap = cfg.CAPABILITIES[instrument]

    rows = [r for r in store.read_eod(instrument)
            if r["meta"]["d"] == trade_date and r["meta"]["src"] == st.FROM_FEED]
    rep.considered = len(rows)
    if not rows:
        rep.errors.append("no feed rows for that day - run the session first")
        return rep

    # Only legs carrying open interest are worth a call. Measured 2026-09-24:
    # about 40% of a chain is active, which is the difference between an 88
    # minute pass and a 35 minute one.
    live = [r for r in rows if (r.get("oi_close") or 0) > 0]
    rep.skipped_no_oi = len(rows) - len(live)
    if limit:
        live = live[:limit]

    corrected: list[dict] = []
    for i, row in enumerate(live, 1):
        meta = row["meta"]
        sid = str(meta["sid"])
        try:
            official = history.official_oi(
                sid, cap.segment, cap.option_instrument, trade_date)
            rep.fetched += 1
        except HistoryError as exc:
            rep.failed += 1
            rep.errors.append(f"{sid}: {exc}"[:160])
            continue

        if official is None:
            # Dhan has nothing for this contract on this date. Old expiries
            # return no candles at all, and that must never be read as an OI of
            # zero - so the row is left as `feed` rather than written wrong.
            rep.missing += 1
            continue

        feed_oi = int(row.get("oi_close") or 0)
        new = dict(row)
        new.pop("_id", None)
        new.pop("meta", None)
        new.pop("t", None)
        new.update({
            "sid": meta["sid"], "strike": meta["strike"], "side": meta["side"],
            "exp": meta["exp"], "oi_close": official,
            "oi_feed_close": feed_oi,
            "oi_revision": official - feed_oi,
        })
        corrected.append(new)

        if official == feed_oi:
            rep.unchanged += 1
        else:
            rep.corrected += 1
            delta = abs(official - feed_oi)
            rep.total_abs_change += delta
            pct = (official - feed_oi) / feed_oi * 100.0 if feed_oi else 0.0
            if abs(pct) > abs(rep.largest_change_pct):
                rep.largest_change_pct = pct
                rep.largest_change_leg = (
                    f"{meta['strike']:,.0f} {meta['side']} {meta['exp']}")

        if progress_every and i % progress_every == 0:
            done = i / len(live)
            left = (time.time() - started) / max(done, 1e-9) * (1 - done)
            print(f"  {i:,}/{len(live):,} ({done * 100:.0f}%)  "
                  f"~{left / 60:.1f} min left", flush=True)

    if corrected and not dry_run:
        # Idempotent: a re-run replaces the official rows rather than adding a
        # second set. Time-series collections accept no unique index (D24), so
        # this is the caller's job, not the database's.
        store.clear_eod(instrument, trade_date, source=st.FROM_OFFICIAL)
        store.write_eod(instrument, trade_date, corrected,
                        source=st.FROM_OFFICIAL)

    rep.seconds = time.time() - started
    return rep


def pending_days(instrument: str, store: Store, lookback_days: int = 10,
                 today: dt.date | None = None) -> list[str]:
    """Recent days that still hold only feed rows, oldest first.

    A day is pending when it has `feed` end-of-day rows and no `official` ones.
    That is the whole state this job needs: no marker file, no last-run
    timestamp, nothing to get out of step with reality.
    """
    cutoff = ((today or dt.date.today()) - dt.timedelta(days=lookback_days)).isoformat()
    feed_days: set[str] = set()
    official_days: set[str] = set()
    for r in store.read_eod(instrument, since=cutoff):
        meta = r["meta"]
        (official_days if meta["src"] == st.FROM_OFFICIAL else feed_days).add(meta["d"])
    return sorted(feed_days - official_days)


def catch_up(instrument: str, store: Store, history: DhanHistory,
             lookback_days: int = 10, dry_run: bool = False,
             limit: int | None = None,
             today: dt.date | None = None) -> list[CorrectionReport]:
    """Correct every pending day Dhan has published. Skip the rest, silently.

    Self-healing by design: a day Dhan publishes two days late is picked up on
    whichever run first finds it, rather than being lost because the one
    scheduled attempt was too early (D50).
    """
    cap = cfg.CAPABILITIES[instrument]
    out: list[CorrectionReport] = []
    days = pending_days(instrument, store, lookback_days, today)
    if not days:
        return out

    # One probe tells us how far Dhan has got. Cheaper than discovering it 591
    # calls into a pass.
    probe_sid = None
    for r in store.read_eod(instrument, since=days[0]):
        if (r.get("oi_close") or 0) > 0:
            probe_sid = str(r["meta"]["sid"])
            break
    latest = None
    if probe_sid:
        try:
            latest = history.latest_published_day(
                probe_sid, cap.segment, cap.option_instrument)
        except HistoryError:
            latest = None

    for day in days:
        if latest is not None and day > latest:
            rep = CorrectionReport(instrument=instrument, trade_date=day)
            rep.errors.append(f"not published yet (Dhan has up to {latest})")
            out.append(rep)
            continue
        out.append(correct_day(instrument, day, store, history,
                               dry_run=dry_run, limit=limit))
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Replace feed closing OI with the exchange's official figure")
    ap.add_argument("--instrument", choices=cfg.INSTRUMENTS, required=True)
    ap.add_argument("--date", help="YYYY-MM-DD; omit to catch up every pending day")
    ap.add_argument("--lookback", type=int, default=10,
                    help="how many days back to look for pending days")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would change without writing")
    ap.add_argument("--limit", type=int, help="only the first N legs")
    args = ap.parse_args(argv)

    store = Store()
    store.ensure_collections()
    token, cid = feedmod.load_credentials()
    history = DhanHistory(token, cid)

    if not args.date:
        # Catch-up mode (D50). Never defaults to today: at 07:30 "today" has not
        # traded yet, and Dhan is more than a night behind anyway.
        pending = pending_days(args.instrument, store, args.lookback)
        if not pending:
            print(f"{args.instrument}: nothing pending in the last "
                  f"{args.lookback} days")
            return 0
        print(f"{args.instrument}: {len(pending)} day(s) pending -> "
              f"{', '.join(pending)}")
        reports = catch_up(args.instrument, store, history,
                           lookback_days=args.lookback, dry_run=args.dry_run,
                           limit=args.limit)
        print()
        failed = 0
        for rep in reports:
            print(f"  {rep.summary()}")
            if rep.errors and rep.corrected == 0 and rep.fetched == 0:
                print(f"      {rep.errors[0]}")
            failed += rep.failed
        print()
        print(f"history calls {history.stats.calls:,}, "
              f"rate-limited {history.stats.rate_limited:,}, "
              f"waited {history.stats.seconds_waiting / 60:.1f} min")
        return 1 if failed else 0

    trade_date = args.date

    rows = [r for r in store.read_eod(args.instrument)
            if r["meta"]["d"] == trade_date and r["meta"]["src"] == st.FROM_FEED]
    live = [r for r in rows if (r.get("oi_close") or 0) > 0]
    n = min(len(live), args.limit) if args.limit else len(live)
    print(f"{args.instrument} {trade_date}: {len(rows):,} feed rows, "
          f"{len(live):,} carry OI, fetching {n:,}")
    print(f"estimated {estimate_runtime(n) / 60:.1f} min at "
          f"{history.min_interval_sec}s per call"
          + ("  (dry run)" if args.dry_run else ""))

    # Check the day is published before spending up to 88 minutes finding out it
    # is not. Measured 2026-09-25: the most recent daily candle was 2026-09-23,
    # so a day's official OI is NOT available immediately after its own close.
    if live:
        cap = cfg.CAPABILITIES[args.instrument]
        try:
            latest = history.latest_published_day(
                str(live[0]["meta"]["sid"]), cap.segment, cap.option_instrument)
        except Exception as exc:                      # noqa: BLE001
            print(f"could not check the published day: {exc}", file=sys.stderr)
            latest = None
        if latest:
            print(f"Dhan's most recent published day: {latest}")
            if latest < trade_date:
                print(f"{trade_date} is not published yet - nothing to correct. "
                      f"Run again once Dhan has it.")
                return 0

    rep = correct_day(args.instrument, trade_date, store, history,
                      dry_run=args.dry_run, limit=args.limit)
    print()
    print(rep.summary())
    if rep.errors:
        print(f"first errors: {rep.errors[:3]}")
    print(f"history calls {history.stats.calls:,}, "
          f"rate-limited {history.stats.rate_limited:,}, "
          f"waited {history.stats.seconds_waiting / 60:.1f} min")
    return 0 if not rep.errors else 1


if __name__ == "__main__":
    sys.exit(main())
