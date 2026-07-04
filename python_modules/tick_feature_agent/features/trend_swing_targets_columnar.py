"""
features/trend_swing_targets_columnar.py — T50 B.3b scaffold.

Polars vectorisation of ``trend_swing_targets.SpotTargetBuffer.compute_targets``.

Both replay-only — trend + swing targets are computed at end-of-day
backfill, never in live mode (live emits NaN for these 28 columns per
V2_MASTER_SPEC §2.2.2 Option B). The scalar implementation iterates
emit rows in Python and scans a deque per horizon; this columnar
version runs all emit rows for the date in one Polars expression chain.

Scope (this session — scaffold only):

    - One public function, ``compute_trend_swing_targets_batch``, that
      consumes a DataFrame of emit rows plus a full-date spot history
      DataFrame and emits the 28 trend+swing target columns per emit
      row.
    - Verified bit-equivalent to the scalar implementation on the one
      synthetic test in ``tests/test_trend_swing_targets_columnar.py``.
    - Targets a CORRECTNESS-FIRST cross-join + filter pattern. The
      performance pass (replace cross-join with sorted-time-window
      join_asof) ships in the B.3b execution session — see
      docs/T50_B3B_TARGETS_DESIGN.md § Next-session checklist.

Out of scope this session:

    - ``targets.compute_targets`` (per-strike CE LTP lookup, much
      bigger per-runtime contribution at 31s — gets its own scaffold).
    - Full edge-case sweep (empty lookahead, session-end boundary,
      noise-floor direction bucketing, continues / breakout_imminent
      flags across all instruments).
    - Adapter wire-in via monkey-patch on
      ``feature_pipeline.compute_pipeline_features``.
    - Real-data byte-equality harness across reference dates.
"""

from __future__ import annotations

import polars as pl

from tick_feature_agent.features.trend_swing_targets import (
    BREAKOUT_SCALE,
    CONTINUES_LOOKBACK_SEC,
    NOISE_FLOOR_PTS,
    SWING_HORIZONS_SEC,
    TREND_HORIZONS_SEC,
)


