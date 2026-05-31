"""
scripts/bench_inference_latency.py — T35 one-shot inference latency
harness for the 84-head × 4-instrument model fleet.

What this measures:

  For each instrument, load every head listed in LATEST_HEADS.json
  and time N evals through ALL heads using a synthetic feature batch.
  Reports per-head and per-instrument total latency (mean / p50 / p95
  / p99) so operators can verify a live eval fits within the inbound
  tick cadence.

What this does NOT measure:

  * Feature-engineering cost (TFA's `compute_pipeline_features`) —
    that's measured separately by `scripts/profile_replay_date.py`.
  * Prediction-logger / disk I/O — covered by T41's prediction_logger
    benchmark.
  * Network jitter on the broker WS feed.

We isolate model inference because that's the variable T3 Phase 6
flagged as never having been benchmarked.

Usage::

    py scripts/bench_inference_latency.py
        [--instruments nifty50,banknifty]
        [--models-root models]
        [--n-evals 1000]
        [--warmup 100]
        [--output-json data/reports/inference_latency_<date>.json]
        [--head-filter direction_30s,direction_60s]
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

import lightgbm as lgb
import numpy as np

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent
_PY_MODULES = _REPO / "python_modules"
if str(_PY_MODULES) not in sys.path:
    sys.path.insert(0, str(_PY_MODULES))

from _shared.feature_importance import (  # noqa: E402
    load_latest_heads_manifest,
    resolve_latest_model_dir,
)

DEFAULT_N_EVALS = 1000
DEFAULT_WARMUP = 100
DEFAULT_FEATURE_SEED = 0


@dataclass
class HeadLatency:
    head_name: str
    head_type: str | None
    objective: str
    n_features: int
    n_evals: int
    mean_ms: float
    p50_ms: float
    p95_ms: float
    p99_ms: float
    max_ms: float


@dataclass
class InstrumentLatency:
    instrument: str
    n_heads: int
    n_evals: int
    heads: list[HeadLatency]
    total_per_eval_mean_ms: float    # sum of per-head means
    total_per_eval_p50_ms: float     # p50 of the SUM across the N evals
    total_per_eval_p95_ms: float
    total_per_eval_p99_ms: float
    total_per_eval_max_ms: float


def _percentile(values: list[float], q: float) -> float:
    """Linear-interp percentile (matches numpy.percentile default).
    Q is in 0..100.
    """
    if not values:
        return float("nan")
    arr = np.asarray(values)
    return float(np.percentile(arr, q))


def _bench_one_head(
    booster: lgb.Booster,
    X: np.ndarray,
    *,
    n_evals: int,
    warmup: int,
) -> list[float]:
    """Return per-eval latency in milliseconds. Warmup evals are NOT
    counted — the first few LightGBM predict calls trigger JIT-style
    per-tree caching, which would skew the stats.
    """
    for _ in range(warmup):
        booster.predict(X)
    timings_ms: list[float] = []
    for _ in range(n_evals):
        t0 = time.perf_counter()
        booster.predict(X)
        timings_ms.append((time.perf_counter() - t0) * 1000.0)
    return timings_ms


def _summarise_head(
    head_name: str,
    head_meta: dict,
    n_features: int,
    timings_ms: list[float],
) -> HeadLatency:
    return HeadLatency(
        head_name=head_name,
        head_type=head_meta.get("head_type"),
        objective=head_meta.get("objective", ""),
        n_features=n_features,
        n_evals=len(timings_ms),
        mean_ms=float(statistics.fmean(timings_ms)),
        p50_ms=_percentile(timings_ms, 50),
        p95_ms=_percentile(timings_ms, 95),
        p99_ms=_percentile(timings_ms, 99),
        max_ms=float(max(timings_ms)),
    )


def bench_instrument(
    *,
    instrument: str,
    instrument_dir: Path,
    n_evals: int = DEFAULT_N_EVALS,
    warmup: int = DEFAULT_WARMUP,
    head_filter: set[str] | None = None,
    feature_seed: int = DEFAULT_FEATURE_SEED,
) -> InstrumentLatency:
    """Bench every head in ``<instrument>/LATEST_HEADS.json``.

    Heads sharing the same feature count share the same synthetic
    feature matrix to keep memory bounded.

    `feature_seed` lets the test pin the RNG so synthetic inputs are
    deterministic — production runs use ``DEFAULT_FEATURE_SEED = 0``.
    """
    manifest = load_latest_heads_manifest(instrument_dir)
    heads = manifest.get("heads", {})
    model_dir = resolve_latest_model_dir(instrument_dir)
    rng = np.random.default_rng(seed=feature_seed)

    per_head: list[HeadLatency] = []
    feature_cache: dict[int, np.ndarray] = {}
    # Per-eval totals (sum across all heads for the same eval index)
    # so we can quote a realistic "all-heads-for-one-tick" latency.
    per_eval_totals_ms: list[float] = [0.0] * n_evals

    for head_name, head_meta in sorted(heads.items()):
        if head_filter is not None and head_name not in head_filter:
            continue
        lgbm_path_str = head_meta.get("lgbm_path")
        if not lgbm_path_str:
            continue
        lgbm_path = model_dir / lgbm_path_str
        if not lgbm_path.exists():
            continue
        booster = lgb.Booster(model_file=str(lgbm_path))
        n_features = booster.num_feature()
        X = feature_cache.get(n_features)
        if X is None:
            X = rng.normal(size=(1, n_features)).astype(np.float32)
            feature_cache[n_features] = X
        timings_ms = _bench_one_head(
            booster, X, n_evals=n_evals, warmup=warmup,
        )
        per_head.append(_summarise_head(
            head_name, head_meta, n_features, timings_ms,
        ))
        for i, t in enumerate(timings_ms):
            per_eval_totals_ms[i] += t

    total_mean = sum(h.mean_ms for h in per_head)
    return InstrumentLatency(
        instrument=instrument,
        n_heads=len(per_head),
        n_evals=n_evals,
        heads=per_head,
        total_per_eval_mean_ms=total_mean,
        total_per_eval_p50_ms=_percentile(per_eval_totals_ms, 50),
        total_per_eval_p95_ms=_percentile(per_eval_totals_ms, 95),
        total_per_eval_p99_ms=_percentile(per_eval_totals_ms, 99),
        total_per_eval_max_ms=float(max(per_eval_totals_ms))
                              if per_eval_totals_ms else float("nan"),
    )


def render_markdown(results: list[InstrumentLatency]) -> str:
    lines: list[str] = []
    lines.append("# T35 Inference latency benchmark")
    lines.append("")
    if not results:
        lines.append("_No instruments benchmarked._")
        return "\n".join(lines)

    lines.append("## Per-instrument total eval latency (all heads summed)")
    lines.append("")
    lines.append(
        "| Instrument | Heads | N evals | Mean (ms) | p50 (ms) | "
        "p95 (ms) | p99 (ms) | Max (ms) |"
    )
    lines.append("|---|---|---|---|---|---|---|---|")
    for r in results:
        lines.append(
            f"| {r.instrument} | {r.n_heads} | {r.n_evals} | "
            f"{r.total_per_eval_mean_ms:.2f} | "
            f"{r.total_per_eval_p50_ms:.2f} | "
            f"{r.total_per_eval_p95_ms:.2f} | "
            f"{r.total_per_eval_p99_ms:.2f} | "
            f"{r.total_per_eval_max_ms:.2f} |"
        )

    # Per-head detail — top 10 slowest per instrument
    for r in results:
        lines.append("")
        lines.append(f"## {r.instrument} — top-10 slowest heads (by mean)")
        lines.append("")
        lines.append(
            "| Head | Cohort | Objective | Features | "
            "Mean (ms) | p95 (ms) | p99 (ms) |"
        )
        lines.append("|---|---|---|---|---|---|---|")
        for h in sorted(r.heads, key=lambda x: -x.mean_ms)[:10]:
            cohort = h.head_type or "-"
            lines.append(
                f"| `{h.head_name}` | {cohort} | {h.objective} | "
                f"{h.n_features} | {h.mean_ms:.3f} | "
                f"{h.p95_ms:.3f} | {h.p99_ms:.3f} |"
            )
    return "\n".join(lines)


def discover_instruments(models_root: Path) -> list[str]:
    if not models_root.is_dir():
        return []
    return sorted(
        c.name for c in models_root.iterdir()
        if c.is_dir() and (c / "LATEST_HEADS.json").is_file()
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--instruments", type=str, default=None,
        help="Comma-separated instruments. Default: auto-discover.",
    )
    parser.add_argument(
        "--models-root", type=Path, default=_REPO / "models",
    )
    parser.add_argument(
        "--n-evals", type=int, default=DEFAULT_N_EVALS,
    )
    parser.add_argument(
        "--warmup", type=int, default=DEFAULT_WARMUP,
        help="Warmup evals not counted in latency stats.",
    )
    parser.add_argument(
        "--head-filter", type=str, default=None,
        help="Comma-separated head names; default = all.",
    )
    parser.add_argument(
        "--output-json", type=Path, default=None,
        help="If set, dump the structured results as JSON for "
             "downstream charting / regression-tracking.",
    )
    parser.add_argument(
        "--output-md", type=Path, default=None,
        help="If set, also write the markdown report to this path. "
             "Default: print to stdout only.",
    )
    parser.add_argument(
        "--feature-seed", type=int, default=DEFAULT_FEATURE_SEED,
        help="Seed for the synthetic feature RNG (for test determinism).",
    )
    args = parser.parse_args(argv)

    if args.instruments:
        instruments = [s.strip() for s in args.instruments.split(",") if s.strip()]
    else:
        instruments = discover_instruments(args.models_root)
        if not instruments:
            print(
                f"ERROR no instruments found under {args.models_root}",
                file=sys.stderr,
            )
            return 2

    head_filter: set[str] | None = None
    if args.head_filter:
        head_filter = {s.strip() for s in args.head_filter.split(",") if s.strip()}

    print(
        f"[bench_inference] N={args.n_evals} warmup={args.warmup} "
        f"instruments={instruments} head_filter={head_filter or 'ALL'}",
        file=sys.stderr,
    )

    results: list[InstrumentLatency] = []
    for instrument in instruments:
        inst_dir = args.models_root / instrument
        if not (inst_dir / "LATEST_HEADS.json").is_file():
            print(
                f"WARN  no LATEST_HEADS.json for {instrument}, skipping",
                file=sys.stderr,
            )
            continue
        t0 = time.perf_counter()
        result = bench_instrument(
            instrument=instrument,
            instrument_dir=inst_dir,
            n_evals=args.n_evals,
            warmup=args.warmup,
            head_filter=head_filter,
            feature_seed=args.feature_seed,
        )
        elapsed = time.perf_counter() - t0
        print(
            f"[bench_inference] {instrument}: {result.n_heads} heads, "
            f"total mean {result.total_per_eval_mean_ms:.2f}ms/eval, "
            f"p95 {result.total_per_eval_p95_ms:.2f}ms — "
            f"({elapsed:.1f}s wallclock)",
            file=sys.stderr,
        )
        results.append(result)

    md = render_markdown(results)
    print(md)
    if args.output_md is not None:
        args.output_md.parent.mkdir(parents=True, exist_ok=True)
        args.output_md.write_text(md, encoding="utf-8")
    if args.output_json is not None:
        args.output_json.parent.mkdir(parents=True, exist_ok=True)
        args.output_json.write_text(
            json.dumps(
                {
                    "generated_at": datetime.now().isoformat(),
                    "n_evals": args.n_evals,
                    "warmup": args.warmup,
                    "results": [asdict(r) for r in results],
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
