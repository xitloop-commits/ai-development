"""
control_client.py — SEA live cohort-control listener (2026-07-14).

Connects to the server's dedicated ``/ws/sea-control`` websocket and applies
cohort on/off toggles to a shared mutable dict in real time — no restart. The
server sends the current state on connect and again on every UI toggle, so a
flip reaches the gate in <100 ms.

Runs in a daemon thread with its own asyncio loop and reconnects on drop. It
never raises into the engine — a missing library or a dead server just leaves
the cohorts at their startup (config) values.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import threading

try:
    import websockets  # type: ignore
except Exception:  # pragma: no cover — lib is expected to be present
    websockets = None  # type: ignore

_COHORTS = ("scalp", "trend", "ma")


def control_url() -> str:
    base = os.environ.get("BROKER_URL", "http://localhost:3000").strip()
    ws = base.replace("https://", "wss://").replace("http://", "ws://").rstrip("/")
    return f"{ws}/ws/sea-control"


def start_control_listener(live: dict) -> threading.Thread | None:
    """Spawn the control-ws listener. ``live`` is a mutable ``{cohort: bool}``
    dict the engine reads every tick; this thread mutates it on server pushes.
    Bool assignment is atomic under the GIL, so no lock is needed for reads.
    Returns the thread, or None if the websockets lib is unavailable."""
    if websockets is None:
        print("  MA/cohort control: websockets lib missing — live toggles OFF "
              "(cohorts stay at config values)", file=sys.stderr)
        return None
    url = control_url()

    async def _loop() -> None:
        while True:
            try:
                async with websockets.connect(url, ping_interval=20, open_timeout=5) as ws:
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except Exception:
                            continue
                        if msg.get("type") != "sea_control":
                            continue
                        st = msg.get("state") or {}
                        for c in _COHORTS:
                            if c in st:
                                live[c] = bool(st[c])
                        # MA-Signal reversal size (%) — live-tunable from the panel.
                        if "revPct" in st:
                            try:
                                live["rev_pct"] = float(st["revPct"])
                            except (TypeError, ValueError):
                                pass
            except Exception:
                await asyncio.sleep(3.0)  # reconnect backoff

    def _run() -> None:
        try:
            asyncio.run(_loop())
        except Exception:
            pass

    t = threading.Thread(target=_run, name="sea-control-ws", daemon=True)
    t.start()
    return t
