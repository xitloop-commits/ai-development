"""
_shared/feature_importance.py — T34 weekly feature-importance scoring.

Ranks model features by LightGBM split-gain per head, per instrument.
Consumed by ``scripts/shap_report_weekly.py``. Despite the script
filename (kept to match V2_MASTER_SPEC §5.8 T3 plan line 113), the
attribution metric is gain-importance, not true SHAP — chosen to avoid
pinning the ~20 MB ``shap`` package when LightGBM's built-in gain
ranking answers the actual T14 / T21 question:

    "Which features drive each head, ranked, per instrument?"

If per-row attribution or interaction effects are ever required, swap
``head_gain_importance`` for ``shap.TreeExplainer(booster).shap_values``
and the rest of the pipeline holds. The CSV/markdown shape doesn't
change.

Caller responsibilities:
  - Locate the model bundle directory (typically
    ``models/<instrument>/LATEST/`` after the symlink is resolved).
  - Filter to heads worth ranking (the per-instrument LATEST_HEADS.json
    lists everything; the caller can drop heads with no calibration
    map if it wants binary-only rankings).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import lightgbm as lgb
import numpy as np

DEFAULT_TOP_N = 20
NORMALISE_TO_PERCENT = True


@dataclass
class FeatureRank:
    """One feature's importance within one head."""
    rank: int                # 0..top_n-1
    feature_name: str
    importance: float        # raw LGBM gain (sum of split gain)
    pct_of_total: float      # importance / sum(all_importances) × 100


@dataclass
class HeadFeatureReport:
    """All-feature ranking for one (instrument, head) model."""
    instrument: str
    head_name: str
    head_type: str | None         # "scalp"/"trend"/... from LATEST_HEADS.json
    objective: str                # "binary"/"regression"
    n_features: int               # total features the model knows about
    top_features: list[FeatureRank]
    total_gain: float             # sum of gain across all features
    missing_model: bool = False   # True if model file was unreadable


def load_latest_heads_manifest(instrument_dir: Path) -> dict:
    """Read ``<instrument>/LATEST_HEADS.json`` — the per-head config that
    lists head_type, objective, lookahead_seconds, and model filename.
    """
    path = instrument_dir / "LATEST_HEADS.json"
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_latest_model_dir(instrument_dir: Path) -> Path:
    """Resolve ``<instrument>/LATEST`` to the actual dated bundle dir.

    Three layouts are supported, in priority order:

      1. ``LATEST`` is a regular text file whose contents are the
         timestamp directory name (e.g. ``"20260524_115037"``). This
         is what MTA writes on Windows where symlinks need admin.
      2. ``LATEST`` is a symlink / junction → ``Path.resolve()``.
      3. ``LATEST`` is a literal directory (test bundles).
      4. Fallback: use the ``timestamp`` field from LATEST_HEADS.json.
    """
    candidate = instrument_dir / "LATEST"
    if candidate.is_file():
        timestamp = candidate.read_text(encoding="utf-8").strip()
        dated = instrument_dir / timestamp
        if dated.is_dir():
            return dated
    elif candidate.is_dir():
        # Either a real dir or a symlink/junction — resolve handles both.
        return candidate.resolve()

    manifest = load_latest_heads_manifest(instrument_dir)
    timestamp = manifest.get("timestamp")
    if timestamp:
        dated = instrument_dir / timestamp
        if dated.is_dir():
            return dated
    raise FileNotFoundError(
        f"could not resolve LATEST under {instrument_dir} "
        f"(no LATEST symlink, no LATEST text file, no timestamped fallback)"
    )


def head_gain_importance(booster: lgb.Booster) -> dict[str, float]:
    """Return ``{feature_name: gain}`` for a trained LightGBM model.

    ``importance_type="gain"`` sums the total split gain attributed to
    each feature across every tree — the standard global feature-
    importance metric. Returns zero entries for features the model
    never split on.
    """
    names = booster.feature_name()
    gains = booster.feature_importance(importance_type="gain")
    return {name: float(g) for name, g in zip(names, gains)}


