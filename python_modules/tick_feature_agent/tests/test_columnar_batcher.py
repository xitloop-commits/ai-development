"""
tests/test_columnar_batcher.py — T50 B.2 — ColumnarBatcher tests.

Verifies the contract that future B.3 tracker rewrites depend on:

    1. Events from merge_streams come out grouped by type into Polars DFs.
    2. Total events across all per-type DFs in one chunk <= chunk_size.
    3. Chronological order within each per-type DF is preserved.
    4. Missing / extra event types degrade gracefully (empty DF, no crash).
    5. Nested fields on chain_snapshots (the per-strike ``rows`` list) are
       preserved as Polars Struct columns the consumer can later unnest.
    6. Empty input yields zero chunks (no spurious empty chunk).
"""

from __future__ import annotations

import sys
from pathlib import Path

import polars as pl

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

from tick_feature_agent.replay.columnar_batcher import (
    ColumnarBatcher,
    EventChunk,
)


# ── helpers ─────────────────────────────────────────────────────────────────


def _u(i: int) -> dict:
    """Build a synthetic underlying_tick event."""
    return {
        "type": "underlying_tick",
        "data": {"recv_ts": f"2026-05-22T09:15:{i:02d}.000+05:30", "ltp": 25_000.0 + i, "bid": 24_999.0 + i, "ask": 25_001.0 + i, "volume": i * 100},
    }


def _o(i: int, strike: int) -> dict:
    return {
        "type": "option_tick",
        "data": {"recv_ts": f"2026-05-22T09:15:{i:02d}.000+05:30", "security_id": str(60000 + strike), "strike": strike, "opt_type": "CE", "ltp": 50.0, "oi": 100_000 + i},
    }


def _c(i: int) -> dict:
    """Chain snapshot with nested rows — exercises the Struct/List preservation."""
    return {
        "type": "chain_snapshot",
        "data": {
            "recv_ts": f"2026-05-22T09:15:{i:02d}.000+05:30",
            "expiry": "2026-05-29",
            "spot_price": 25_000.0 + i,
            "rows": [
                {"strike": 24900, "ce_ltp": 110.0, "ce_oi": 50_000, "pe_ltp": 35.0, "pe_oi": 40_000},
                {"strike": 25000, "ce_ltp": 60.0, "ce_oi": 70_000, "pe_ltp": 60.0, "pe_oi": 60_000},
                {"strike": 25100, "ce_ltp": 25.0, "ce_oi": 45_000, "pe_ltp": 120.0, "pe_oi": 55_000},
            ],
        },
    }


def _v(i: int) -> dict:
    return {
        "type": "vix_tick",
        "data": {"recv_ts": f"2026-05-22T09:15:{i:02d}.000+05:30", "ltp": 15.0 + i * 0.01},
    }


# ── tests ───────────────────────────────────────────────────────────────────


def test_mixed_stream_groups_by_type():
    """Mix of all 4 event types in one chunk; each goes to its own DF."""
    events = [_u(0), _o(0, 24900), _c(0), _v(0), _u(1), _o(1, 25000)]
    chunks = list(ColumnarBatcher(events, chunk_size=100))
    assert len(chunks) == 1
    chunk = chunks[0]
    assert isinstance(chunk, EventChunk)
    assert len(chunk.underlying_ticks) == 2
    assert len(chunk.option_ticks) == 2
    assert len(chunk.chain_snapshots) == 1
    assert len(chunk.vix_ticks) == 1
    assert chunk.total_events == 6


def test_chunk_size_cap_splits_stream():
    """25k events with chunk_size=10k -> 3 chunks (10k, 10k, 5k)."""
    events = [_u(i % 60) for i in range(25_000)]
    chunks = list(ColumnarBatcher(events, chunk_size=10_000))
    assert len(chunks) == 3
    sizes = [c.total_events for c in chunks]
    assert sizes == [10_000, 10_000, 5_000]
    # All underlying — the other type DFs must be empty
    for c in chunks:
        assert len(c.underlying_ticks) > 0
        assert len(c.option_ticks) == 0
        assert len(c.chain_snapshots) == 0
        assert len(c.vix_ticks) == 0


def test_chronological_order_within_type():
    """The order within each per-type DF must match the source iteration
    order so trackers that walk the rows linearly still see ascending
    timestamps."""
    events = [_u(i) for i in range(10)] + [_o(i, 25000) for i in range(10)]
    chunks = list(ColumnarBatcher(events, chunk_size=100))
    df = chunks[0].underlying_ticks
    ts = df["recv_ts"].to_list()
    assert ts == sorted(ts), f"underlying ts not in order: {ts}"


def test_empty_input_yields_no_chunks():
    """Zero events in -> no chunks out (not even an empty one)."""
    chunks = list(ColumnarBatcher(iter([]), chunk_size=100))
    assert chunks == []


def test_unknown_event_type_is_skipped():
    """A bogus type in the stream must be skipped silently, not crash."""
    events = [_u(0), {"type": "garbage", "data": {"foo": 1}}, _u(1)]
    chunks = list(ColumnarBatcher(events, chunk_size=100))
    assert len(chunks) == 1
    assert chunks[0].total_events == 2  # only the 2 underlying


def test_malformed_event_missing_data_is_skipped():
    events = [_u(0), {"type": "underlying_tick"}, _u(1)]  # second missing 'data'
    chunks = list(ColumnarBatcher(events, chunk_size=100))
    assert chunks[0].total_events == 2


def test_chain_snapshot_rows_preserved_as_nested_struct():
    """The per-strike ``rows`` list inside each chain snapshot must come
    out as a Polars List[Struct[...]] column the consumer can later
    explode to access ce_ltp, pe_oi, etc. by strike."""
    events = [_c(0), _c(1)]
    chunks = list(ColumnarBatcher(events, chunk_size=10))
    df = chunks[0].chain_snapshots
    assert "rows" in df.columns
    # Explode to per-strike rows to confirm the nested structure round-trips
    exploded = df.explode("rows").unnest("rows")
    # 2 snapshots x 3 strikes each = 6 rows
    assert len(exploded) == 6
    assert set(exploded.columns) >= {"strike", "ce_ltp", "ce_oi", "pe_ltp", "pe_oi"}
    assert sorted(exploded["strike"].unique().to_list()) == [24900, 25000, 25100]


def test_partial_final_chunk_is_yielded():
    """7 events with chunk_size=5 -> 2 chunks (5, 2)."""
    events = [_u(i) for i in range(7)]
    chunks = list(ColumnarBatcher(events, chunk_size=5))
    assert [c.total_events for c in chunks] == [5, 2]


def test_invalid_chunk_size_raises():
    import pytest
    with pytest.raises(ValueError):
        ColumnarBatcher(iter([]), chunk_size=0)
    with pytest.raises(ValueError):
        ColumnarBatcher(iter([]), chunk_size=-1)


def test_total_events_property():
    events = [_u(0), _o(0, 25000), _c(0)]
    chunk = list(ColumnarBatcher(events, chunk_size=10))[0]
    assert chunk.total_events == 3
    assert not chunk.is_empty()
    empty_chunk = EventChunk(
        underlying_ticks=pl.DataFrame(),
        option_ticks=pl.DataFrame(),
        chain_snapshots=pl.DataFrame(),
        vix_ticks=pl.DataFrame(),
    )
    assert empty_chunk.is_empty()
    assert empty_chunk.total_events == 0
