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

_COHORTS = ("scalp", "trend", "ma", "sma5", "candleblue", "cb2")


def control_url() -> str:
    base = os.environ.get("BROKER_URL", "http://localhost:3000").strip()
    ws = base.replace("https://", "wss://").replace("http://", "ws://").rstrip("/")
    return f"{ws}/ws/sea-control"


def start_control_listener(live: dict, instrument: str | None = None) -> threading.Thread | None:
    """Spawn the control-ws listener. ``live`` is a mutable ``{cohort: bool}``
    dict the engine reads every tick; this thread mutates it on server pushes.
    Bool assignment is atomic under the GIL, so no lock is needed for reads.

    When ``instrument`` is given, a ``models`` map on the pushed state selects
    THIS instrument's requested model version and lands on ``live["model"]``.
    The engine picks it up at the top of its row loop and hot-swaps. We only
    record the request here — loading happens on the engine thread so a row is
    never scored against a half-swapped model.

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
                        # SMA5 reversal-confirmation candles — live-tunable.
                        if "sma5Confirm" in st:
                            try:
                                live["sma5_confirm"] = max(1, int(st["sma5Confirm"]))
                            except (TypeError, ValueError):
                                pass
                        # SMA5 line deadband (%) — live-tunable.
                        if "sma5Buffer" in st:
                            try:
                                live["sma5_buffer"] = max(0.0, float(st["sma5Buffer"]))
                            except (TypeError, ValueError):
                                pass
                        # SMA5 entry-watch (candles) — live-tunable.
                        if "sma5EntryWatch" in st:
                            try:
                                live["sma5_entry_watch"] = max(0, int(st["sma5EntryWatch"]))
                            except (TypeError, ValueError):
                                pass
                        # SMA5 premium-confirm entry gate (on/off) — live-tunable.
                        if "sma5EntryGate" in st:
                            live["sma5_entry_gate"] = bool(st["sma5EntryGate"])
                        # SMA5 / MA candle timeframe (seconds) — live-tunable.
                        if "sma5CandleSec" in st:
                            try:
                                live["sma5_candle_sec"] = max(1, int(st["sma5CandleSec"]))
                            except (TypeError, ValueError):
                                pass
                        if "maCandleSec" in st:
                            try:
                                live["ma_candle_sec"] = max(1, int(st["maCandleSec"]))
                            except (TypeError, ValueError):
                                pass
                        # CandleBlue knobs — candle timeframe (s) + stop buffer (%).
                        if "candleblueCandleSec" in st:
                            try:
                                live["candleblue_candle_sec"] = max(1, int(st["candleblueCandleSec"]))
                            except (TypeError, ValueError):
                                pass
                        if "candleblueStopBufferPct" in st:
                            try:
                                live["candleblue_stop_buffer"] = max(0.0, float(st["candleblueStopBufferPct"]))
                            except (TypeError, ValueError):
                                pass
                        # CB2 knobs — candle timeframe (s) + stop buffer (%) + range gate.
                        if "cb2CandleSec" in st:
                            try:
                                live["cb2_candle_sec"] = max(1, int(st["cb2CandleSec"]))
                            except (TypeError, ValueError):
                                pass
                        if "cb2StopBufferPct" in st:
                            try:
                                live["cb2_stop_buffer"] = max(0.0, float(st["cb2StopBufferPct"]))
                            except (TypeError, ValueError):
                                pass
                        if "cb2MinRangePos" in st:
                            try:
                                live["cb2_min_range_pos"] = max(0.0, min(1.0, float(st["cb2MinRangePos"])))
                            except (TypeError, ValueError):
                                pass
                        # T163 premium-ribbon knobs (Settings ▸ Trend angle) —
                        # lookback resets + re-warms the legs; pctile applies
                        # at the next candle close.
                        if "ribbonLookback" in st:
                            try:
                                live["ribbon_lookback"] = max(1, min(10, int(st["ribbonLookback"])))
                            except (TypeError, ValueError):
                                pass
                        if "ribbonGrayPctile" in st:
                            try:
                                live["ribbon_gray_pctile"] = max(10.0, min(90.0, float(st["ribbonGrayPctile"])))
                            except (TypeError, ValueError):
                                pass
                        # Requested model version for THIS instrument. Recorded
                        # only — the engine thread does the actual load.
                        if instrument and isinstance(st.get("models"), dict):
                            req = st["models"].get(instrument)
                            if isinstance(req, str) and req.strip():
                                live["model"] = req.strip()
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
