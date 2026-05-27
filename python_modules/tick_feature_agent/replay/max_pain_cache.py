"""
replay/max_pain_cache.py — T50 B.3a adapter wire-in.

Pre-computes max_pain_strike for every chain snapshot in a date's raw
recording in one Polars batch (~126x faster than the per-tick scalar
loop the live pipeline uses), then monkey-patches
``feature_pipeline.compute_max_pain_features`` with a wrapper that
hits the cache by snapshot timestamp for the ``max_pain_strike`` and
recomputes the cheap spot-dependent fields per call.

The wrapper is scoped to the duration of ``run_one_date`` via
``install`` / ``uninstall`` — live ``tick_processor`` mode never sees
the patch and stays bit-equivalent to today.

Identification problem & solution:
    ``compute_max_pain_features(spot, chain_rows)`` has no snapshot
    identity in its signature. We thread it through a module-level
    ``current_snapshot_ts`` variable that ``replay_adapter`` updates
    whenever a new chain snapshot is dispatched (see
    replay_adapter._handle_chain_snapshot). The wrapper reads it to
    look up the pre-computed max_pain_strike for THIS snapshot.

Env var:
    Setting ``TFA_LEGACY_MAX_PAIN=1`` skips the optimization entirely
    — pure scalar fallback, useful for A/B benchmarks and as a
    one-flip rollback if a regression is detected post-merge.
"""

from __future__ import annotations

import gzip
import json
import math
import os
from pathlib import Path

import polars as pl

from tick_feature_agent.features.levels_columnar import (
    compute_max_pain_features_batch,
)

# ── Module-level state ──────────────────────────────────────────────────────
# Updated by replay_adapter._handle_chain_snapshot on each new snapshot;
# read by the monkey-patched wrapper to identify the current snapshot.
# Reset to None by ``uninstall`` so accidental leakage into other code
# paths surfaces as "cache miss -> scalar fallback" rather than wrong values.
current_snapshot_ts: float | None = None

_NAN = float("nan")
_GRAVITY_BAND_PCT = 0.02  # must match levels._GRAVITY_BAND_PCT


def _legacy_enabled() -> bool:
    """User can flip TFA_LEGACY_MAX_PAIN=1 to disable the optimization."""
    return os.environ.get("TFA_LEGACY_MAX_PAIN", "").strip() not in ("", "0", "false", "False")


def _normalize_rows(rows: list[dict]) -> list[dict]:
    """Coerce numeric fields to float so Polars' from_dicts doesn't trip
    over mixed Int/Float schemas across snapshots (the recorder writes
    whatever the broker JSON contains — sometimes int, sometimes float)."""
    out = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        strike = r.get("strike")
        c_oi = r.get("callOI")
        p_oi = r.get("putOI")
        out.append({
            "strike": float(strike) if strike is not None else None,
            "callOI": float(c_oi) if c_oi is not None else None,
            "putOI": float(p_oi) if p_oi is not None else None,
        })
    return out


def build_cache(date_folder: Path, instrument: str) -> dict[float, float]:
    """Pre-compute max_pain_strike for every chain snapshot in the date's
    chain_snapshots.ndjson.gz file. Returns ``{timestamp_sec: max_pain_strike}``.

    The timestamp key matches ``ChainSnapshot.timestamp_sec`` as
    constructed by the chain poller (recv_ts in epoch seconds), so the
    adapter can look it up by the same value the snapshot carries
    through replay.
    """
    path = date_folder / f"{instrument}_chain_snapshots.ndjson.gz"
    if not path.exists():
        # No chain stream -> no cache. Wrapper falls through to scalar.
        return {}

    # Phase 1: load + extract recv_ts -> rows.
    snapshots: list[dict] = []
    timestamps: list[float] = []
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts_ms = rec.get("timestamp")
            if ts_ms is None:
                continue
            # The chain poller converts ms -> seconds via the same
            # `ts_sec = ts_ms / 1000.0 if ts_ms > 1e9 else ts_ms` rule;
            # mirror that exactly so cache keys match adapter lookups.
            try:
                ts_ms_f = float(ts_ms)
            except (TypeError, ValueError):
                continue
            ts_sec = ts_ms_f / 1000.0 if ts_ms_f > 1e9 else ts_ms_f
            spot = rec.get("spotPrice")
            rows = rec.get("rows", [])
            snapshots.append({"spotPrice": spot, "rows": _normalize_rows(rows)})
            timestamps.append(ts_sec)

    if not snapshots:
        return {}

    # Phase 2: one big columnar batch -> max_pain_strike per snapshot.
    df_input = pl.from_dicts(snapshots, infer_schema_length=None)
    out_df = compute_max_pain_features_batch(df_input, spot_col="spotPrice")

    # out_df may have FEWER rows than timestamps (snapshots with empty
    # rows are dropped by the columnar function). We re-key by the
    # snapshot_id column (a 0-based row index of the INPUT df, set inside
    # compute_max_pain_features_batch via with_row_index when missing).
    cache: dict[float, float] = {}
    for row in out_df.iter_rows(named=True):
        idx = int(row["snapshot_id"])
        strike = row["max_pain_strike"]
        if idx < 0 or idx >= len(timestamps):
            continue
        if strike is None or (isinstance(strike, float) and math.isnan(strike)):
            continue
        cache[timestamps[idx]] = float(strike)

    return cache


