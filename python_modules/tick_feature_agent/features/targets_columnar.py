"""
features/targets_columnar.py — T50 B.3b scaffold (targets.py side).

Polars vectorisation of ``targets.TargetBuffer.compute_targets``. This
is the BIGGER half of B.3b (~31s of 200s replay time on the v8
profile, vs trend_swing_targets at 2.7s).

The function emits up to ~13 columns per window × len(target_windows_sec):

    Spot-based (this scaffold ships):
        direction_{x}s
        direction_{x}s_magnitude
        direction_persists_{x}s
        breakout_in_{x}s
        exit_signal_{x}s

    Per-strike CE-leg (deferred to B.3b execution session):
        max_upside_{x}s
        max_drawdown_{x}s
        risk_reward_ratio_{x}s
        total_premium_decay_{x}s
        avg_decay_per_strike_{x}s

    Per-strike PE-leg (deferred to B.3b execution session):
        max_upside_pe_{x}s
        max_drawdown_pe_{x}s

This scaffold ships the spot-based half so the algorithmic pattern is
proven before tackling the 3-D (emit × strike × window) per-strike
problem. The per-strike block dominates the 31s scalar tottime and
gets its own design pass next session — see
``docs/T50_B3B_TARGETS_DESIGN.md`` § Pass 2.

Out of scope this session (same as the trend_swing scaffold):
    - Full edge-case sweep beyond 1 happy-path test
    - Per-strike CE / PE features
    - Real-data byte-equality harness
    - Adapter wire-in via monkey-patch
    - End-to-end speedup measurement
"""

from __future__ import annotations

import polars as pl

_DEFAULT_WINDOWS: tuple[int, ...] = (30, 60)