def rank_top_n(
    importance: dict[str, float],
    *,
    top_n: int = DEFAULT_TOP_N,
) -> tuple[list[FeatureRank], float]:
    """Sort by descending importance, take top N, return ranks + total gain.

    Returns ``([FeatureRank, ...], total_gain)``. ``total_gain`` covers
    all features (not just top N) — used to compute pct_of_total cleanly.
    """
    total = sum(importance.values())
    sorted_pairs = sorted(importance.items(), key=lambda kv: -kv[1])
    top = sorted_pairs[:top_n]
    ranks: list[FeatureRank] = []
    for i, (name, gain) in enumerate(top):
        pct = (gain / total * 100.0) if total > 0 else 0.0
        ranks.append(FeatureRank(
            rank=i,
            feature_name=name,
            importance=gain,
            pct_of_total=pct,
        ))
    return ranks, total


def score_head_for_instrument(
    *,
    instrument: str,
    model_dir: Path,
    head_name: str,
    head_meta: dict,
    top_n: int = DEFAULT_TOP_N,
) -> HeadFeatureReport:
    """Build a feature-importance report for one head.

    Tolerates a missing .lgbm file (e.g. a head was added to the
    manifest but the training run failed for it) — the report comes
    back with ``missing_model=True`` and an empty top list.
    """
    lgbm_path_str = head_meta.get("lgbm_path")
    if not lgbm_path_str:
        return HeadFeatureReport(
            instrument=instrument, head_name=head_name,
            head_type=head_meta.get("head_type"),
            objective=head_meta.get("objective", ""),
            n_features=0, top_features=[], total_gain=0.0,
            missing_model=True,
        )

    lgbm_path = model_dir / lgbm_path_str
    if not lgbm_path.exists():
        return HeadFeatureReport(
            instrument=instrument, head_name=head_name,
            head_type=head_meta.get("head_type"),
            objective=head_meta.get("objective", ""),
            n_features=0, top_features=[], total_gain=0.0,
            missing_model=True,
        )

    booster = lgb.Booster(model_file=str(lgbm_path))
    importance = head_gain_importance(booster)
    top_features, total = rank_top_n(importance, top_n=top_n)
    return HeadFeatureReport(
        instrument=instrument, head_name=head_name,
        head_type=head_meta.get("head_type"),
        objective=head_meta.get("objective", ""),
        n_features=booster.num_feature(),
        top_features=top_features,
        total_gain=total,
        missing_model=False,
    )


def score_instrument(
    *,
    instrument: str,
    instrument_dir: Path,
    top_n: int = DEFAULT_TOP_N,
    head_filter: set[str] | None = None,
) -> list[HeadFeatureReport]:
    """Score every head listed in ``<instrument>/LATEST_HEADS.json``.

    ``head_filter`` (if given) restricts to that set of head names —
    useful for "binary classifiers only" runs that pair with the
    reliability report's coverage.
    """
    manifest = load_latest_heads_manifest(instrument_dir)
    heads = manifest.get("heads", {})
    model_dir = resolve_latest_model_dir(instrument_dir)
    reports: list[HeadFeatureReport] = []
    for head_name, head_meta in sorted(heads.items()):
        if head_filter is not None and head_name not in head_filter:
            continue
        reports.append(score_head_for_instrument(
            instrument=instrument, model_dir=model_dir,
            head_name=head_name, head_meta=head_meta, top_n=top_n,
        ))
    return reports


# --- aggregation & rendering -------------------------------------------------

def cross_instrument_concordance(
    reports_by_instrument: dict[str, list[HeadFeatureReport]],
    *,
    head_name: str,
    top_n: int = 10,
) -> list[tuple[str, int]]:
    """For one head, count how many instruments rank each feature in
    their top-N for that head. Returns ``[(feature, n_instruments), ...]``
    sorted by n_instruments descending then feature name.

    Used by the markdown summary to surface features that consistently
    drive a given head across all four instruments — strong evidence
    they're worth keeping, vs features that only matter for one
    instrument (candidates for instrument-specific pruning).
    """
    counts: dict[str, int] = {}
    for instrument, reports in reports_by_instrument.items():
        for r in reports:
            if r.head_name != head_name or r.missing_model:
                continue
            for fr in r.top_features[:top_n]:
                counts[fr.feature_name] = counts.get(fr.feature_name, 0) + 1
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))