def compute_trend_swing_targets_batch(
    emit_df: pl.DataFrame,
    spot_history_df: pl.DataFrame,
    *,
    instrument_name: str,
    session_end_sec: float,
    emit_ts_col: str = "ts_sec",
    emit_spot_col: str = "spot_at_t0",
    hist_ts_col: str = "ts_sec",
    hist_spot_col: str = "spot",
) -> pl.DataFrame:
    """Compute the 28 trend + swing target columns for every emit row.

    Args:
        emit_df: One row per emit point. Must contain ``ts_sec`` (epoch
            seconds at t0) and ``spot_at_t0``. Other columns are
            ignored / preserved on the way through.
        spot_history_df: Full-date spot history, one row per recorded
            underlying tick. Must contain ``ts_sec`` + ``spot``.
        instrument_name: Used to look up the noise floor (NIFTY /
            BANKNIFTY / CRUDEOIL / NATURALGAS).
        session_end_sec: Targets whose horizon extends past this are
            NaN (matches scalar's past_boundary guard).

    Returns:
        emit_df with 28 new columns appended (7 stats × 4 horizons):
            trend_direction_900s, trend_magnitude_900s,
            trend_max_excursion_900s, trend_max_drawdown_900s,
            trend_continues_900s, trend_breakout_imminent_900s,
            ... same for trend_*_1800s, swing_*_3600s, swing_*_7200s.

    Notes:
        Scaffold uses a sorted self-join then per-row aggregation. This
        is O(N_emit * avg_lookahead_rows) — fine on dates up to ~10k
        emit rows × ~10k history rows = 100M intermediate rows, slow
        beyond that. The B.3b execution pass replaces this with a
        join_asof-style sorted-time-window approach.
    """
    if len(emit_df) == 0:
        # Return empty DF with the expected output schema appended.
        return emit_df.with_columns(
            *[_null_col(_col_name(layer, w, stat))
              for layer, horizons in (("trend", TREND_HORIZONS_SEC),
                                      ("swing", SWING_HORIZONS_SEC))
              for w in horizons
              for stat in ("direction", "direction_down", "magnitude",
                           "max_excursion", "max_drawdown", "continues",
                           "breakout_imminent", "reversal", "exit_signal")]
        )

    noise_floor = NOISE_FLOOR_PTS.get(instrument_name)

    # Tag every emit row with an index so per-horizon joins stay aligned.
    emit_with_idx = emit_df.with_row_index("_emit_idx").rename({
        emit_ts_col: "_t0",
        emit_spot_col: "_spot0",
    })

    # Dominant direction over [t0 - CONTINUES_LOOKBACK_SEC, t0]:
    # earliest spot inside that lookback window. Sign of
    # (spot_at_t0 - earliest) determines dominant direction.
    lookback_join = (
        emit_with_idx.select(["_emit_idx", "_t0", "_spot0"])
        .join(
            spot_history_df.rename({hist_ts_col: "_h_ts",
                                    hist_spot_col: "_h_spot"}),
            how="cross",
        )
        .filter(
            (pl.col("_h_ts") >= pl.col("_t0") - CONTINUES_LOOKBACK_SEC)
            & (pl.col("_h_ts") <= pl.col("_t0"))
        )
        .sort(["_emit_idx", "_h_ts"])
        .group_by("_emit_idx", maintain_order=True)
        .agg(_earliest_lookback_spot=pl.col("_h_spot").first())
    )
    emit_with_idx = emit_with_idx.join(lookback_join, on="_emit_idx", how="left")
    emit_with_idx = emit_with_idx.with_columns(
        _dominant_dir=pl.when(
            pl.col("_earliest_lookback_spot").is_not_null()
        ).then(
            (pl.col("_spot0") - pl.col("_earliest_lookback_spot")).sign()
        ).otherwise(None)
    )

    result = emit_with_idx

    # One horizon at a time, append 6 columns per pass. Correctness-
    # first; perf optimisation deferred to B.3b execution session.
    for layer, horizons in (("trend", TREND_HORIZONS_SEC),
                            ("swing", SWING_HORIZONS_SEC)):
        scale = BREAKOUT_SCALE[layer]
        breakout_threshold = (
            None if noise_floor is None else noise_floor * scale
        )
        for w in horizons:
            # Lookahead = history entries with ts in (t0, t0 + w].
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

            # Past-session-end guard + lookahead-empty guard. We assume
            # _end_spot is null exactly when no lookahead row matched.
            past_boundary = pl.col("_t0") + w > session_end_sec
            empty_la = pl.col("_end_spot").is_null()
            mask_null = past_boundary | empty_la

            magnitude = pl.col("_end_spot") - pl.col("_spot0")
            excursion = pl.col("_max_spot") - pl.col("_spot0")
            drawdown = pl.col("_spot0") - pl.col("_min_spot")

            # direction: scalar (lines 261-265 of trend_swing_targets.py):
            #   if noise_floor is None: NaN
            #   else:                   1.0 if magnitude > noise_floor else 0.0
            # NOTE: this is BINARY (0/1), NOT a signed {-1,0,+1} bucket.
            if noise_floor is None:
                direction_expr = pl.when(mask_null).then(None).otherwise(
                    pl.lit(None).cast(pl.Float64)
                )
            else:
                direction_expr = (
                    pl.when(mask_null).then(None)
                      .otherwise(
                          pl.when(magnitude > noise_floor).then(1.0).otherwise(0.0)
                      )
                )

            # direction_down: scalar mirror (Part B) —
            #   if noise_floor is None: NaN
            #   else: 1.0 if magnitude < -noise_floor else 0.0
            if noise_floor is None:
                direction_down_expr = pl.when(mask_null).then(None).otherwise(
                    pl.lit(None).cast(pl.Float64)
                )
            else:
                direction_down_expr = (
                    pl.when(mask_null).then(None)
                      .otherwise(
                          pl.when(magnitude < -noise_floor).then(1.0).otherwise(0.0)
                      )
                )

            # continues: scalar (lines 267-284):
            #   NaN if noise_floor is None OR earliest_lookback_spot is None
            #   else if prior_change == 0 or magnitude == 0:   0.0
            #   else if same_sign(prior, mag) AND |mag| >= noise_floor: 1.0
            #   else: 0.0
            if noise_floor is None:
                continues_expr = pl.when(mask_null).then(None).otherwise(
                    pl.lit(None).cast(pl.Float64)
                )
            else:
                prior_change = pl.col("_spot0") - pl.col("_earliest_lookback_spot")
                same_sign = (
                    ((prior_change > 0) & (magnitude > 0))
                    | ((prior_change < 0) & (magnitude < 0))
                )
                big_enough = magnitude.abs() >= noise_floor
                continues_expr = (
                    pl.when(mask_null | pl.col("_earliest_lookback_spot").is_null())
                      .then(None)
                      .when((prior_change == 0) | (magnitude == 0))
                      .then(0.0)
                      .otherwise(
                          pl.when(same_sign & big_enough).then(1.0).otherwise(0.0)
                      )
                )

            # breakout_imminent: scalar (lines 286-292):
            #   NaN if breakout_threshold is None
            #   else: 1.0 if max_excursion >= breakout_threshold else 0.0
            # NOTE: scalar uses >= (inclusive), not > — match exactly.
            if breakout_threshold is None:
                breakout_expr = pl.when(mask_null).then(None).otherwise(
                    pl.lit(None).cast(pl.Float64)
                )
            else:
                breakout_expr = (
                    pl.when(mask_null).then(None)
                      .otherwise(
                          pl.when(excursion >= breakout_threshold).then(1.0).otherwise(0.0)
                      )
                )

            # reversal: scalar mirror (Part B) — inverse of continues:
            #   NaN if noise_floor is None OR earliest_lookback_spot is None
            #   else if prior_change == 0 or magnitude == 0: 0.0
            #   else if opp_sign(prior, mag) AND |mag| >= noise_floor: 1.0 else 0.0
            if noise_floor is None:
                reversal_expr = pl.when(mask_null).then(None).otherwise(
                    pl.lit(None).cast(pl.Float64)
                )
            else:
                prior_change = pl.col("_spot0") - pl.col("_earliest_lookback_spot")
                opp_sign = (
                    ((prior_change > 0) & (magnitude < 0))
                    | ((prior_change < 0) & (magnitude > 0))
                )
                big_enough = magnitude.abs() >= noise_floor
                reversal_expr = (
                    pl.when(mask_null | pl.col("_earliest_lookback_spot").is_null())
                      .then(None)
                      .when((prior_change == 0) | (magnitude == 0))
                      .then(0.0)
                      .otherwise(
                          pl.when(opp_sign & big_enough).then(1.0).otherwise(0.0)
                      )
                )

            # exit_signal: scalar mirror (Part B) — 1 iff the path visited BOTH
            # sides of entry: (max_spot > spot0) AND (min_spot < spot0), i.e.
            # (excursion > 0) AND (drawdown > 0). No noise floor.
            exit_signal_expr = (
                pl.when(mask_null).then(None)
                  .otherwise(
                      pl.when((excursion > 0) & (drawdown > 0)).then(1.0).otherwise(0.0)
                  )
            )

            result = result.with_columns(
                pl.when(mask_null).then(None).otherwise(magnitude)
                    .alias(_col_name(layer, w, "magnitude")),
                pl.when(mask_null).then(None).otherwise(excursion)
                    .alias(_col_name(layer, w, "max_excursion")),
                pl.when(mask_null).then(None).otherwise(drawdown)
                    .alias(_col_name(layer, w, "max_drawdown")),
                direction_expr.alias(_col_name(layer, w, "direction")),
                direction_down_expr.alias(_col_name(layer, w, "direction_down")),
                continues_expr.alias(_col_name(layer, w, "continues")),
                breakout_expr.alias(_col_name(layer, w, "breakout_imminent")),
                reversal_expr.alias(_col_name(layer, w, "reversal")),
                exit_signal_expr.alias(_col_name(layer, w, "exit_signal")),
            ).drop(["_end_spot", "_max_spot", "_min_spot"])

    # Strip the internal helper columns; restore original emit_df shape
    # plus the 28 new target columns.
    return result.drop(["_emit_idx", "_t0", "_spot0",
                        "_earliest_lookback_spot", "_dominant_dir"]).rename(
        {}  # no renames needed; we used aliases above
    )


def _col_name(layer: str, horizon_sec: int, stat: str) -> str:
    return f"{layer}_{stat}_{horizon_sec}s"


def _null_col(name: str) -> pl.Expr:
    return pl.lit(None).alias(name)
