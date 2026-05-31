"""
_shared/reliability.py — T34 §5.1 reliability scoring primitives.

Pure-function core consumed by ``scripts/trade_quality_report_weekly.py``.
Operates on T41's predictions parquet (or any dataframe with
``calibrated_prob`` + ``outcome_direction`` columns) and produces per-
head + per-cohort decile-calibration scores.

Algorithm (V2_MASTER_SPEC §5.1 D72):

    1. Filter rows to binary-classifier heads with outcomes backfilled.
    2. Sort by calibrated_prob, split into N (default 10) equal-size
       deciles.
    3. Per decile: mean(calibrated_prob), fraction of rows where the
       actual outcome counts as a positive (outcome_direction == 1 for
       direction heads; configurable predicate for other binary heads).
    4. ``diff_i = | mean_prob_i - actual_rate_i |`` per decile.
    5. ``calibration_score = max_i diff_i``. PASS when score ≤ tol
       (default 0.05); FAIL otherwise.

Regression heads (max_upside_*, risk_reward_ratio_*, etc.) need a
different metric — handled by ``regression_calibration_score`` (R²
on (calibrated, outcome_magnitude)).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np
import polars as pl

# Heads whose calibrated_prob is a probability in [0, 1] AND whose
# outcome is well-defined as a binary positive. Listed by prefix so
# new horizons (e.g. exit_signal_120s) auto-match.
_BINARY_HEAD_PREFIXES: tuple[str, ...] = (
    "direction_",          # direction_30s, direction_60s
    "direction_persists_", # direction_persists_60s..300s
    "breakout_in_",        # breakout_in_60s, breakout_in_300s
    "exit_signal_",        # exit_signal_60s, exit_signal_300s
)

# direction_30s_magnitude / direction_60s_magnitude are NOT binary —
# they're regression heads sharing the direction_ prefix. Strip them
# out before the prefix scan above.
_REGRESSION_DIRECTION_MAG_RE = re.compile(r"^direction_\d+s_magnitude$")

DEFAULT_TOLERANCE = 0.05
DEFAULT_DECILES = 10
DEFAULT_MIN_ROWS_PER_DECILE = 10


@dataclass
class DecileBucket:
    """One decile's calibration evidence."""
    decile: int            # 0..N-1
    n_rows: int
    mean_predicted_prob: float
    actual_positive_rate: float
    abs_diff: float        # |predicted - actual|


@dataclass
class HeadCalibrationReport:
    """Per-head calibration verdict from one week's predictions."""
    head_name: str
    head_type: str | None  # cohort
    n_rows_total: int
    n_rows_with_outcome: int
    buckets: list[DecileBucket]
    calibration_score: float       # max abs_diff across buckets
    passed: bool                   # score ≤ tolerance
    tolerance: float
    skipped_reason: str | None     # set when n_rows_with_outcome < threshold


def is_binary_classifier_head(head_name: str) -> bool:
    """True iff this head emits a probability whose calibration is well
    defined against outcome_direction == 1.

    Filters out the ``direction_NNs_magnitude`` regression heads which
    share the ``direction_`` prefix but emit floats, not probabilities.
    """
    if _REGRESSION_DIRECTION_MAG_RE.match(head_name):
        return False
    return head_name.startswith(_BINARY_HEAD_PREFIXES)


def _equal_size_decile_indices(n_rows: int, n_deciles: int) -> list[tuple[int, int]]:
    """Equal-size decile slice indices ``(start, end)`` (exclusive end).

    Uses ``np.array_split``-style boundaries: the leading deciles take
    the extra rows when ``n_rows`` doesn't divide evenly. Matches the
    standard reliability-diagram convention.
    """
    if n_rows <= 0 or n_deciles <= 0:
        return []
    boundaries = np.linspace(0, n_rows, n_deciles + 1).astype(int)
    return [(int(boundaries[i]), int(boundaries[i + 1])) for i in range(n_deciles)]