# ── Wrapper that replaces scalar compute_max_pain_features ──────────────────


def _make_wrapper(cache: dict[float, float], scalar_fn):
    """Build the monkey-patched function. Closes over the cache and the
    original scalar fn so we can fall through on any cache miss."""

    def cached(spot, chain_rows):  # type: ignore[no-untyped-def]
        # Cache miss conditions -> scalar fallback (always safe).
        if not cache or chain_rows is None:
            return scalar_fn(spot, chain_rows)
        ts = current_snapshot_ts
        if ts is None:
            return scalar_fn(spot, chain_rows)
        max_pain_strike = cache.get(ts)
        if max_pain_strike is None:
            return scalar_fn(spot, chain_rows)

        # Cache hit — assemble the 3-key dict ourselves. Distance +
        # gravity depend on the current spot, so they recompute per
        # call. The expensive bit (argmin over all strike pairs) is
        # what's been pre-computed.
        out = {
            "max_pain_strike": max_pain_strike,
            "distance_to_max_pain_pct": _NAN,
            "max_pain_gravity_strength": _NAN,
        }
        try:
            spot_f = float(spot) if spot is not None else None
        except (TypeError, ValueError):
            spot_f = None
        if spot_f is None or not (spot_f > 0) or not math.isfinite(spot_f):
            return out

        out["distance_to_max_pain_pct"] = (spot_f - max_pain_strike) / spot_f * 100.0

        # Gravity = sum of (callOI + putOI) within +-2% of spot from
        # max_pain_strike, divided by total OI. Cheap O(N) scan.
        band = _GRAVITY_BAND_PCT * spot_f
        nearby_oi = 0.0
        total_oi = 0.0
        for r in chain_rows:
            if not isinstance(r, dict):
                continue
            try:
                k = float(r.get("strike") or 0)
                c_oi = max(0.0, float(r.get("callOI") or 0))
                p_oi = max(0.0, float(r.get("putOI") or 0))
            except (TypeError, ValueError):
                continue
            if not (math.isfinite(c_oi) and math.isfinite(p_oi)):
                continue
            total_oi += c_oi + p_oi
            if abs(k - max_pain_strike) <= band:
                nearby_oi += c_oi + p_oi
        if total_oi > 0:
            out["max_pain_gravity_strength"] = nearby_oi / total_oi
        return out

    return cached


# ── Install / uninstall — call from run_one_date around the replay loop ─────


_WRAPPER_MARKER = "_max_pain_cache_true_original"


def install(date_folder: Path, instrument: str):
    """Build cache + monkey-patch ``compute_max_pain_features``.

    Self-healing: if a prior install never uninstalled (early return /
    crash mid-date), we restore the true scalar original BEFORE
    patching again — prevents nested wrappers accumulating one layer
    per replayed date across the same worker process.

    Returns a sentinel that ``uninstall`` consumes. Returns None when
    the optimization is disabled (legacy env var, missing chain stream,
    empty cache) — uninstall handles None as a no-op.
    """
    if _legacy_enabled():
        return None
    cache = build_cache(Path(date_folder), instrument)
    if not cache:
        return None
    from tick_feature_agent.state import feature_pipeline as _fp
    current = _fp.compute_max_pain_features
    # If `current` is a prior wrapper from this module, retrieve the true
    # scalar original it stashed at install time. Otherwise `current` IS
    # the scalar original (clean state).
    true_original = getattr(current, _WRAPPER_MARKER, current)
    wrapper = _make_wrapper(cache, true_original)
    setattr(wrapper, _WRAPPER_MARKER, true_original)
    _fp.compute_max_pain_features = wrapper
    return (true_original, cache)


def uninstall(sentinel) -> None:
    """Restore the original scalar function. Always call from a finally
    block so a crash mid-replay can't leave the patch active."""
    global current_snapshot_ts
    current_snapshot_ts = None
    if sentinel is None:
        return
    original, _cache = sentinel
    from tick_feature_agent.state import feature_pipeline as _fp
    _fp.compute_max_pain_features = original