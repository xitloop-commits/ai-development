"""
remerge_stranded_chunks.py — Salvage replay dates whose event loop finished
but whose chunk merge crashed (e.g. the 2026-08-03 schema-drift crash).

For each (instrument, date) it:
  1. Finds `<inst>_features_part*.parquet` chunks in data/features/<date>/.
  2. Merges them with the schema-union `_merge_chunks_to_final` (no
     re-processing of raw ticks — minutes, not hours).
  3. Runs the feature validator (same PASS/WARN/FAIL as a normal replay).
  4. On PASS/WARN: deletes chunks + progress file, advances the replay
     checkpoint. On FAIL: keeps everything on disk for inspection.

Usage:
    py scripts/remerge_stranded_chunks.py naturalgas 2026-04-17 2026-04-21 2026-04-22
"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "python_modules"))

from tick_feature_agent.replay.replay_runner import _merge_chunks_to_final
from tick_feature_agent.replay.checkpoint import ReplayCheckpoint
from tick_feature_agent.validation.feature_validator import validate


def remerge(instrument: str, date_str: str) -> str:
    out_dir = _ROOT / "data" / "features" / date_str
    parquet_path = out_dir / f"{instrument}_features.parquet"
    progress_path = out_dir / f"{instrument}_features_progress.json"
    tmp_path = Path(str(parquet_path) + ".tmp")

    chunk_files = sorted(out_dir.glob(f"{instrument}_features_part*.parquet"))
    if not chunk_files:
        print(f"  {date_str}: no chunks found — nothing to do")
        return "skip"
    if parquet_path.exists():
        print(f"  {date_str}: canonical parquet already exists — skipping")
        return "skip"

    print(f"  {date_str}: merging {len(chunk_files)} chunks ...")
    tmp_path.unlink(missing_ok=True)  # stale .tmp from the crashed merge
    _merge_chunks_to_final(chunk_files, parquet_path)
    size_mb = parquet_path.stat().st_size / 1_048_576
    print(f"  {date_str}: merged -> {parquet_path.name} ({size_mb:.1f} MB)")

    print(f"  {date_str}: validating ...")
    val_dir = _ROOT / "data" / "validation" / date_str
    result = validate(parquet_path, instrument, date_str, output_dir=val_dir)
    verdict = str(result.get("verdict", "fail")).lower()
    print(f"  {date_str}: verdict = {verdict.upper()}")

    if verdict in ("pass", "warn"):
        for f in chunk_files:
            f.unlink(missing_ok=True)
        progress_path.unlink(missing_ok=True)
        cp = ReplayCheckpoint(_ROOT / "data" / "raw" / "replay_checkpoint.json")
        cp.mark_complete(instrument, date_str)
        print(f"  {date_str}: chunks cleaned up, checkpoint advanced")
    else:
        print(f"  {date_str}: FAIL — chunks kept on disk for inspection")
    return verdict


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    instrument = sys.argv[1]
    dates = sys.argv[2:]
    print(f"Re-merge {instrument}: {', '.join(dates)}")
    tally: dict[str, int] = {}
    for d in dates:
        try:
            v = remerge(instrument, d)
        except Exception as exc:  # keep going — dates are independent
            print(f"  {d}: ERROR — {exc}")
            v = "error"
        tally[v] = tally.get(v, 0) + 1
    print(f"Done: {tally}")
    return 0 if tally.get("error", 0) == 0 and tally.get("fail", 0) == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
