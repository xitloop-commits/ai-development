"""
recorder/metadata_writer.py — Write and update data/raw/{date}/metadata.json.

Phase 13.3 (spec §15.6).

Metadata is written once at session open and overwritten on expiry rollover.
Format:

    {
      "date": "2026-04-14",
      "instruments": {
        "nifty50":  { "underlying_symbol": "...", "underlying_security_id": "...", "expiry": "..." },
        ...
      }
    }
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def write_metadata(
    date_folder: str | Path,
    date: str,
    instruments: dict[str, dict[str, str]],
) -> Path:
    """
    Write (or overwrite) metadata.json in ``date_folder``.

    Args:
        date_folder:  Path to the IST date folder (e.g. ``data/raw/2026-04-14``).
        date:         ISO date string ``YYYY-MM-DD``.
        instruments:  Mapping of instrument key → dict with at least
                      ``underlying_symbol``, ``underlying_security_id``, ``expiry``.

    Returns:
        Path of the written file.
    """
    folder = Path(date_folder)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "metadata.json"

    # Merge with existing metadata so multiple TFA processes don't overwrite each other
    existing: dict[str, Any] = {}
    try:
        existing = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    merged_instruments = dict(existing.get("instruments", {}))
    for k, v in instruments.items():
        merged_instruments[k] = {
            "underlying_symbol": v["underlying_symbol"],
            "underlying_security_id": v["underlying_security_id"],
            "expiry": v["expiry"],
        }

    metadata: dict[str, Any] = {
        "date": date,
        "instruments": merged_instruments,
    }
    path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return path


def read_metadata(date_folder: str | Path) -> dict[str, Any] | None:
    """
    Read metadata.json from ``date_folder``.  Returns None if missing or invalid.
    """
    path = Path(date_folder) / "metadata.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None
