"""
holdout_utils.py — resolves the set of dates reserved for out-of-sample backtest.

Single source of truth: config/holdout_dates.json. Loaded fresh each call so
edits to the config take effect on next launcher refresh without restart.

Policies supported:
  - "last_n_per_instrument" (RECOMMENDED): per instrument, the most recent N
    dates that the instrument has data for (raw or parquet). Reserved set is
    different for each instrument; callers should pass `instrument=` to get
    a per-instrument view, or omit it for the union across all 4.
  - "last_n_complete_dates": the most recent N sessions where all 4
    instruments have parquets. Conservative — requires cross-instrument
    alignment. Same set for every instrument.
  - "explicit": an explicit `dates: [...]` array.

API:
    load_holdout_config(config_path=None) -> dict
    resolve_holdout_dates(features_root, raw_root=None, instrument=None,
                         config=None) -> list[str]
    check_train_holdout_leak(train_dates, features_root, raw_root=None,
                             instrument=None, config=None) -> list[str]
"""

from __future__ import annotations

import json
from pathlib import Path

_INSTRUMENTS = ("nifty50", "banknifty", "crudeoil", "naturalgas")

# Default paths relative to project root. Callers can override.
_DEFAULT_CONFIG = Path("config") / "holdout_dates.json"
_DEFAULT_FEATURES = Path("data") / "features"
_DEFAULT_RAW = Path("data") / "raw"


def load_holdout_config(config_path: Path | str | None = None) -> dict:
    """Read and parse the holdout config. Returns a dict with at minimum a
    `policy` key. Missing file is non-fatal — returns a "no holdout" config.
    """
    p = Path(config_path) if config_path else _DEFAULT_CONFIG
    if not p.exists():
        return {"policy": "none"}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"policy": "none"}


def _scan_complete_feature_dates(features_root: Path) -> list[str]:
    """Dates where parquets exist for ALL 4 instruments, sorted ascending.

    Layout: data/features/<DATE>/<instrument>_features.parquet — date is the
    top-level directory and the parquet files for all instruments live inside.
    """
    if not features_root.exists():
        return []
    complete: list[str] = []
    for entry in features_root.iterdir():
        if not entry.is_dir():
            continue
        name = entry.name
        if not (len(name) == 10 and name[4] == "-" and name[7] == "-"):
            continue
        # A date counts only if all 4 instrument parquets are present.
        if all((entry / f"{inst}_features.parquet").exists() for inst in _INSTRUMENTS):
            complete.append(name)
    return sorted(complete)


def _dates_for_instrument(
    features_root: Path,
    raw_root: Path,
    instrument: str,
) -> list[str]:
    """Sorted ascending list of dates this instrument has data for (raw OR
    parquet). The union is used so newly-recorded days that haven't been
    featurized yet are still candidates for reservation."""
    days: set[str] = set()
    if raw_root.exists():
        for entry in raw_root.iterdir():
            if not entry.is_dir():
                continue
            name = entry.name
            if not (len(name) == 10 and name[4] == "-" and name[7] == "-"):
                continue
            if any(entry.glob(f"{instrument}*.ndjson.gz")):
                days.add(name)
    if features_root.exists():
        for entry in features_root.iterdir():
            if not entry.is_dir():
                continue
            name = entry.name
            if not (len(name) == 10 and name[4] == "-" and name[7] == "-"):
                continue
            if (entry / f"{instrument}_features.parquet").exists():
                days.add(name)
    return sorted(days)


def resolve_holdout_dates(
    features_root: Path | str | None = None,
    raw_root: Path | str | None = None,
    instrument: str | None = None,
    config: dict | None = None,
) -> list[str]:
    """Return the current list of reserved holdout dates, sorted ascending.

    `instrument`: when set, return reservations specific to that instrument
        (only "last_n_per_instrument" policy varies by instrument; the other
        policies return the same set regardless).
    """
    if config is None:
        config = load_holdout_config()
    # Master kill-switch — when "enabled": false in holdout_dates.json the
    # whole gate is bypassed regardless of policy. Set 2026-05-20 per
    # PROJECT_TODO T24 so every date is replay/trainable during accumulation.
    # Flip back to enabled=true (or remove the key) when paper-trade window
    # begins and we need real out-of-sample reservation.
    if config.get("enabled") is False:
        return []
    policy = config.get("policy", "none")
    if policy == "none":
        return []
    if policy == "explicit":
        dates = config.get("dates", [])
        return sorted({d for d in dates if isinstance(d, str)})
    froot = Path(features_root) if features_root else _DEFAULT_FEATURES
    rroot = Path(raw_root) if raw_root else _DEFAULT_RAW
    if policy == "last_n_complete_dates":
        n = int(config.get("n", 0))
        if n <= 0:
            return []
        return _scan_complete_feature_dates(froot)[-n:]
    if policy == "last_n_per_instrument":
        n = int(config.get("n", 0))
        if n <= 0:
            return []
        if instrument is not None:
            return _dates_for_instrument(froot, rroot, instrument)[-n:]
        # No instrument given → union across all 4.
        all_reserved: set[str] = set()
        for inst in _INSTRUMENTS:
            all_reserved.update(_dates_for_instrument(froot, rroot, inst)[-n:])
        return sorted(all_reserved)
    # Unknown policy → fail safe, no holdout
    return []


def check_train_holdout_leak(
    train_dates: list[str] | set[str],
    features_root: Path | str | None = None,
    raw_root: Path | str | None = None,
    instrument: str | None = None,
    config: dict | None = None,
) -> list[str]:
    """Return train dates that overlap with reserved holdout dates. Empty list
    means no leak. Caller decides whether to abort or override.
    """
    holdout = set(resolve_holdout_dates(features_root, raw_root, instrument, config))
    if not holdout:
        return []
    return sorted(set(train_dates) & holdout)
