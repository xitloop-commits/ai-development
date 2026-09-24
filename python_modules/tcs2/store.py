"""TCS2 - the database tiers: Now, intraday, end of day.

Spec: docs/systems/14_tcs2.md  (D23, D24, D29, D34, D43)

Three tiers, because they answer different questions (D23):

    Now        one document per leg, overwritten      what is the chain right now
    intraday   a row per OI change, kept 7 days       how positioning moved today
    end of day one row per strike per day, kept long  how it built over weeks

Chosen on measurement, not on precedent (D24). Benchmarked locally against
Mongo 7.0.9 with 200,000 rows:

    time-series collection   38,056 rows/sec   24.5 bytes/row all-in   6 ms query
    normal collection       130,340 rows/sec   69.3 bytes/row all-in  11 ms query

Time-series is 2.8x smaller all-in and answers the query we care about faster
**without an index**, while the plain collection needs a 4.2 MB index to be
slower. Its only advantage is insert speed, which is worthless when we need about
32 writes/sec against a 38,000/sec ceiling - 0.08% utilisation.

Nothing here is on the live path. The screen reads memory (D16), so this module
can batch generously; latency does not matter, only throughput and durability.

**Time-series collections accept no unique index** (D24), so a replay could
duplicate rows. Idempotency is therefore by design: `clear_intraday()` removes a
day before it is rewritten, and callers replaying a day must use it.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from pymongo import MongoClient, UpdateOne
from pymongo.errors import CollectionInvalid

DEFAULT_URI = "mongodb://localhost:27017/lucky_baskar"

CURRENT = "tcs2_chain_current"
INTRADAY = "tcs2_chain_intraday"
EOD = "tcs2_chain_eod"
DAILY = "tcs2_daily_record"

# D23: the intraday tier is a convenience copy - every OI value is also in the
# raw ticks, so it rebuilds exactly. Seven days covers reviewing the week and
# debugging a recent signal, which is all the fine detail is used for.
INTRADAY_RETENTION_DAYS = 7

# Provenance for an end-of-day row (D34). The exchange revises OI after the
# close - crude 9500 CE read 6,678 in the feed against an official 5,643, out by
# 15.5% - so a row must say which number it holds.
FROM_FEED = "feed"
FROM_OFFICIAL = "official"


@dataclass
class StoreStats:
    current_upserts: int = 0
    intraday_rows: int = 0
    eod_rows: int = 0
    daily_rows: int = 0
    batches: int = 0
    errors: list[str] = field(default_factory=list)


class Store:
    """TCS2's database. One per process; not shared between instruments (D14)."""

    def __init__(self, uri: str = DEFAULT_URI, database: str | None = None,
                 client: MongoClient | None = None) -> None:
        self._client = client or MongoClient(uri, serverSelectionTimeoutMS=5000)
        self.db = (self._client[database] if database
                   else self._client.get_default_database())
        self.stats = StoreStats()

    # -- setup -----------------------------------------------------------

    def ensure_collections(self) -> None:
        """Create the time-series collections if they are not there yet.

        `metaField` groups rows by leg so Mongo buckets and columnar-compresses
        them; `granularity` tells it how far apart rows in a bucket are. Getting
        the meta field wrong later is expensive, because it cannot be changed
        without rewriting the collection.
        """
        for name in (INTRADAY, EOD):
            try:
                self.db.create_collection(
                    name,
                    timeseries={"timeField": "t", "metaField": "meta",
                                "granularity": "minutes"})
            except CollectionInvalid:
                pass            # already exists
        self.db[CURRENT].create_index("instrument")

    # -- tier 1: Now -----------------------------------------------------

    def upsert_current(self, instrument: str, rows: Sequence[dict],
                       now: float | None = None) -> int:
        """Replace the current state of the legs given. Bounded, never grows.

        Measured at 13,102 upserts/sec, with a full 1,484-leg flush taking
        113 ms - a 2% duty cycle when flushed every five seconds.

        What earns its keep here is restart: a process coming back at 11:00
        reloads its chain instead of starting blind.
        """
        if not rows:
            return 0
        ts = dt.datetime.fromtimestamp(now) if now else dt.datetime.now()
        ops = [UpdateOne({"_id": r["sid"]},
                         {"$set": {**r, "instrument": instrument, "t": ts}},
                         upsert=True)
               for r in rows]
        self.db[CURRENT].bulk_write(ops, ordered=False)
        self.stats.current_upserts += len(ops)
        self.stats.batches += 1
        return len(ops)

    def load_current(self, instrument: str) -> list[dict]:
        """Everything we last knew about this instrument's legs."""
        return list(self.db[CURRENT].find({"instrument": instrument}))

    # -- tier 2: intraday ------------------------------------------------

    def write_intraday(self, instrument: str, changes: Iterable[Any],
                       trade_date: str | None = None) -> int:
        """One row per OI change (D23). Batched; never called per change."""
        docs = []
        for c in changes:
            docs.append({
                "t": dt.datetime.fromtimestamp(c.ts),
                "meta": {"inst": instrument, "sid": c.security_id,
                         "strike": c.strike, "side": "CE" if c.is_call else "PE",
                         "exp": c.expiry,
                         "d": trade_date or dt.date.today().isoformat()},
                "oi": c.oi, "doi": c.oi_delta, "ltp": c.ltp, "vol": c.volume,
            })
        if not docs:
            return 0
        self.db[INTRADAY].insert_many(docs, ordered=False)
        self.stats.intraday_rows += len(docs)
        self.stats.batches += 1
        return len(docs)

    def clear_intraday(self, instrument: str, trade_date: str) -> int:
        """Remove a day before rewriting it.

        Time-series collections accept no unique index (D24), so a replay would
        otherwise duplicate every row. Idempotency has to be the caller's job,
        and this is the tool for it.
        """
        res = self.db[INTRADAY].delete_many(
            {"meta.inst": instrument, "meta.d": trade_date})
        return res.deleted_count

    def read_intraday(self, instrument: str, security_id: int,
                      trade_date: str | None = None) -> list[dict]:
        q: dict = {"meta.inst": instrument, "meta.sid": security_id}
        if trade_date:
            q["meta.d"] = trade_date
        return list(self.db[INTRADAY].find(q).sort("t", 1))

    def prune_intraday(self, keep_days: int = INTRADAY_RETENTION_DAYS,
                       today: dt.date | None = None) -> int:
        """Drop intraday rows older than the retention window.

        Safe because every OI value is also in the raw ticks, which are kept for
        about a year (D20), so anything dropped here rebuilds exactly.
        """
        cutoff = (today or dt.date.today()) - dt.timedelta(days=keep_days)
        res = self.db[INTRADAY].delete_many({"meta.d": {"$lt": cutoff.isoformat()}})
        return res.deleted_count

    # -- tier 3: end of day ----------------------------------------------

    def write_eod(self, instrument: str, trade_date: str, rows: Sequence[dict],
                  source: str = FROM_FEED) -> int:
        """One row per strike per day (D23/D29 part 1).

        `source` records whether this is what our feed saw at the close or the
        exchange's revised figure (D34). A study has to know which it is reading:
        crude was out by 15.5%, which is enough to change what a multi-day OI
        build looks like.
        """
        if not rows:
            return 0
        stamp = dt.datetime.fromisoformat(trade_date + "T23:59:00")
        docs = [{
            "t": stamp,
            "meta": {"inst": instrument, "sid": r["sid"], "strike": r["strike"],
                     "side": r["side"], "exp": r["exp"], "d": trade_date,
                     "src": source},
            **{k: v for k, v in r.items()
               if k not in ("sid", "strike", "side", "exp")},
        } for r in rows]
        self.db[EOD].insert_many(docs, ordered=False)
        self.stats.eod_rows += len(docs)
        return len(docs)

    def clear_eod(self, instrument: str, trade_date: str,
                  source: str | None = None) -> int:
        q: dict = {"meta.inst": instrument, "meta.d": trade_date}
        if source:
            q["meta.src"] = source
        return self.db[EOD].delete_many(q).deleted_count

    def read_eod(self, instrument: str, security_id: int | None = None,
                 since: str | None = None) -> list[dict]:
        """The multi-day story: one leg's life, or a whole day."""
        q: dict = {"meta.inst": instrument}
        if security_id is not None:
            q["meta.sid"] = security_id
        if since:
            q["meta.d"] = {"$gte": since}
        return list(self.db[EOD].find(q).sort("t", 1))

    # -- the daily record (kind C) ---------------------------------------

    def write_daily(self, record: dict) -> None:
        """The per-expiry, futures, underlying and data-quality parts of D29.

        Replaces rather than appends, so re-running an end-of-day job cannot
        leave two disagreeing records for one day.
        """
        self.db[DAILY].replace_one(
            {"instrument": record["instrument"], "trade_date": record["trade_date"]},
            record, upsert=True)
        self.stats.daily_rows += 1

    def read_daily(self, instrument: str, trade_date: str) -> dict | None:
        return self.db[DAILY].find_one(
            {"instrument": instrument, "trade_date": trade_date})

    def read_daily_range(self, instrument: str, since: str) -> list[dict]:
        return list(self.db[DAILY].find(
            {"instrument": instrument, "trade_date": {"$gte": since}}
        ).sort("trade_date", 1))

    # -- housekeeping ----------------------------------------------------

    def sizes(self) -> dict[str, dict]:
        """On-disk size per collection, for the health row and for capacity."""
        out: dict[str, dict] = {}
        for name in (CURRENT, INTRADAY, EOD, DAILY):
            try:
                st = self.db.command("collstats", name)
                out[name] = {
                    "count": st.get("count", 0),
                    "storage_mb": round(st.get("storageSize", 0) / 1e6, 2),
                    "index_mb": round(st.get("totalIndexSize", 0) / 1e6, 2),
                }
            except Exception:                        # noqa: BLE001
                out[name] = {"count": 0, "storage_mb": 0.0, "index_mb": 0.0}
        return out

    def close(self) -> None:
        self._client.close()


