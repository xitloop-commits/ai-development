"""
signal_engine_agent/cohort.py — T33 D56 cohort tagging.

Classifies a model head by its lookahead window into one of four
attribution cohorts:

    "scalp"             — windows ≤ 300s (option-leg premium scalp targets)
    "trend"             — windows 900s–1800s (15–30 min trend)
    "swing"             — windows 3600s–7200s (1–2 hr swing)
    "multi_day_swing"   — windows > 7200s (T7 multi-day-overnight hold)

Used by:
  * ``prediction_logger`` — populates the ``head_type`` column on
    every per-head row of ``<inst>_predictions.parquet``.
  * ``signal_logger`` — tags the emitted signal JSON with the
    originating cohort so the broker-side fill log + post-paper
    attribution can group by cohort end-to-end.

Future-proofing: the boundaries match the design constants in
``features/trend_swing_targets.py`` (``TREND_HORIZONS_SEC`` = (900, 1800),
``SWING_HORIZONS_SEC`` = (3600, 7200)). If those move, this file moves
with them.

A head whose lookahead can't be parsed returns ``None`` — the caller
treats that as "no cohort attribution" (T41 stores NULL).
"""

from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PYTHON_MODULES = _HERE.parent
if str(_PYTHON_MODULES) not in sys.path:
    sys.path.insert(0, str(_PYTHON_MODULES))

from _shared.prediction_schema import parse_lookahead_seconds


COHORT_SCALP = "scalp"
COHORT_TREND = "trend"
COHORT_SWING = "swing"
COHORT_MULTI_DAY_SWING = "multi_day_swing"

# Boundaries match features/trend_swing_targets.py + V2_MASTER_SPEC §2.2.1.
SCALP_MAX_SEC = 300
TREND_MIN_SEC = 900
TREND_MAX_SEC = 1800
SWING_MIN_SEC = 3600
SWING_MAX_SEC = 7200


def classify_window_seconds(w_sec: int) -> str | None:
    """Bucket a lookahead window in seconds into a cohort label.

    Returns ``None`` when the window doesn't map to a known cohort
    (e.g. a 600s gap between scalp and trend — not currently used by
    any head, but explicit so a future schema bump doesn't get a
    silently-mislabelled bucket)."""
    if w_sec <= 0:
        return None
    if w_sec <= SCALP_MAX_SEC:
        return COHORT_SCALP
    if TREND_MIN_SEC <= w_sec <= TREND_MAX_SEC:
        return COHORT_TREND
    if SWING_MIN_SEC <= w_sec <= SWING_MAX_SEC:
        return COHORT_SWING
    if w_sec > SWING_MAX_SEC:
        return COHORT_MULTI_DAY_SWING
    return None


def classify_head(head_name: str) -> str | None:
    """Window-based cohort label for a model head.

    Parses the trailing (or embedded) ``_NNNs`` window from the head
    name via :func:`prediction_schema.parse_lookahead_seconds`, then
    delegates to :func:`classify_window_seconds`.

    Returns ``None`` when:
      * the head name has no window suffix (e.g. ``upside_percentile``,
        non-target columns)
      * the window is outside the four recognised cohort bands
    """
    w = parse_lookahead_seconds(head_name)
    if w <= 0:
        return None
    return classify_window_seconds(w)


def build_head_type_map(head_names: list[str] | tuple[str, ...]) -> dict[str, str]:
    """Pre-compute ``{head_name: cohort}`` for a fixed head list.

    The engine builds this once at startup and passes the (immutable)
    map to ``prediction_logger.log_eval`` on every eval — no per-call
    classification cost. Heads that classify as ``None`` are omitted
    so callers' ``.get(name)`` returns ``None`` cleanly.
    """
    out: dict[str, str] = {}
    for name in head_names:
        cohort = classify_head(name)
        if cohort is not None:
            out[name] = cohort
    return out