def compute_targets_batch_spot(
    emit_df: pl.DataFrame,
    spot_history_df: pl.DataFrame,
    *,
    target_windows_sec: tuple[int, ...] = _DEFAULT_WINDOWS,
    session_end_sec: float,
    emit_ts_col: str = "ts_sec",
    emit_spot_col: str = "spot_at_t0",
    emit_day_high_col: str | None = "day_high_at_t0",
    emit_day_low_col: str | None = "day_low_at_t0",
    hist_ts_col: str = "ts_sec",
    hist_spot_col: str = "spot",
) -> pl.DataFrame:
    """Spot-based half of compute_targets in batched form.

    Args:
        emit_df: One row per emit point. Must contain ``ts_sec`` and
            ``spot_at_t0``. ``day_high_at_t0`` + ``day_low_at_t0``
            optional — when present the breakout_in_{x}s columns
            populate; otherwise they emit NaN (matches scalar).
        spot_history_df: Full-date spot history, one row per recorded
            underlying tick. Must contain ``ts_sec`` + ``spot``.
        target_windows_sec: Forward windows in seconds. Default (30, 60)
            matches TargetBuffer's default.
        session_end_sec: Targets whose horizon extends past this are
            NaN (matches scalar's past_boundary guard).

    Returns:
        emit_df with ``5 * len(target_windows_sec)`` columns appended
        (direction, direction_magnitude, direction_persists,
        breakout_in, exit_signal — one set per window).

    Notes:
        Per-strike features (max_upside, max_drawdown, premium_decay,
        max_upside_pe, max_drawdown_pe) are NOT computed by this
        function — they'll be a separate
        ``compute_targets_batch_per_strike`` in the B.3b execution
        session that consumes an exploded per-strike history table.
    """
    if len(emit_df) == 0:
        return emit_df  # no-op; nothing to append

    has_day_levels = (
        emit_day_high_col is not None
        and emit_day_high_col in emit_df.columns
        and emit_day_low_col is not None
        and emit_day_low_col in emit_df.columns
    )

    # Tag emit rows with an index so per-window joins stay aligned.
    renames = {emit_ts_col: "_t0", emit_spot_col: "_spot0"}
    if has_day_levels:
        renames[emit_day_high_col] = "_day_high"
        renames[emit_day_low_col] = "_day_low"
    emit_with_idx = emit_df.with_row_index("_emit_idx").rename(renames)

    result = emit_with_idx

    for w in target_windows_sec:
        # Lookahead = history entries with ts in (t0, t0+w].
        la = (
            emit_with_idx.select(["_emit_idx", "_t0", "_spot0"])
            .join(
                spot_history_df.rename({hist_ts_col: "_h_ts",
                                        hist_spot_col: "_h_spot"}),
                how="cross",
            )
            .filter(
                (pl.col("_h_ts") > pl.col("_t0"))
                & (pl.col("_h_ts") <= pl.col("_t0") + w)
            )
            .sort(["_emit_idx", "_h_ts"])
            .group_by("_emit_idx", maintain_order=True)
            .agg(
                _end_spot=pl.col("_h_spot").last(),
                _max_spot=pl.col("_h_spot").max(),
                _min_spot=pl.col("_h_spot").min(),
            )
        )
        result = result.join(la, on="_emit_idx", how="left")

        past_boundary = pl.col("_t0") + w > session_end_sec
        empty_la = pl.col("_end_spot").is_null()
        mask_null = past_boundary | empty_la

        # direction (scalar lines 240-246):
        #   NaN if past_boundary or empty lookahead
        #   else: 1 if future_spot > spot_at_t0 else 0  (binary)
        direction_expr = (
            pl.when(mask_null).then(None)
              .otherwise(
                  pl.when(pl.col("_end_spot") > pl.col("_spot0"))
                    .then(1).otherwise(0)
                    .cast(pl.Int64)
              )
        )

        # direction_magnitude (lines 246-250):
        #   NaN if past_boundary, empty, or spot_at_t0 <= 0
        #   else: |future_spot - spot_at_t0| / spot_at_t0
        magnitude_expr = (
            pl.when(mask_null | (pl.col("_spot0") <= 0)).then(None)
              .otherwise(
                  (pl.col("_end_spot") - pl.col("_spot0")).abs() / pl.col("_spot0")
              )
        )

        # direction_persists (lines 252-269):
        #   NaN if past_boundary or empty
        #   NaN if end_spot == spot_at_t0 (ambiguous endpoint)
        #   else if end > t0:  1 if no point in lookahead dipped below t0 else 0
        #                       (i.e. min_spot >= spot_at_t0)
        #   else if end < t0:  1 if no point exceeded t0 (max_spot <= t0) else 0
        end_eq = pl.col("_end_spot") == pl.col("_spot0")
        persists_up = (pl.col("_end_spot") > pl.col("_spot0")) & (
            pl.col("_min_spot") >= pl.col("_spot0")
        )
        persists_down = (pl.col("_end_spot") < pl.col("_spot0")) & (
            pl.col("_max_spot") <= pl.col("_spot0")
        )
        persists_expr = (
            pl.when(mask_null).then(None)
              .when(end_eq).then(None)
              .otherwise(
                  pl.when(persists_up | persists_down).then(1).otherwise(0)
                    .cast(pl.Int64)
              )
        )

        # breakout_in (lines 271-279):
        #   NaN if past_boundary, empty, or day levels missing
        #   else: 1 if max_spot > day_high OR min_spot < day_low else 0
        if has_day_levels:
            breakout_in_expr = (
                pl.when(mask_null | pl.col("_day_high").is_null()
                        | pl.col("_day_low").is_null()).then(None)
                  .otherwise(
                      pl.when(
                          (pl.col("_max_spot") > pl.col("_day_high"))
                          | (pl.col("_min_spot") < pl.col("_day_low"))
                      ).then(1).otherwise(0).cast(pl.Int64)
                  )
            )
        else:
            breakout_in_expr = pl.lit(None).cast(pl.Int64)

        # exit_signal (lines 281-299):
        #   NaN if past_boundary, empty, or spot_at_t0 <= 0
        #   else: 1 if (path crossed t0) OR (max_excursion_pct > 0.01)
        # Path crossed t0 iff min < t0 AND max > t0 (sufficient + necessary
        # given the prepended-t0 sentinel doesn't count as a crossing).
        crossed = (pl.col("_min_spot") < pl.col("_spot0")) & (
            pl.col("_max_spot") > pl.col("_spot0")
        )
        max_excursion_abs = pl.max_horizontal(
            pl.col("_max_spot") - pl.col("_spot0"),
            pl.col("_spot0") - pl.col("_min_spot"),
        )
        max_excursion_pct = max_excursion_abs / pl.col("_spot0")
        exit_signal_expr = (
            pl.when(mask_null | (pl.col("_spot0") <= 0)).then(None)
              .otherwise(
                  pl.when(crossed | (max_excursion_pct > 0.01)).then(1).otherwise(0)
                    .cast(pl.Int64)
              )
        )

        result = result.with_columns(
            direction_expr.alias(f"direction_{w}s"),
            magnitude_expr.alias(f"direction_{w}s_magnitude"),
            persists_expr.alias(f"direction_persists_{w}s"),
            breakout_in_expr.alias(f"breakout_in_{w}s"),
            exit_signal_expr.alias(f"exit_signal_{w}s"),
        ).drop(["_end_spot", "_max_spot", "_min_spot"])

    # Strip the internal columns; restore the original emit_df shape
    # plus the new target columns.
    drop_cols = ["_emit_idx", "_t0", "_spot0"]
    if has_day_levels:
        drop_cols += ["_day_high", "_day_low"]
    return result.drop(drop_cols)
