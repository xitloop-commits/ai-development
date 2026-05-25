"""
replay/columnar_batcher.py — T50 B.2 — Stream-to-Polars batcher.

Buffers ``merge_streams`` events into per-type Polars DataFrames, grouped
into chunks of up to ``chunk_size`` total events. This is the foundation
that T50 B.3a-e tracker rewrites will consume — each future columnar
tracker pulls only the event type(s) it needs from each chunk and runs
one vectorised Polars expression instead of N per-event scalar calls.

Scope (B.2 only):

    - This module is a pure transformer: events in -> per-type DataFrames
      out. It does NOT touch the existing ReplayAdapter, run_one_date,
      or any feature compute. Adapter still consumes events scalar via
      merge_streams as before; B.3a-e wire the batcher in incrementally.
    - Schema inference is delegated to Polars (``pl.from_dicts``). Each
      event type's DataFrame has whatever columns the recorded JSON
      contained — TFA's recorder schema is the source of truth.
    - Nested fields (e.g. chain_snapshot's ``rows`` list of per-strike
      structs) are preserved as Polars Struct / List columns so the
      consuming tracker can explode / unnest as needed.

Threading:

    Pure functional generator. No shared state. Safe to use in any
    process / thread that already owns its source iterator.

Usage::

    from tick_feature_agent.replay.stream_merger import merge_streams
    from tick_feature_agent.replay.columnar_batcher import ColumnarBatcher

    events = merge_streams(date_folder, instrument)
    for chunk in ColumnarBatcher(events, chunk_size=10_000):
        if len(chunk.chain_snapshots):
            do_max_pain_batch(chunk.chain_snapshots)
        # ... other per-type batched compute ...
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Any

import polars as pl

# Event type keys produced by merge_streams. Order matters only for the
# fallthrough path in iter_events_chronological (which keys we look up
# in tiebreaks); the user-visible API is keyword-based on EventChunk.
_EVENT_TYPES: tuple[str, ...] = (
    "underlying_tick",
    "option_tick",
    "chain_snapshot",
    "vix_tick",
)


def _to_df(records: list[dict[str, Any]]) -> pl.DataFrame:
    """Convert a list of dict records to a Polars DataFrame.

    Empty list -> empty DataFrame (no schema). Polars infers column dtypes
    from the first non-null value of each key, including nested lists /
    structs (chain_snapshot's ``rows`` becomes ``List[Struct[...]]``).
    """
    if not records:
        return pl.DataFrame()
    # ``infer_schema_length=None`` scans the whole chunk so a late
    # appearing optional field doesn't get null-typed and break later
    # selects. Worth the small extra cost on chunks of ~10k.
    return pl.from_dicts(records, infer_schema_length=None)


@dataclass
class EventChunk:
    """One batch of events grouped by type and converted to Polars.

    Total events across all four DataFrames sums to <= the batcher's
    ``chunk_size``. Any type with zero events in the window appears as
    an empty ``pl.DataFrame`` (no schema). Consumers should always
    check ``len(chunk.<type>)`` before working with a frame.
    """

    underlying_ticks: pl.DataFrame
    option_ticks: pl.DataFrame
    chain_snapshots: pl.DataFrame
    vix_ticks: pl.DataFrame

    @property
    def total_events(self) -> int:
        return (
            len(self.underlying_ticks)
            + len(self.option_ticks)
            + len(self.chain_snapshots)
            + len(self.vix_ticks)
        )

    def is_empty(self) -> bool:
        return self.total_events == 0


class ColumnarBatcher:
    """Buffer a ``merge_streams``-style event stream into per-type Polars DFs.

    Counts events across ALL types toward the chunk_size cap — option
    ticks dominate volume (~500:1 vs underlying ticks for a typical
    nifty50 day), so capping by total events keeps memory bounded
    regardless of per-stream skew.
    """

    def __init__(
        self,
        events: Iterable[dict[str, Any]],
        chunk_size: int = 10_000,
    ) -> None:
        if chunk_size <= 0:
            raise ValueError(f"chunk_size must be > 0, got {chunk_size}")
        self._events = events
        self._chunk_size = chunk_size

    def __iter__(self) -> Iterator[EventChunk]:
        buf: dict[str, list[dict[str, Any]]] = {t: [] for t in _EVENT_TYPES}
        count = 0
        for ev in self._events:
            etype = ev.get("type")
            data = ev.get("data")
            if etype not in buf or data is None:
                # Unknown / malformed event — skip silently. merge_streams
                # already logs malformed lines at DEBUG; we don't want to
                # double-log per chunk boundary.
                continue
            buf[etype].append(data)
            count += 1
            if count >= self._chunk_size:
                yield self._build_chunk(buf)
                buf = {t: [] for t in _EVENT_TYPES}
                count = 0
        # Final partial chunk (may be empty if the source stream ended
        # exactly on a boundary).
        if count > 0:
            yield self._build_chunk(buf)

    @staticmethod
    def _build_chunk(buf: dict[str, list[dict[str, Any]]]) -> EventChunk:
        return EventChunk(
            underlying_ticks=_to_df(buf["underlying_tick"]),
            option_ticks=_to_df(buf["option_tick"]),
            chain_snapshots=_to_df(buf["chain_snapshot"]),
            vix_ticks=_to_df(buf["vix_tick"]),
        )
