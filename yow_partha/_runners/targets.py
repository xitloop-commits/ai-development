"""Single source of truth for the v0.1 target list.

Each target maps to:
  - `noun`     plain-English label rendered on the status table.
  - `kind`     one of: api | tfa | replay | train | backtest | compare | delete | shutdown.
  - `inst`     instrument key (e.g. "nifty50") for instrument-bound kinds; None otherwise.
  - `log_key`  filename suffix in `logs/tfa_<KEY>_<DATE>.log`; only set for kinds that produce a per-instrument log.
  - `actions`  which buttons to surface in the per-target sub-screen.
  - `bat`      filename in `startup/`. Shell-out target. None for kinds the
               bot handles internally (delete sub-buttons, shutdown second-confirm).

The 15-target list matches the desktop launcher's `act_*` actions, minus SEA
(parked) and Tools/Watch/Restart (intentionally out of v0.1 — see spec §1).
"""

from __future__ import annotations

from typing import Optional, TypedDict


class Target(TypedDict, total=False):
    noun: str
    kind: str
    inst: Optional[str]
    log_key: Optional[str]
    actions: list[str]
    bat: Optional[str]
    bat_args: list[str]


INSTRUMENTS: list[str] = ["nifty50", "banknifty", "crudeoil", "naturalgas"]
_INST_NOUN = {
    "nifty50": "NIFTY 50",
    "banknifty": "Bank Nifty",
    "crudeoil": "Crude Oil",
    "naturalgas": "Natural Gas",
}
_INST_LOG_KEY = {
    "nifty50": "NIFTY",  # historical mismatch — see tfa_bot migration doc §10
    "banknifty": "BANKNIFTY",
    "crudeoil": "CRUDEOIL",
    "naturalgas": "NATURALGAS",
}


def _per_inst(prefix: str, kind: str, bat: str, noun_suffix: str) -> dict[str, Target]:
    out: dict[str, Target] = {}
    for inst in INSTRUMENTS:
        out[f"{prefix}-{inst}"] = {
            "noun": f"{_INST_NOUN[inst]} {noun_suffix}",
            "kind": kind,
            "inst": inst,
            "log_key": _INST_LOG_KEY[inst],
            "actions": ["start", "stop", "restart"],
            "bat": bat,
            "bat_args": [inst],
        }
    return out


TARGETS: dict[str, Target] = {
    "api": {
        "noun": "API server",
        "kind": "api",
        "inst": None,
        "log_key": None,
        "actions": ["start", "stop", "restart"],
        "bat": "start-api.bat",
        "bat_args": [],
    },
    **_per_inst("tfa", "tfa", "start-tfa.bat", "recorder"),
    **_per_inst("replay", "replay", "start-replay.bat", "replay"),
    **_per_inst("train", "train", "train-model.bat", "model training"),
    # Backtest + Compare parked for v0.1.1 — both need an instrument AND a
    # date arg, so they need a 2-tap picker (instrument → date). The train
    # date picker pattern fits but the extra wiring is non-trivial.
    # See YowPartha_v0.1_Roster.md Parked section.
    "delete": {
        "noun": "Delete data",
        "kind": "delete",
        "inst": None,
        "log_key": None,
        "actions": [],  # sub-screen has 4 sub-buttons, not start/stop/restart
        "bat": None,
        "bat_args": [],
    },
    "shutdown": {
        "noun": "Shutdown computer",
        "kind": "shutdown",
        "inst": None,
        "log_key": None,
        "actions": [],  # two-tap confirmation flow, no actions in normal sense
        "bat": "stop-all.ps1",  # invoked via powershell, not cmd
        "bat_args": [],
    },
}
