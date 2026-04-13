"""
replay/replay_runner.py — CLI entry for historical replay of TFA feature pipeline.

Phase 14.4 (spec §16.5).

Usage:
    python -m tick_feature_agent.replay.replay_runner \\
        --instrument-profile config/instrument_profiles/nifty50_profile.json \\
        --instrument nifty50 \\
        --date-from 2026-04-01 \\
        --date-to   2026-04-14

For each date in [date_from, date_to]:
  1. Check replay checkpoint — skip if already completed.
  2. Read metadata.json to get date-specific instrument metadata.
  3. Build a date-specific InstrumentProfile (override underlying_symbol / security_id).
  4. Merge streams (stream_merger) → drive ReplayAdapter → write Parquet.
  5. Run feature validator on the output Parquet.
  6. Mark checkpoint on success.
"""

from __future__ import annotations

import argparse
import sys
from datetime import date as _date, timedelta
from pathlib import Path

# ── Path bootstrap ────────────────────────────────────────────────────────────
_HERE          = Path(__file__).resolve().parent
_PYTHON_MODULES = _HERE.parent.parent
if str(_PYTHON_MODULES) not in sys.path:
    sys.path.insert(0, str(_PYTHON_MODULES))

from tick_feature_agent.instrument_profile import load_profile, ProfileValidationError
from tick_feature_agent.recorder.metadata_writer import read_metadata
from tick_feature_agent.replay.checkpoint import ReplayCheckpoint
from tick_feature_agent.replay.stream_merger import merge_streams
from tick_feature_agent.replay.replay_adapter import ReplayAdapter
from tick_feature_agent.validation.feature_validator import validate


def _iter_dates(date_from: str, date_to: str):
    """Yield ISO date strings in [date_from, date_to] inclusive."""
    d = _date.fromisoformat(date_from)
    end = _date.fromisoformat(date_to)
    while d <= end:
        yield d.isoformat()
        d += timedelta(days=1)


def run_one_date(
    base_profile,
    instrument: str,
    date_str: str,
    raw_root: Path,
    features_root: Path,
    validation_root: Path,
    logger=None,
) -> str:
    """
    Replay one date for one instrument.

    Returns:
        "skip"    — raw data folder missing; not an error
        "fail"    — processing error
        "warn"    — completed but validator returned WARN
        "pass"    — completed successfully
    """
    date_folder = raw_root / date_str

    # ── Read metadata ─────────────────────────────────────────────────────────
    meta = read_metadata(date_folder)
    if meta is None:
        if logger:
            logger.info("REPLAY_NO_METADATA",
                        msg=f"No metadata for {date_str} — skipping",
                        instrument=instrument, date=date_str)
        return "skip"

    instrument_meta = meta.get("instruments", {}).get(instrument)
    if instrument_meta is None:
        if logger:
            logger.info("REPLAY_INSTRUMENT_NOT_IN_METADATA",
                        msg=f"Instrument {instrument!r} not in metadata for {date_str}",
                        instrument=instrument, date=date_str)
        return "skip"

    # ── Build date-specific profile ───────────────────────────────────────────
    profile = base_profile.__class__.for_replay_date(base_profile, instrument_meta)

    # ── Run replay adapter ────────────────────────────────────────────────────
    adapter = ReplayAdapter(profile, date_str, logger=logger)

    event_count = 0
    try:
        for event in merge_streams(date_folder, instrument, logger=logger):
            adapter.process_event(event)
            event_count += 1
    except Exception as exc:
        if logger:
            logger.error("REPLAY_STREAM_ERROR",
                         msg=f"Stream error on {date_str}: {exc}",
                         instrument=instrument, date=date_str)
        return "fail"

    adapter.flush_all()

    if adapter.underlying_tick_count == 0:
        if logger:
            logger.info("REPLAY_NO_TICKS",
                        msg=f"No underlying ticks for {date_str} — skipping",
                        instrument=instrument, date=date_str)
        return "skip"

    # ── Write Parquet ─────────────────────────────────────────────────────────
    out_dir  = features_root / date_str
    out_dir.mkdir(parents=True, exist_ok=True)
    parquet_path = out_dir / f"{instrument}_features.parquet"

    try:
        adapter.emitter.write_parquet(parquet_path)
    except Exception as exc:
        if logger:
            logger.error("REPLAY_PARQUET_WRITE_ERROR",
                         msg=f"Parquet write failed on {date_str}: {exc}",
                         instrument=instrument, date=date_str)
        return "fail"

    # ── Validate ──────────────────────────────────────────────────────────────
    val_dir = validation_root / date_str
    try:
        result = validate(parquet_path, instrument, date_str, output_dir=val_dir)
    except Exception as exc:
        if logger:
            logger.error("REPLAY_VALIDATION_ERROR",
                         msg=f"Validation error on {date_str}: {exc}",
                         instrument=instrument, date=date_str)
        result = {"verdict": "fail"}

    verdict = result.get("verdict", "fail").lower()

    if logger:
        logger.info("REPLAY_DATE_COMPLETE",
                    msg=f"{instrument} {date_str}: {verdict.upper()} "
                        f"({adapter.underlying_tick_count} ticks, "
                        f"{event_count} events)",
                    instrument=instrument,
                    date=date_str,
                    verdict=verdict,
                    underlying_ticks=adapter.underlying_tick_count,
                    event_count=event_count)

    return verdict


