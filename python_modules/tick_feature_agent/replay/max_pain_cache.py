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

from tick_feature_agent.features.active_features_columnar import (
    compute_side_strengths_batch,
)
from tick_feature_agent.features.chain_columnar import (
    compute_oi_weighted_levels_batch,
    compute_wall_strength_batch,
)
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


# ── B.3e: oi_weighted_levels + wall_strength caches ─────────────────────────


def _legacy_chain_enabled() -> bool:
    """TFA_LEGACY_CHAIN_FEATURES=1 disables the B.3e caches (independent
    of TFA_LEGACY_MAX_PAIN)."""
    return os.environ.get("TFA_LEGACY_CHAIN_FEATURES", "").strip() not in (
        "", "0", "false", "False",
    )


def _load_chain_snapshots(date_folder: Path, instrument: str) -> tuple[pl.DataFrame, list[float]]:
    """Shared loader so multiple B.3e caches don't re-parse the same NDJSON.

    Returns (chain_snapshots_df, timestamps_list). Empty/missing path =>
    empty DataFrame + empty list.
    """
    path = date_folder / f"{instrument}_chain_snapshots.ndjson.gz"
    if not path.exists():
        return pl.DataFrame(), []
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
            try:
                ts_ms_f = float(ts_ms)
            except (TypeError, ValueError):
                continue
            ts_sec = ts_ms_f / 1000.0 if ts_ms_f > 1e9 else ts_ms_f
            rows = _normalize_rows(rec.get("rows", []))
            snapshots.append({"rows": rows})
            timestamps.append(ts_sec)
    if not snapshots:
        return pl.DataFrame(), []
    df = pl.from_dicts(snapshots, infer_schema_length=None)
    return df, timestamps


def _build_chain_feature_caches(
    date_folder: Path, instrument: str,
) -> tuple[dict[float, dict[str, float]], dict[float, dict[str, float]]]:
    """Build oi_weighted + wall_strength caches from one chain-snapshot
    parse. Avoids re-parsing the .ndjson.gz multiple times in the same
    install path (parsing was responsible for a measured ~3-4s regression
    when these caches were built separately)."""
    df, timestamps = _load_chain_snapshots(date_folder, instrument)
    oi_cache: dict[float, dict[str, float]] = {}
    ws_cache: dict[float, dict[str, float]] = {}
    if df.is_empty() or not timestamps:
        return oi_cache, ws_cache
    oi_df = compute_oi_weighted_levels_batch(df)
    ws_df = compute_wall_strength_batch(df)
    for row in oi_df.iter_rows(named=True):
        idx = int(row["snapshot_id"])
        if idx < 0 or idx >= len(timestamps):
            continue
        oi_cache[timestamps[idx]] = {
            "oi_weighted_ce_resistance_strike": (
                _NAN if row["oi_weighted_ce_resistance_strike"] is None
                else float(row["oi_weighted_ce_resistance_strike"])
            ),
            "oi_weighted_pe_support_strike": (
                _NAN if row["oi_weighted_pe_support_strike"] is None
                else float(row["oi_weighted_pe_support_strike"])
            ),
        }
    for row in ws_df.iter_rows(named=True):
        idx = int(row["snapshot_id"])
        if idx < 0 or idx >= len(timestamps):
            continue
        ws_cache[timestamps[idx]] = {
            "ce_wall_strength_rel": (
                _NAN if row["ce_wall_strength_rel"] is None
                else float(row["ce_wall_strength_rel"])
            ),
            "pe_wall_strength_rel": (
                _NAN if row["pe_wall_strength_rel"] is None
                else float(row["pe_wall_strength_rel"])
            ),
        }
    return oi_cache, ws_cache


def _make_dict_wrapper(cache: dict[float, dict[str, float]], scalar_fn, default_keys: tuple[str, ...]):
    """Generic wrapper for compute_<fn>(chain_rows) -> dict pattern.

    chain_rows is unused on cache hits — we look up by current_snapshot_ts.
    Cache miss falls through to scalar to preserve correctness.
    """
    def cached(chain_rows):  # type: ignore[no-untyped-def]
        if not cache or chain_rows is None:
            return scalar_fn(chain_rows)
        ts = current_snapshot_ts
        if ts is None:
            return scalar_fn(chain_rows)
        hit = cache.get(ts)
        if hit is None:
            return scalar_fn(chain_rows)
        return dict(hit)
    return cached


def install_chain_features(date_folder: Path, instrument: str):
    """Install B.3e monkey-patches on chain.compute_oi_weighted_levels +
    compute_wall_strength. Returns sentinel for uninstall_chain_features."""
    if _legacy_chain_enabled():
        return None
    oi_cache, ws_cache = _build_chain_feature_caches(
        Path(date_folder), instrument,
    )
    if not oi_cache and not ws_cache:
        return None
    from tick_feature_agent.features import chain as _chain_module
    from tick_feature_agent.state import feature_pipeline as _fp

    original_oi = _fp.compute_oi_weighted_levels
    original_ws = _fp.compute_wall_strength

    new_oi = _make_dict_wrapper(oi_cache, original_oi,
                                ("oi_weighted_ce_resistance_strike",
                                 "oi_weighted_pe_support_strike"))
    new_ws = _make_dict_wrapper(ws_cache, original_ws,
                                ("ce_wall_strength_rel", "pe_wall_strength_rel"))
    setattr(new_oi, "_chain_feat_true_original", original_oi)
    setattr(new_ws, "_chain_feat_true_original", original_ws)

    _fp.compute_oi_weighted_levels = new_oi
    _fp.compute_wall_strength = new_ws
    return (original_oi, original_ws)


