"""
replay/targets_cache.py — T50 B.3b adapter wire-in support.

Batches the per-row scalar ``TargetBuffer.compute_targets`` +
``SpotTargetBuffer.compute_targets`` calls in replay's flush paths
into one columnar batch (Polars).

Replay-only — never imported by tick_processor / live mode. The
buffers themselves stay scalar at the API surface; this module
extracts their state into Polars long-form DataFrames, runs the
three columnar functions
(``compute_targets_batch_spot`` + ``compute_targets_batch_per_strike``
+ ``compute_trend_swing_targets_batch``), then hands one combined
target dict per pending row back to the adapter to apply + emit.

Environment flag:

    ``TFA_LEGACY_TARGETS=1`` skips this path entirely — the adapter
    falls through to per-row scalar calls exactly as before. Use this
    for A/B comparison or one-flip rollback if a regression is
    detected post-merge.

Threading: pure functional, no shared state in this module. Per-batch
allocation only.
"""

from __future__ import annotations

import math
import os
from collections.abc import Iterable
from typing import Any

import polars as pl

from tick_feature_agent.features.targets_columnar import (
    compute_targets_batch_per_strike,
    compute_targets_batch_spot,
)
from tick_feature_agent.features.trend_swing_targets_columnar import (
    compute_trend_swing_targets_batch,
)

_NAN = float("nan")


def legacy_enabled() -> bool:
    """User can flip TFA_LEGACY_TARGETS=1 to disable the optimization."""
    return os.environ.get("TFA_LEGACY_TARGETS", "").strip() not in (
        "", "0", "false", "False",
    )


# ── State extraction ────────────────────────────────────────────────────────


def extract_strike_history_df(target_buf) -> pl.DataFrame:
    """Convert TargetBuffer._entries deque to long-form per-strike DF.

    Each ``_TickEntry`` has ``timestamp_sec``, ``spot``, and a
    ``strike_ltps`` dict of ``{strike: (ce_ltp, pe_ltp)}``. We flatten
    so the per-strike columnar function can self-join on ``strike``
    inside its time-window filter.
    """
    rows: list[dict[str, Any]] = []
    for entry in target_buf._entries:
        for strike, (ce, pe) in entry.strike_ltps.items():
            rows.append({
                "ts_sec": float(entry.timestamp_sec),
                "strike": int(strike),
                "ce_ltp": float(ce) if ce is not None else _NAN,
                "pe_ltp": float(pe) if pe is not None else _NAN,
            })
    if not rows:
        return pl.DataFrame(schema={
            "ts_sec": pl.Float64,
            "strike": pl.Int64,
            "ce_ltp": pl.Float64,
            "pe_ltp": pl.Float64,
        })
    return pl.from_dicts(rows, infer_schema_length=None)


def extract_spot_history_df(spot_target_buf) -> pl.DataFrame:
    """Convert SpotTargetBuffer._entries deque to long-form spot DF."""
    rows = [
        {"ts_sec": float(e.ts), "spot": float(e.spot)}
        for e in spot_target_buf._entries
    ]
    if not rows:
        return pl.DataFrame(schema={"ts_sec": pl.Float64, "spot": pl.Float64})
    return pl.DataFrame(rows)


# ── Batched compute ─────────────────────────────────────────────────────────


def _nan_if_none(v):
    """Polars null -> Python float('nan') for parquet compatibility.

    Scalar code returns float('nan') for missing values; the columnar
    functions return Polars null. Both round-trip to the same parquet
    representation for Float columns, but explicit conversion makes
    the adapter's row.update() behave identically across paths.
    """
    if v is None:
        return _NAN
    if isinstance(v, float) and math.isnan(v):
        return _NAN
    return v


# Column-name prefixes we keep from each batched function's output.
# Anything not matching falls out of the per-pending-row dict
# (matches the scalar's tightly-scoped return shape).
_SPOT_PREFIXES = ("direction_", "breakout_in_", "exit_signal_")
_PER_STRIKE_PREFIXES = (
    "max_upside_", "max_drawdown_", "risk_reward_ratio_",
    "total_premium_decay_", "avg_decay_per_strike_",
)
_TREND_SWING_PREFIXES = ("trend_", "swing_")