def score_head_calibration(
    df: pl.DataFrame,
    head_name: str,
    head_type: str | None,
    *,
    n_deciles: int = DEFAULT_DECILES,
    tolerance: float = DEFAULT_TOLERANCE,
    min_rows_per_decile: int = DEFAULT_MIN_ROWS_PER_DECILE,
) -> HeadCalibrationReport:
    """Per-head calibration score.

    Args:
        df: Polars DataFrame already filtered to this head's rows. Must
            contain ``calibrated_prob`` (Float64) and
            ``outcome_direction`` (Int8, nullable). Rows with NULL
            outcome are filtered out by this function.
        head_name: e.g. ``"direction_30s"``.
        head_type: ``"scalp"`` / ``"trend"`` / ... from T33; None until
            T33's wire-in populates it for this row.
        n_deciles: how many quantile buckets to split the calibrated
            probabilities into. 10 is the §5.1 convention.
        tolerance: max allowed ``|mean_predicted - actual_rate|`` per
            decile. PASS when every decile is within this bound.
        min_rows_per_decile: skip the whole head's report when there
            aren't enough rows to fill the deciles meaningfully — the
            sampling noise on a 2-row decile dominates any real
            calibration signal.

    Returns:
        ``HeadCalibrationReport``. Skipped reports carry an empty
        ``buckets`` list, ``calibration_score = NaN``, ``passed = False``,
        and a non-None ``skipped_reason``.
    """
    n_total = len(df)
    with_outcome = df.filter(pl.col("outcome_direction").is_not_null())
    n_with_outcome = len(with_outcome)
    needed = n_deciles * min_rows_per_decile

    if n_with_outcome < needed:
        return HeadCalibrationReport(
            head_name=head_name,
            head_type=head_type,
            n_rows_total=n_total,
            n_rows_with_outcome=n_with_outcome,
            buckets=[],
            calibration_score=float("nan"),
            passed=False,
            tolerance=tolerance,
            skipped_reason=(
                f"insufficient outcome rows ({n_with_outcome} < {needed} "
                f"required for {n_deciles} deciles × {min_rows_per_decile} min)"
            ),
        )

    sorted_df = with_outcome.sort("calibrated_prob", nulls_last=True)
    probs = sorted_df["calibrated_prob"].to_numpy()
    directions = sorted_df["outcome_direction"].to_numpy()

    buckets: list[DecileBucket] = []
    score = 0.0
    for i, (start, end) in enumerate(_equal_size_decile_indices(n_with_outcome, n_deciles)):
        if end <= start:
            continue
        decile_probs = probs[start:end]
        decile_dirs = directions[start:end]
        mean_pred = float(np.nanmean(decile_probs))
        # Direction-based positive: outcome_direction == 1 (spot moved up).
        # Treats 0 and -1 alike as "not a positive."
        actual_rate = float(np.mean(decile_dirs == 1))
        diff = abs(mean_pred - actual_rate)
        score = max(score, diff)
        buckets.append(DecileBucket(
            decile=i,
            n_rows=int(end - start),
            mean_predicted_prob=mean_pred,
            actual_positive_rate=actual_rate,
            abs_diff=diff,
        ))

    return HeadCalibrationReport(
        head_name=head_name,
        head_type=head_type,
        n_rows_total=n_total,
        n_rows_with_outcome=n_with_outcome,
        buckets=buckets,
        calibration_score=score,
        passed=score <= tolerance,
        tolerance=tolerance,
        skipped_reason=None,
    )


def score_all_heads(
    df: pl.DataFrame,
    *,
    n_deciles: int = DEFAULT_DECILES,
    tolerance: float = DEFAULT_TOLERANCE,
    min_rows_per_decile: int = DEFAULT_MIN_ROWS_PER_DECILE,
) -> list[HeadCalibrationReport]:
    """Score every binary-classifier head present in ``df``.

    Returns one ``HeadCalibrationReport`` per unique head_name. Skipped
    heads (insufficient outcome rows) appear in the list with
    ``skipped_reason`` set so the caller can surface them — silent
    omission would hide gaps.
    """
    if len(df) == 0 or "head_name" not in df.columns:
        return []
    unique_heads = (
        df.select(["head_name", "head_type"]).unique().sort("head_name")
    )
    reports: list[HeadCalibrationReport] = []
    for row in unique_heads.iter_rows(named=True):
        name = row["head_name"]
        if not is_binary_classifier_head(name):
            continue
        head_df = df.filter(pl.col("head_name") == name)
        reports.append(score_head_calibration(
            head_df, head_name=name, head_type=row.get("head_type"),
            n_deciles=n_deciles, tolerance=tolerance,
            min_rows_per_decile=min_rows_per_decile,
        ))
    return reports


