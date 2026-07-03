"""
trend_swing_targets.py — Phase 3 target labels for trend + swing model heads.

The scalp model's targets (in `features/targets.py`) are option-leg-aware:
they read per-strike CE/PE LTPs because scalp trades option premium directly.
Trend and swing model heads predict on the UNDERLYING SPOT — per V2_MASTER_SPEC
§2.2.2 D75 Gap 3, the layers are intentionally asymmetric. So trend/swing
targets need only the spot price series, not option ticks.

Seven target types per horizon (V2_MASTER_SPEC §2.2.2 + Part B 2026-07-02):

    direction_{w}s             Binary. 1 if spot(t+w) > spot(t) + noise_floor.
                               Labels only economically-significant UP moves.
    direction_down_{w}s        Binary. 1 if spot(t+w) < spot(t) − noise_floor.
                               Mirror of `direction` for DOWN moves (Part B) —
                               lets the trend gate fire puts on real down-legs.
    magnitude_{w}s             Signed regression. spot(t+w) − spot(t).
    max_excursion_{w}s         Regression. max(spot(t..t+w)) − spot(t).
                               Best upward move reached anytime in window.
    max_drawdown_{w}s          Regression. spot(t) − min(spot(t..t+w)).
                               Worst dip reached anytime in window.
    continues_{w}s             Binary. 1 if direction at t+w matches the
                               dominant direction over [t-300s, t] AND
                               |magnitude| ≥ noise_floor. Captures
                               "trend continuation" vs reversal.
    breakout_imminent_{w}s     Binary. 1 if max excursion in [t, t+w]
                               clears noise_floor × scale. scale=3 for
                               trend, scale=6 for swing — coarser bar
                               for swing because the 2-hour window
                               naturally catches more wiggles.

Per-layer column names use the `{layer}_` prefix per spec:
    trend_direction_900s, trend_direction_1800s,
    swing_direction_3600s, swing_direction_7200s, etc.

Horizons (V2_MASTER_SPEC §2.2.1):
    trend = 900s (15 min), 1800s (30 min)
    swing = 3600s (1 hr), 7200s (2 hr)
    → 7 types × 4 horizons = 28 new target columns.

Noise floor (V2_MASTER_SPEC §7, locked 2026-05-16):
    nifty50    : 8 pts
    banknifty  : 25 pts
    crudeoil   : 5 INR
    naturalgas : 3 INR

Replay-only design (Option B, locked 2026-05-18):
    Computing these targets needs up to 2 hours of FUTURE ticks for swing
    at 7200s. Live runs hold tens-of-thousands of pending rows × 4 KB each
    if they backfill — ~600 MB across the fleet. The model itself doesn't
    need targets at inference time (it only emits predictions), so live
    emits NaN for the 28 trend/swing target columns; the end-of-day
    replay pipeline re-reads the recorded raw ticks and writes a training
    parquet with the targets populated.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass

_NAN = float("nan")

# Per-instrument noise floor in spot points (V2_MASTER_SPEC §7, LOCKED 2026-05-16).
NOISE_FLOOR_PTS: dict[str, float] = {
    "NIFTY": 8.0,
    "BANKNIFTY": 25.0,
    "CRUDEOIL": 5.0,
    "NATURALGAS": 3.0,
}

# Per-layer scale on the breakout_imminent threshold.
BREAKOUT_SCALE: dict[str, float] = {
    "trend": 3.0,
    "swing": 6.0,
}

# Horizons per layer (in seconds).
TREND_HORIZONS_SEC: tuple[int, ...] = (900, 1800)
SWING_HORIZONS_SEC: tuple[int, ...] = (3600, 7200)

# How far we look BACKWARD (from t0) to derive the "dominant direction
# over [t-300s, t]" used by the continues target.
CONTINUES_LOOKBACK_SEC: float = 300.0


# ── Spot history entry ────────────────────────────────────────────────────


@dataclass
class _SpotEntry:
    """A single (timestamp, spot) sample held in SpotTargetBuffer."""

    ts: float
    spot: float


# ── Buffer ────────────────────────────────────────────────────────────────


class SpotTargetBuffer:
    """Replay-only buffer of (ts, spot) samples for trend + swing targets.

    Lightweight by design — stores only timestamps and spot. No option
    legs, no chain rows. Memory cost is trivial even at 2-hour retention.

    Lifecycle:
        - Construct with no args (uses default trend + swing horizons).
        - On each replay underlying tick: ``buf.push(ts, spot)``.
        - When a row is ready to flush: ``buf.compute_targets(t0, spot_at_t0,
          instrument_name, session_end_sec)`` returns the 24 target dict.
        - At session end / between sessions: ``buf.reset()``.
    """

    def __init__(
        self,
        *,
        trend_horizons_sec: tuple[int, ...] = TREND_HORIZONS_SEC,
        swing_horizons_sec: tuple[int, ...] = SWING_HORIZONS_SEC,
    ) -> None:
        self._trend_horizons = tuple(sorted(trend_horizons_sec))
        self._swing_horizons = tuple(sorted(swing_horizons_sec))
        all_horizons = self._trend_horizons + self._swing_horizons
        if not all_horizons:
            raise ValueError("at least one horizon required")
        # Retention = max horizon + lookback for continues + small pad.
        self._retention_sec = float(max(all_horizons)) + CONTINUES_LOOKBACK_SEC + 10.0
        self._entries: deque[_SpotEntry] = deque()

    # ── Buffer ops ────────────────────────────────────────────────────────

    def push(self, ts: float, spot: float) -> None:
        """Add a (ts, spot) sample. Invalid inputs are silently dropped.

        Prunes entries older than retention from the left in O(1) amortised.
        """
        if not (
            isinstance(ts, (int, float))
            and math.isfinite(ts)
            and isinstance(spot, (int, float))
            and math.isfinite(spot)
            and spot > 0
        ):
            return
        ts_v = float(ts)
        self._entries.append(_SpotEntry(ts_v, float(spot)))
        cutoff = ts_v - self._retention_sec
        while self._entries and self._entries[0].ts < cutoff:
            self._entries.popleft()

    def reset(self) -> None:
        self._entries.clear()

    # ── Compute ──────────────────────────────────────────────────────────

    def compute_targets(
        self,
        *,
        t0: float,
        spot_at_t0: float,
        instrument_name: str,
        session_end_sec: float | None,
    ) -> dict[str, float]:
        """Compute all 24 trend + swing target columns for the tick at t0.

        Returns a dict keyed by the column names assemble_flat_vector expects.
        Any target whose horizon extends past session_end_sec is NaN.
        Targets are NaN whenever the buffer lacks an at-or-near-end sample.
        """
        out: dict[str, float] = {}
        noise_floor = NOISE_FLOOR_PTS.get(instrument_name)

        # Pre-compute lookahead + lookback slices once.
        if not (
            isinstance(t0, (int, float))
            and math.isfinite(t0)
            and isinstance(spot_at_t0, (int, float))
            and math.isfinite(spot_at_t0)
            and spot_at_t0 > 0
        ):
            # All NaN if t0 / spot_at_t0 invalid.
            for layer, horizons in (
                ("trend", self._trend_horizons),
                ("swing", self._swing_horizons),
            ):
                for w in horizons:
                    out[f"{layer}_direction_{w}s"] = _NAN
                    out[f"{layer}_direction_down_{w}s"] = _NAN
                    out[f"{layer}_magnitude_{w}s"] = _NAN
                    out[f"{layer}_max_excursion_{w}s"] = _NAN
                    out[f"{layer}_max_drawdown_{w}s"] = _NAN
                    out[f"{layer}_continues_{w}s"] = _NAN
                    out[f"{layer}_breakout_imminent_{w}s"] = _NAN
            return out

        # Dominant direction of [t0 - CONTINUES_LOOKBACK_SEC, t0], used by
        # `continues`. Sign of (spot_at_t0 − earliest_spot_in_lookback).
        lookback_cutoff = t0 - CONTINUES_LOOKBACK_SEC
        earliest_lookback_spot: float | None = None
        for e in self._entries:
            if e.ts < lookback_cutoff:
                continue
            if e.ts > t0:
                break
            earliest_lookback_spot = e.spot
            break  # first one inside window — that's the earliest

        for layer, horizons in (
            ("trend", self._trend_horizons),
            ("swing", self._swing_horizons),
        ):
            scale = BREAKOUT_SCALE[layer]
            breakout_threshold = (
                None if noise_floor is None else noise_floor * scale
            )

            for w in horizons:
                feat_dir = f"{layer}_direction_{w}s"
                feat_dir_down = f"{layer}_direction_down_{w}s"
                feat_mag = f"{layer}_magnitude_{w}s"
                feat_excur = f"{layer}_max_excursion_{w}s"
                feat_draw = f"{layer}_max_drawdown_{w}s"
                feat_cont = f"{layer}_continues_{w}s"
                feat_brk = f"{layer}_breakout_imminent_{w}s"

                # Past session-end? All NaN for this window.
                if session_end_sec is not None and (t0 + w) > session_end_sec:
                    out[feat_dir] = _NAN
                    out[feat_dir_down] = _NAN
                    out[feat_mag] = _NAN
                    out[feat_excur] = _NAN
                    out[feat_draw] = _NAN
                    out[feat_cont] = _NAN
                    out[feat_brk] = _NAN
                    continue

                # Lookahead window: (t0, t0+w]
                lookahead_end = t0 + w
                lookahead = [
                    e for e in self._entries
                    if t0 < e.ts <= lookahead_end
                ]
                if not lookahead:
                    out[feat_dir] = _NAN
                    out[feat_dir_down] = _NAN
                    out[feat_mag] = _NAN
                    out[feat_excur] = _NAN
                    out[feat_draw] = _NAN
                    out[feat_cont] = _NAN
                    out[feat_brk] = _NAN
                    continue

                # End-of-window spot — use the LAST sample in the window
                # (closest to t0+w). Per spec, "spot(t+w)" semantics.
                end_spot = lookahead[-1].spot
                max_spot = max(e.spot for e in lookahead)
                min_spot = min(e.spot for e in lookahead)

                magnitude = end_spot - spot_at_t0
                max_excursion = max_spot - spot_at_t0
                max_drawdown = spot_at_t0 - min_spot

                out[feat_mag] = magnitude
                out[feat_excur] = max_excursion
                out[feat_draw] = max_drawdown

                # direction: 1 iff move clears the noise floor upward.
                # direction_down: 1 iff move clears the noise floor DOWNWARD
                # (Part B) — the symmetric mirror so the trend gate can call
                # puts on genuine down-legs instead of guessing from up-prob.
                if noise_floor is None:
                    out[feat_dir] = _NAN
                    out[feat_dir_down] = _NAN
                else:
                    out[feat_dir] = 1.0 if magnitude > noise_floor else 0.0
                    out[feat_dir_down] = 1.0 if magnitude < -noise_floor else 0.0

                # continues: 1 iff direction at t+w matches dominant
                # direction over [t-300s, t] AND |magnitude| ≥ noise_floor.
                if noise_floor is None or earliest_lookback_spot is None:
                    out[feat_cont] = _NAN
                else:
                    prior_change = spot_at_t0 - earliest_lookback_spot
                    if prior_change == 0 or magnitude == 0:
                        # No prior direction or no forward move → not a
                        # continuation.
                        out[feat_cont] = 0.0
                    else:
                        same_sign = (prior_change > 0 and magnitude > 0) or (
                            prior_change < 0 and magnitude < 0
                        )
                        big_enough = abs(magnitude) >= noise_floor
                        out[feat_cont] = (
                            1.0 if (same_sign and big_enough) else 0.0
                        )

                # breakout_imminent: 1 iff max excursion ≥ noise_floor × scale.
                if breakout_threshold is None:
                    out[feat_brk] = _NAN
                else:
                    out[feat_brk] = (
                        1.0 if max_excursion >= breakout_threshold else 0.0
                    )

        return out


# ── Column-name helpers ───────────────────────────────────────────────────


def trend_swing_target_column_names(
    trend_horizons_sec: tuple[int, ...] = TREND_HORIZONS_SEC,
    swing_horizons_sec: tuple[int, ...] = SWING_HORIZONS_SEC,
) -> tuple[str, ...]:
    """Return the 24 trend + swing target column names in deterministic order.

    Order matches the per-layer / per-horizon / per-type nesting documented in
    the module header. Used by the emitter to add columns to the v8 schema.
    """
    names: list[str] = []
    for layer, horizons in (
        ("trend", trend_horizons_sec),
        ("swing", swing_horizons_sec),
    ):
        for w in sorted(horizons):
            for t in (
                "direction",
                "direction_down",
                "magnitude",
                "max_excursion",
                "max_drawdown",
                "continues",
                "breakout_imminent",
            ):
                names.append(f"{layer}_{t}_{w}s")
    return tuple(names)


def null_trend_swing_targets(
    trend_horizons_sec: tuple[int, ...] = TREND_HORIZONS_SEC,
    swing_horizons_sec: tuple[int, ...] = SWING_HORIZONS_SEC,
) -> dict[str, float]:
    """Return a dict mapping every trend/swing target column to NaN.

    Used by the live path (Option B): live emits NaN for all 28 trend/swing
    target columns since live doesn't run the 2-hour backfill buffer.
    """
    return {name: _NAN for name in trend_swing_target_column_names(
        trend_horizons_sec, swing_horizons_sec,
    )}