# -- turning a chain into rows -------------------------------------------

def current_rows(chain, dirty: Iterable[int] | None = None) -> list[dict]:
    """The Now tier's documents, for every leg or just the ones given."""
    idx = range(len(chain.strike)) if dirty is None else list(dirty)
    out = []
    for i in idx:
        if chain.tick_count[i] == 0:
            continue                # never ticked: nothing to say about it
        out.append({
            "sid": int(chain.security_id[i]),
            "strike": float(chain.strike[i]),
            "side": "CE" if bool(chain.is_call[i]) else "PE",
            "exp": str(chain.expiry[i]),
            "ltp": float(chain.ltp[i]), "bid": float(chain.bid[i]),
            "ask": float(chain.ask[i]), "bq": int(chain.bid_size[i]),
            "aq": int(chain.ask_size[i]), "oi": int(chain.oi[i]),
            "oi_open": _opt_int(chain.oi_open[i]), "vol": int(chain.volume[i]),
            "iv": _clean(chain.iv[i]), "delta": _clean(chain.delta[i]),
            "gamma": _clean(chain.gamma[i]), "theta": _clean(chain.theta[i]),
            "vega": _clean(chain.vega[i]), "ticks": int(chain.tick_count[i]),
        })
    return out


def eod_rows(chain) -> list[dict]:
    """The end-of-day tier's rows: where each strike opened, ended and ranged.

    `oi_open` is what makes "today's change" answerable at any moment tomorrow,
    and it is the one value that cannot be recovered after the fact (D29 part 1).
    """
    out = []
    for i in range(len(chain.strike)):
        if chain.tick_count[i] == 0:
            continue
        out.append({
            "sid": int(chain.security_id[i]),
            "strike": float(chain.strike[i]),
            "side": "CE" if bool(chain.is_call[i]) else "PE",
            "exp": str(chain.expiry[i]),
            "oi_open": _opt_int(chain.oi_open[i]), "oi_close": int(chain.oi[i]),
            "oi_high": int(chain.high_oi[i]), "oi_low": int(chain.low_oi[i]),
            "oi_chg": int(chain.oi_change[i]),
            "o": float(chain.day_open[i]), "h": float(chain.day_high[i]),
            "l": float(chain.day_low[i]), "c": float(chain.ltp[i]),
            "vol": int(chain.volume[i]),
            "iv": _clean(chain.iv[i]), "delta": _clean(chain.delta[i]),
            "gamma": _clean(chain.gamma[i]),
            "ticks": int(chain.tick_count[i]),
        })
    return out


def _clean(v) -> float | None:
    """NaN becomes None, never 0.

    D38's rule carried into storage: a leg whose IV we decline to compute must
    read as absent, because a stored 0 would later look like a measured zero.
    """
    f = float(v)
    return None if f != f else f


def _opt_int(v) -> int | None:
    """A sentinel becomes None. Never let -1 reach the database.

    `oi_open` starts at -1 meaning "this leg has not reported OI yet". Stored as
    -1 it would look like a measured open interest of minus one, and any later
    "change since open" would be computed against nonsense. Found 2026-09-25
    when a real end-of-day row came out with `oi_open -1`.
    """
    i = int(v)
    return None if i < 0 else i