def uninstall_chain_features(sentinel) -> None:
    if sentinel is None:
        return
    original_oi, original_ws = sentinel
    from tick_feature_agent.state import feature_pipeline as _fp
    _fp.compute_oi_weighted_levels = original_oi
    _fp.compute_wall_strength = original_ws


# ── B.3c: compute_side_strengths cache ──────────────────────────────────────


def _legacy_side_strengths_enabled() -> bool:
    """TFA_LEGACY_SIDE_STRENGTHS=1 disables the B.3c cache."""
    return os.environ.get("TFA_LEGACY_SIDE_STRENGTHS", "").strip() not in (
        "", "0", "false", "False",
    )


def _load_chain_snapshots_with_volumes(
    date_folder: Path, instrument: str,
) -> tuple[pl.DataFrame, list[float]]:
    """Like ``_load_chain_snapshots`` but preserves callVolume / putVolume
    / callOIChange / putOIChange fields needed by side_strengths."""
    path = date_folder / f"{instrument}_chain_snapshots.ndjson.gz"
    if not path.exists():
        return pl.DataFrame(), []
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
            try:
                ts_ms_f = float(ts_ms)
            except (TypeError, ValueError):
                continue
            ts_sec = ts_ms_f / 1000.0 if ts_ms_f > 1e9 else ts_ms_f
            raw_rows = rec.get("rows") or []
            rich_rows = []
            for r in raw_rows:
                if not isinstance(r, dict):
                    continue
                strike = r.get("strike")
                if strike is None:
                    continue
                try:
                    rich_rows.append({
                        "strike": int(strike),
                        "callVolume": float(r.get("callVolume") or 0),
                        "putVolume": float(r.get("putVolume") or 0),
                        "callOIChange": float(r.get("callOIChange") or 0),
                        "putOIChange": float(r.get("putOIChange") or 0),
                    })
                except (TypeError, ValueError):
                    continue
            snapshots.append({"rows": rich_rows})
            timestamps.append(ts_sec)
    if not snapshots:
        return pl.DataFrame(), []
    df = pl.from_dicts(snapshots, infer_schema_length=None)
    return df, timestamps


def _build_side_strengths_cache(
    date_folder: Path, instrument: str,
) -> dict[float, dict[int, tuple]]:
    """Pre-compute side_strengths for every chain snapshot using the
    Polars-vectorised ``compute_side_strengths_batch`` (T50 B.3c proper).

    Output shape matches scalar ``compute_side_strengths(rows, prev_rows)``:
    ``{snapshot_ts: {strike: (csv, csoi, strength, psv, psoi, strength_pe)}}``.

    Win vs scalar: ~10× per-function speedup on the per-snapshot work,
    plus the original amortisation (5746 runtime calls served by 3306
    pre-built dicts).
    """
    df, timestamps = _load_chain_snapshots_with_volumes(date_folder, instrument)
    if df.is_empty() or not timestamps:
        return {}

    out_df = compute_side_strengths_batch(df)
    if len(out_df) == 0:
        return {}

    cache: dict[float, dict[int, tuple]] = {}
    for sid_value, group in out_df.group_by("snapshot_id", maintain_order=True):
        # group_by returns (key_tuple, group_df); key_tuple may be a
        # single int or a tuple depending on Polars version. Normalise.
        sid = int(sid_value[0] if isinstance(sid_value, tuple) else sid_value)
        if sid < 0 or sid >= len(timestamps):
            continue
        ts = timestamps[sid]
        strike_dict: dict[int, tuple] = {}
        for row in group.iter_rows(named=True):
            strike_dict[int(row["strike"])] = (
                float(row["csv"]),
                float(row["csoi"]),
                float(row["strength"]),
                float(row["psv"]),
                float(row["psoi"]),
                float(row["strength_pe"]),
            )
        cache[ts] = strike_dict
    return cache


def _make_side_strengths_wrapper(cache: dict[float, dict[int, tuple]], scalar_fn):
    """Wrapper that looks up by current_snapshot_ts; falls through on miss.

    Note: the scalar fn's contract is ``f(rows, prev_rows) -> dict``.
    On cache hit we IGNORE the runtime ``prev_rows`` — the cache built
    by ``_build_side_strengths_cache`` already paired each snapshot with
    its time-ordered predecessor, which matches what
    ``compute_active_features`` passes at runtime (chain_cache's
    prev_snapshot.rows).
    """
    def cached(rows, prev_rows):  # type: ignore[no-untyped-def]
        if not cache or rows is None:
            return scalar_fn(rows, prev_rows)
        ts = current_snapshot_ts
        if ts is None:
            return scalar_fn(rows, prev_rows)
        hit = cache.get(ts)
        if hit is None:
            return scalar_fn(rows, prev_rows)
        return hit
    return cached


def install_side_strengths(date_folder: Path, instrument: str):
    """Install B.3c monkey-patch on compute_side_strengths.

    Monkey-patches BOTH the public ``active_features.compute_side_strengths``
    AND the symbol re-imported by callers (active_features's own
    compute_active_features looks it up via the module attribute).
    """
    if _legacy_side_strengths_enabled():
        return None
    cache = _build_side_strengths_cache(Path(date_folder), instrument)
    if not cache:
        return None
    from tick_feature_agent.features import active_features as _af
    original = _af.compute_side_strengths
    wrapper = _make_side_strengths_wrapper(cache, original)
    setattr(wrapper, "_side_strengths_true_original", original)
    _af.compute_side_strengths = wrapper
    return (original,)


def uninstall_side_strengths(sentinel) -> None:
    if sentinel is None:
        return
    (original,) = sentinel
    from tick_feature_agent.features import active_features as _af
    _af.compute_side_strengths = original