def render_markdown_summary(
    reports: list[HeadCalibrationReport],
    *,
    title: str = "T34 §5.1 Weekly reliability",
) -> str:
    """Render a list of head reports as a single markdown document."""
    lines: list[str] = []
    lines.append(f"# {title}")
    lines.append("")
    if not reports:
        lines.append("_No binary-classifier head data in scope._")
        return "\n".join(lines)

    n_pass = sum(1 for r in reports if r.passed)
    n_fail = sum(1 for r in reports if not r.passed and r.skipped_reason is None)
    n_skipped = sum(1 for r in reports if r.skipped_reason is not None)
    lines.append(
        f"**Summary:** {n_pass} PASS · {n_fail} FAIL · {n_skipped} SKIPPED · "
        f"{len(reports)} total"
    )
    lines.append("")
    lines.append("## Per-head verdicts")
    lines.append("")
    lines.append(
        "| Head | Cohort | Rows (w/ outcome) | Max decile diff | "
        "Tolerance | Verdict |"
    )
    lines.append(
        "|---|---|---|---|---|---|"
    )
    for r in reports:
        if r.skipped_reason is not None:
            verdict = f"SKIPPED ({r.skipped_reason})"
            score_str = "—"
        elif r.passed:
            verdict = "✅ PASS"
            score_str = f"{r.calibration_score:.3f}"
        else:
            verdict = "❌ FAIL"
            score_str = f"{r.calibration_score:.3f}"
        cohort = r.head_type or "—"
        lines.append(
            f"| `{r.head_name}` | {cohort} | "
            f"{r.n_rows_total} ({r.n_rows_with_outcome}) | {score_str} | "
            f"{r.tolerance:.2f} | {verdict} |"
        )

    # Per-cohort aggregate
    by_cohort: dict[str, list[HeadCalibrationReport]] = {}
    for r in reports:
        if r.skipped_reason is not None:
            continue
        key = r.head_type or "_uncohorted"
        by_cohort.setdefault(key, []).append(r)

    if by_cohort:
        lines.append("")
        lines.append("## Per-cohort summary")
        lines.append("")
        lines.append("| Cohort | Heads | Pass rate | Median max-diff |")
        lines.append("|---|---|---|---|")
        for cohort_name, rs in sorted(by_cohort.items()):
            n = len(rs)
            pass_rate = sum(1 for r in rs if r.passed) / n
            median_diff = float(np.median([r.calibration_score for r in rs]))
            lines.append(
                f"| {cohort_name} | {n} | {pass_rate:.1%} | {median_diff:.3f} |"
            )

    # Detail tables for FAIL heads only (PASS heads don't need decile
    # drill-down in the summary — operator opens the CSV for those).
    failed = [
        r for r in reports
        if not r.passed and r.skipped_reason is None
    ]
    if failed:
        lines.append("")
        lines.append("## FAIL drill-down")
        for r in failed:
            lines.append("")
            lines.append(f"### `{r.head_name}` ({r.head_type or '—'})")
            lines.append("")
            lines.append(
                "| Decile | N | Mean predicted | Actual positive rate | |diff| |"
            )
            lines.append("|---|---|---|---|---|")
            for b in r.buckets:
                lines.append(
                    f"| {b.decile} | {b.n_rows} | "
                    f"{b.mean_predicted_prob:.4f} | "
                    f"{b.actual_positive_rate:.4f} | "
                    f"{b.abs_diff:.4f} |"
                )

    return "\n".join(lines)