def render_markdown_summary(
    reports_by_instrument: dict[str, list[HeadFeatureReport]],
    *,
    title: str = "T34 weekly feature importance",
    cross_concordance_top_n: int = 5,
) -> str:
    """Render a multi-instrument summary as markdown.

    Sections:
      1. Top-line: instruments × heads scored, missing-model count.
      2. Per-instrument per-head top-N table (one section per
         instrument).
      3. Cross-instrument concordance: which features consistently
         appear in the top-N for each head across all instruments.
    """
    lines: list[str] = []
    lines.append(f"# {title}")
    lines.append("")

    total_heads = sum(len(rs) for rs in reports_by_instrument.values())
    missing = sum(
        1 for rs in reports_by_instrument.values()
        for r in rs if r.missing_model
    )
    lines.append(
        f"**Summary:** {len(reports_by_instrument)} instruments · "
        f"{total_heads} (instrument, head) pairs · "
        f"{missing} missing model files"
    )
    lines.append("")

    # Per-instrument sections
    for instrument, reports in sorted(reports_by_instrument.items()):
        if not reports:
            continue
        lines.append(f"## {instrument}")
        lines.append("")
        for r in reports:
            cohort = r.head_type or "—"
            if r.missing_model:
                lines.append(
                    f"### `{r.head_name}` ({cohort}, {r.objective}) — "
                    f"⚠ model file missing"
                )
                lines.append("")
                continue
            lines.append(
                f"### `{r.head_name}` ({cohort}, {r.objective})"
            )
            lines.append("")
            lines.append(
                f"_{r.n_features} features · "
                f"total gain {r.total_gain:.0f}_"
            )
            lines.append("")
            lines.append("| Rank | Feature | Gain | % of total |")
            lines.append("|---|---|---|---|")
            for fr in r.top_features:
                lines.append(
                    f"| {fr.rank} | `{fr.feature_name}` | "
                    f"{fr.importance:.1f} | {fr.pct_of_total:.2f}% |"
                )
            lines.append("")

    # Cross-instrument concordance (one row per head × consistent feature)
    if len(reports_by_instrument) >= 2:
        lines.append("## Cross-instrument concordance")
        lines.append("")
        lines.append(
            f"_For each head, features ranking in the top-"
            f"{cross_concordance_top_n} across the most instruments._"
        )
        lines.append("")
        lines.append("| Head | Feature | Instruments where in top-N |")
        lines.append("|---|---|---|")
        all_heads: set[str] = set()
        for rs in reports_by_instrument.values():
            for r in rs:
                if not r.missing_model:
                    all_heads.add(r.head_name)
        for head_name in sorted(all_heads):
            concordance = cross_instrument_concordance(
                reports_by_instrument,
                head_name=head_name,
                top_n=cross_concordance_top_n,
            )
            # Surface only features hit by 2+ instruments — single-
            # instrument rankings are already in the per-instrument
            # section above.
            for feat, n in concordance:
                if n < 2:
                    continue
                lines.append(f"| `{head_name}` | `{feat}` | {n} |")

    return "\n".join(lines)


def flatten_to_csv_rows(
    reports_by_instrument: dict[str, list[HeadFeatureReport]],
) -> list[dict]:
    """One row per (instrument, head, ranked feature). Suitable for
    Polars/Pandas write_csv → downstream analysis in a notebook.
    """
    rows: list[dict] = []
    for instrument, reports in reports_by_instrument.items():
        for r in reports:
            if r.missing_model:
                rows.append({
                    "instrument": instrument,
                    "head_name": r.head_name,
                    "head_type": r.head_type or "",
                    "objective": r.objective,
                    "rank": -1,
                    "feature_name": "",
                    "importance": float("nan"),
                    "pct_of_total": float("nan"),
                    "n_features": 0,
                    "total_gain": 0.0,
                    "missing_model": True,
                })
                continue
            for fr in r.top_features:
                rows.append({
                    "instrument": instrument,
                    "head_name": r.head_name,
                    "head_type": r.head_type or "",
                    "objective": r.objective,
                    "rank": fr.rank,
                    "feature_name": fr.feature_name,
                    "importance": fr.importance,
                    "pct_of_total": fr.pct_of_total,
                    "n_features": r.n_features,
                    "total_gain": r.total_gain,
                    "missing_model": False,
                })
    return rows