def compute_pending_targets_batched(
    pending_rows: list,
    target_buf,
    spot_target_buf,
    instrument_name: str,
    session_end_sec: float,
    target_windows_sec: tuple[int, ...],
    *,
    strike_history_df=None,
    spot_history_df=None,
) -> list[dict[str, Any]]:
    """Run all three columnar target functions in one batch.

    Returns a list of dicts, one per input pending row, in the same
    order. Each dict carries the column names the scalar
    ``compute_targets`` + ``compute_targets`` (trend/swing) calls
    would have produced — ready to be merged into ``pending.row`` and
    emitted.

    The adapter still computes the ``upside_percentile_{min}s`` column
    separately AFTER the batch (it requires sequential state on the
    UpsidePercentileTracker that can't be safely batched).

    ``strike_history_df`` + ``spot_history_df`` can be passed by callers
    that chunk the pending list across multiple invocations (see
    ``ReplayAdapter.flush_all``'s end-of-stream chunked path) — the
    history extracts are state-snapshots of the same target_buf /
    spot_target_buf, so they can be shared across batches and only need
    to be extracted once per flush_all. Default ``None`` preserves the
    original single-call behaviour for live + mid-stream uses.
    """
    if not pending_rows:
        return []

    # Build emit_df. active_strikes_at_t0 becomes a List[Struct] column.
    # Provide explicit schema for the nested list-of-struct so an all-
    # empty active-strikes batch (e.g. pending rows queued before the
    # first chain snapshot — only underlying ticks seen) doesn't trip
    # Polars' "expected 'Struct', got 'Null'" inference error.
    emit_data: list[dict[str, Any]] = []
    for p in pending_rows:
        emit_data.append({
            "ts_sec": float(p.t0),
            "spot_at_t0": float(p.spot_at_t0),
            "active_strikes_at_t0": [
                {
                    "strike": int(strike),
                    "ce_now": float(ce),
                    "pe_now": float(pe),
                }
                for strike, (ce, pe) in p.ltps_at_t0.items()
            ],
            "day_high_at_t0": (
                float(p.day_high_at_t0) if p.day_high_at_t0 is not None else None
            ),
            "day_low_at_t0": (
                float(p.day_low_at_t0) if p.day_low_at_t0 is not None else None
            ),
        })
    _emit_schema_overrides = {
        "active_strikes_at_t0": pl.List(pl.Struct({
            "strike": pl.Int64,
            "ce_now": pl.Float64,
            "pe_now": pl.Float64,
        })),
        "day_high_at_t0": pl.Float64,
        "day_low_at_t0": pl.Float64,
    }
    emit_df = pl.from_dicts(
        emit_data,
        schema_overrides=_emit_schema_overrides,
        infer_schema_length=None,
    )

    # History extracts (cheap relative to compute). Re-extract only if
    # the caller didn't pass them in — chunked flush_all extracts once
    # outside the loop and threads the same frames through every batch.
    if strike_history_df is None:
        strike_history_df = extract_strike_history_df(target_buf)
    if spot_history_df is None:
        spot_history_df = extract_spot_history_df(spot_target_buf)

    # Three columnar passes. Each appends columns to emit_df-shape.
    spot_out = compute_targets_batch_spot(
        emit_df, spot_history_df,
        target_windows_sec=target_windows_sec,
        session_end_sec=session_end_sec,
    )
    per_strike_out = compute_targets_batch_per_strike(
        emit_df, strike_history_df,
        target_windows_sec=target_windows_sec,
        session_end_sec=session_end_sec,
    )
    trend_swing_out = compute_trend_swing_targets_batch(
        emit_df, spot_history_df,
        instrument_name=instrument_name,
        session_end_sec=session_end_sec,
    )

    # Stitch one dict per pending row.
    result: list[dict[str, Any]] = []
    for i in range(len(pending_rows)):
        row_dict: dict[str, Any] = {}
        for k, v in spot_out.row(i, named=True).items():
            if k.startswith(_SPOT_PREFIXES):
                row_dict[k] = _nan_if_none(v)
        for k, v in per_strike_out.row(i, named=True).items():
            if k.startswith(_PER_STRIKE_PREFIXES):
                row_dict[k] = _nan_if_none(v)
        for k, v in trend_swing_out.row(i, named=True).items():
            if k.startswith(_TREND_SWING_PREFIXES):
                row_dict[k] = _nan_if_none(v)
        result.append(row_dict)
    return result