def replay(
    profile_path: str | Path,
    instrument: str,
    date_from: str,
    date_to: str,
    raw_root: str | Path = "data/raw",
    features_root: str | Path = "data/features",
    validation_root: str | Path = "data/validation",
    checkpoint_path: str | Path | None = None,
    logger=None,
) -> dict:
    """
    Replay all dates in [date_from, date_to] for the given instrument.

    Args:
        profile_path:     Path to instrument profile JSON.
        instrument:       Instrument key (e.g. "nifty50").
        date_from:        Start date (inclusive).
        date_to:          End date (inclusive).
        raw_root:         Root directory for recorded raw data.
        features_root:    Root directory for output Parquet files.
        validation_root:  Root directory for validation JSON files.
        checkpoint_path:  Path for replay checkpoint JSON. Default:
                          ``{raw_root}/replay_checkpoint.json``.
        logger:           Optional TFA structured logger.

    Returns:
        Summary dict with counts of each verdict type.
    """
    raw_root        = Path(raw_root)
    features_root   = Path(features_root)
    validation_root = Path(validation_root)

    if checkpoint_path is None:
        checkpoint_path = raw_root / "replay_checkpoint.json"
    checkpoint = ReplayCheckpoint(checkpoint_path)

    try:
        base_profile = load_profile(Path(profile_path))
    except (FileNotFoundError, ProfileValidationError) as exc:
        if logger:
            logger.error("REPLAY_PROFILE_ERROR",
                         msg=f"Profile load failed: {exc}",
                         profile_path=str(profile_path))
        return {"error": str(exc)}

    # Respect checkpoint: skip dates already completed
    resume_date = checkpoint.get_resume_date(instrument, date_from)

    summary = {"pass": 0, "warn": 0, "fail": 0, "skip": 0}

    for date_str in _iter_dates(resume_date, date_to):
        verdict = run_one_date(
            base_profile=base_profile,
            instrument=instrument,
            date_str=date_str,
            raw_root=raw_root,
            features_root=features_root,
            validation_root=validation_root,
            logger=logger,
        )
        summary[verdict] = summary.get(verdict, 0) + 1

        if verdict in ("pass", "warn"):
            checkpoint.mark_complete(instrument, date_str)
        elif verdict == "fail":
            # Stop on failure — don't mark checkpoint so next run retries
            if logger:
                logger.error("REPLAY_STOPPED_ON_FAIL",
                             msg=f"Replay stopped on {date_str} due to FAIL verdict",
                             instrument=instrument, date=date_str)
            break

    return summary


# ── CLI ───────────────────────────────────────────────────────────────────────

def _cli():
    parser = argparse.ArgumentParser(
        description="TFA Replay Runner — reprocess historical tick data into features"
    )
    parser.add_argument(
        "--instrument-profile", required=True,
        help="Path to instrument profile JSON",
    )
    parser.add_argument(
        "--instrument", required=True,
        help="Instrument key, e.g. nifty50",
    )
    parser.add_argument(
        "--date-from", required=True,
        help="Start date YYYY-MM-DD (inclusive)",
    )
    parser.add_argument(
        "--date-to", required=True,
        help="End date YYYY-MM-DD (inclusive)",
    )
    parser.add_argument(
        "--raw-root", default="data/raw",
        help="Root directory for raw recorded data (default: data/raw)",
    )
    parser.add_argument(
        "--features-root", default="data/features",
        help="Root directory for output Parquet files (default: data/features)",
    )
    parser.add_argument(
        "--validation-root", default="data/validation",
        help="Root directory for validation JSON files (default: data/validation)",
    )
    parser.add_argument(
        "--checkpoint", default=None,
        help="Path to replay checkpoint JSON (default: {raw-root}/replay_checkpoint.json)",
    )
    parser.add_argument(
        "--log-dir", default="logs",
        help="Directory for log files (default: logs/)",
    )
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARN", "ERROR"],
        default="INFO",
    )
    args = parser.parse_args()

    from tick_feature_agent.log.tfa_logger import setup_logging, get_logger
    _level_map = {"DEBUG": 10, "INFO": 20, "WARN": 30, "ERROR": 40}
    setup_logging(
        args.instrument,
        log_dir=args.log_dir,
        level=_level_map.get(args.log_level, 20),
    )
    log = get_logger("tfa.replay", instrument=args.instrument)

    summary = replay(
        profile_path=args.instrument_profile,
        instrument=args.instrument,
        date_from=args.date_from,
        date_to=args.date_to,
        raw_root=args.raw_root,
        features_root=args.features_root,
        validation_root=args.validation_root,
        checkpoint_path=args.checkpoint,
        logger=log,
    )

    # Print summary
    print(f"\nReplay complete for {args.instrument}  "
          f"({args.date_from} → {args.date_to})")
    print(f"  PASS : {summary.get('pass', 0)}")
    print(f"  WARN : {summary.get('warn', 0)}")
    print(f"  FAIL : {summary.get('fail', 0)}")
    print(f"  SKIP : {summary.get('skip', 0)}")
    print()

    exit_code = 0 if summary.get("fail", 0) == 0 else 1
    sys.exit(exit_code)


if __name__ == "__main__":
    _cli()
