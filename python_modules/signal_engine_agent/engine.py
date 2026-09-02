"""
engine.py — SEA MVP inference loop.

Tails data/features/{instrument}_live.ndjson (the per-instrument live feature
stream written by TFA), runs inference on each new row, and writes
GO_CALL / GO_PUT signals to logs/signals/{instrument}/ as one NDJSON
line per signal.

Phase E5 — canonical filter is the **3-condition gate** in
`thresholds.decide_action`:

    prob ≥ 0.65  AND  RR ≥ 1.5  AND  upside_percentile ≥ 60

Per-instrument thresholds live in `config/sea_thresholds/<inst>.json`
(falling back to `default.json`); see `thresholds.load_thresholds`.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import queue
import socket
import sys
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Path bootstrap
_HERE = Path(__file__).resolve().parent
_PYTHON_MODULES = _HERE.parent
if str(_PYTHON_MODULES) not in sys.path:
    sys.path.insert(0, str(_PYTHON_MODULES))

import numpy as np

from _shared.feature_stream import FEATURE_SOCKET_HOST, feature_socket_port
from model_training_agent.preprocessor import LiveTickPreprocessor
from signal_engine_agent.cohort import build_head_type_map
from signal_engine_agent.model_loader import load_models
from signal_engine_agent.prediction_logger import PredictionLogger
from signal_engine_agent.signal_dashboard import SignalDashboard
from signal_engine_agent.signal_logger import SignalLogger
from signal_engine_agent.sustain import SustainFilter
from signal_engine_agent.thresholds import (
    SignalAction,
    StructureContext,
    Thresholds,
    TrendThresholds,
    V2Thresholds,
    Wave2Thresholds,
    apply_buildup_filter,
    apply_trend_alignment,
    decide_action,
    decide_action_trend,
    decide_action_v2,
    decide_action_wave2,
    load_thresholds_full,
    load_thresholds_legstart,
    load_thresholds_ma_signal,
    load_thresholds_sma5_signal,
    load_thresholds_candleblue,
    load_thresholds_candleblue2,
    load_thresholds_trend,
)
from signal_engine_agent.leg_start import LegStartDetector
from signal_engine_agent.ma_signal import MASignalDetector
from signal_engine_agent.sma5_signal import Sma5SignalDetector
from signal_engine_agent.candleblue_signal import CandleBlueDetector
from signal_engine_agent.candleblue2_signal import CandleBlue2Detector
from signal_engine_agent.premium_ribbon import LockedPremiumFeed, PremiumRibbonDetector
from signal_engine_agent.control_client import start_control_listener


def _build_structure_context(row: dict) -> StructureContext | None:
    """Resolve nearest S/R structure from the live feature row for
    structure-aware TP/SL. Uses the validated pivot levels (spot-denominator:
    level = spot·(1 − pct/100)) plus the absolute OI-wall strikes, bucketed
    into resistance (> spot) and support (< spot). Returns None if spot is
    unusable; deltas may be NaN (the helper degrades gracefully)."""
    try:
        spot = float(row.get("underlying_ltp"))
    except (TypeError, ValueError):
        return None
    if not math.isfinite(spot) or spot <= 0:
        return None

    def _f(key: str) -> float:
        try:
            return float(row.get(key))
        except (TypeError, ValueError):
            return float("nan")

    levels: list[float] = []
    for key in (
        "pivot_swing_dist_high_pct", "pivot_swing_dist_low_pct",
        "pivot_trend_dist_high_pct", "pivot_trend_dist_low_pct",
    ):
        pct = _f(key)
        if math.isfinite(pct):
            levels.append(spot * (1.0 - pct / 100.0))
    for key in ("max_call_oi_strike", "max_put_oi_strike"):
        v = _f(key)
        if math.isfinite(v) and v > 0:
            levels.append(v)

    resistances = [lv for lv in levels if lv > spot]
    supports = [lv for lv in levels if lv < spot]
    return StructureContext(
        spot=spot,
        ce_delta=_f("atm_ce_delta"),
        pe_delta=_f("atm_pe_delta"),
        nearest_resistance=min(resistances) if resistances else None,
        nearest_support=max(supports) if supports else None,
    )

_IST = timezone(timedelta(hours=5, minutes=30))


class _PremiumSma5:
    """Rolling 5-SMA of an ATM option premium's Heikin-Ashi close, built from ticks
    (same HA math as the SMA5 detector). Fed continuously so it stays warm; used by
    the SMA5 entry gate to check the premium confirms (is ABOVE its own SMA5).
    Pure state, never raises."""

    def __init__(self, period: int = 5, candle_sec: int = 60) -> None:
        self._closes: deque[float] = deque(maxlen=max(1, period))
        self._period = max(1, period)
        self._minute: int | None = None
        self._o = self._h = self._l = self._c = 0.0
        self._ha_open_prev: float | None = None
        self._ha_close_prev: float | None = None
        self._sma: float | None = None  # last 5-SMA of HA closes (None until warm)
        self.candle_sec = max(1, int(candle_sec))

    def set_candle_sec(self, sec: int) -> None:
        """Match the SMA5 detector's timeframe live. Resets the aggregation (re-warms)."""
        sec = max(1, int(sec))
        if sec == self.candle_sec:
            return
        self.candle_sec = sec
        self._minute = None
        self._o = self._h = self._l = self._c = 0.0
        self._ha_open_prev = None
        self._ha_close_prev = None
        self._sma = None
        self._closes.clear()

    def on_tick(self, ts: float, price: float) -> None:
        if not (math.isfinite(ts) and math.isfinite(price)):
            return
        minute = int(ts // self.candle_sec)
        if self._minute is None:
            self._minute = minute
            self._o = self._h = self._l = self._c = price
            return
        if minute == self._minute:
            self._c = price
            if price > self._h:
                self._h = price
            if price < self._l:
                self._l = price
            return
        # candle closed → HA close, push, recompute the SMA
        ha_close = (self._o + self._h + self._l + self._c) / 4.0
        ha_open = (
            (self._o + self._c) / 2.0
            if self._ha_open_prev is None
            else (self._ha_open_prev + self._ha_close_prev) / 2.0
        )
        self._ha_open_prev, self._ha_close_prev = ha_open, ha_close
        self._closes.append(ha_close)
        if len(self._closes) >= self._period:
            self._sma = sum(self._closes) / len(self._closes)
        self._minute = minute
        self._o = self._h = self._l = self._c = price

    def confirms(self, price: float) -> bool:
        """True if the live premium is above its SMA5. Warmup (SMA not ready yet)
        → True, so the gate never blocks before it can actually judge."""
        if self._sma is None or not math.isfinite(price):
            return True
        return price > self._sma


def _append_entrywatch_log(instrument: str, note: str) -> None:
    """Persist one SMA5 entry-watch transition to a dated, per-instrument file so
    the deferred-entry trail survives after the console scrolls. Best-effort and
    dashboard-safe (plain text, no ANSI) — never raises into the row loop. cwd is
    the repo root (set by start-sea.bat), so ``logs/`` resolves there."""
    try:
        now = datetime.now(_IST)
        os.makedirs("logs", exist_ok=True)
        path = os.path.join("logs", f"sea_entrywatch_{instrument}_{now.date().isoformat()}.log")
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(f"{now.isoformat(timespec='seconds')}  {note}\n")
    except Exception:
        pass

# ─── AI auto-trade wire (optional, off by default) ───────────────
# SEA_AUTO_TRADE is the master ENABLE gate — set it to any non-empty value to
# turn auto-trade on; leave it unset and no POST happens. When enabled, every
# wave-2 signal the engine emits is POSTed to the Node trade pipeline
# (/api/discipline/validateTrade → DA → RCA → TEA), which places the trade.
# The BOOK (paper vs ai-live) is chosen SERVER-SIDE from the SEA menu's
# `aiTradesMode` setting (T87) — PAPER = the shared paper book, LIVE = the real
# ai-live Dhan account — so the operator flips it live from the UI, not via env.
# The server sizes it (lots × scrip-master lot size), sources capital/exposure,
# and enforces one open position per instrument so the 30s re-emits don't stack.
_EXCHANGE_BY_INSTRUMENT = {
    "NIFTY50": "NSE",
    "BANKNIFTY": "NSE",
    "CRUDEOIL": "MCX",
    "NATURALGAS": "MCX",
}


def _finite(x: object) -> float | None:
    """Coerce to a finite float, else None. NaN/Inf are NOT valid JSON, so they
    must never reach the payload (express's body parser rejects them)."""
    try:
        f = float(x)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _fmt(x: object, d: int = 2) -> str:
    """Format a finite number to d decimals for the human-readable reason; '-' if absent."""
    v = _finite(x)
    return f"{v:.{d}f}" if v is not None else "-"


def _derive_ts_ns(row: dict) -> int:
    """Epoch-nanosecond timestamp for a live feature row, used to key the
    prediction log so it joins to the recorded tick stream (outcome
    backfiller) and to replay labels.

    Priority:
      1. explicit ``recv_ts_ns`` int, if TFA ever emits one;
      2. the row's ``timestamp`` — TFA writes this as the tick's ``recv_ts``
         in epoch SECONDS (float), so scale to ns; an ISO string is also
         accepted;
      3. wall-clock ``time.time_ns()`` ONLY when the row carries no usable
         timestamp.

    Using the tick's own time (not the processing wall-clock) is essential:
    under any tail/backlog lag the processing clock drifts from the tick
    clock, which scrambles every prediction↔outcome join — the T68 "0.49"
    phantom. See docs/PROJECT_TODO.md T68 correction (2026-07-01).
    """
    ts = row.get("recv_ts_ns")
    if isinstance(ts, int) and not isinstance(ts, bool):
        return ts
    ts = row.get("timestamp")
    if isinstance(ts, bool):
        return time.time_ns()
    if isinstance(ts, (int, float)):
        try:
            return int(float(ts) * 1e9)
        except (ValueError, OverflowError):
            return time.time_ns()
    if isinstance(ts, str):
        try:
            return int(datetime.fromisoformat(ts).timestamp() * 1e9)
        except (ValueError, OSError):
            return time.time_ns()
    return time.time_ns()


def _send_signal_to_tray(signal: dict) -> None:
    """Push the emitted signal to the server for the live UI tray (Mongo +
    /ws/ticks). Fire-and-forget — never let a delivery hiccup stall inference."""
    try:
        from signal_engine_agent.risk_control_client import send_signal

        send_signal(signal, timeout=3.0)
    except Exception as exc:  # pragma: no cover - convenience path only
        print(f"  [signal-tray] push skipped: {exc}", file=sys.stderr)


def _maybe_submit_ai_trade(signal: dict) -> "str | None":
    # Master enable gate — auto-trade is OFF unless SEA_AUTO_TRADE is set (any
    # non-empty value). The actual book (paper vs ai-live) is decided SERVER-SIDE
    # from the SEA menu's `aiTradesMode` setting (T87); we post a valid default
    # channel and the validateTrade route overrides it for origin="AI".
    if not os.environ.get("SEA_AUTO_TRADE", "").strip():
        return
    try:
        action = signal.get("action") or ""
        side = "CE" if "CE" in action else "PE"
        sec_id = (
            signal.get("atm_ce_security_id") if side == "CE"
            else signal.get("atm_pe_security_id")
        )
        inst = str(signal.get("instrument", "")).upper()
        entry = _finite(signal.get("entry"))
        strike = _finite(signal.get("atm_strike"))
        if not sec_id or entry is None or entry <= 0 or strike is None:
            return  # can't price the leg or route it — skip silently
        from signal_engine_agent.risk_control_client import submit_new_trade

        payload = {
            "executionId": f"AI-{inst}-{int(time.time() * 1000)}",
            "channel": "paper",  # server overrides for origin="AI" per aiTradesMode
            "origin": "AI",
            "instrument": inst,
            "exchange": _EXCHANGE_BY_INSTRUMENT.get(inst, "NSE"),
            "transactionType": "BUY" if action.startswith("LONG") else "SELL",
            "optionType": side,
            "strike": strike,
            "contractSecurityId": str(sec_id),
            "entryPrice": entry,
            # stopLoss/takeProfit accept number OR null — send finite value or null.
            "stopLoss": _finite(signal.get("sl")),
            "takeProfit": _finite(signal.get("tp")),
            # No `lots` — SEA only signals. The server sizes the position from
            # its per-instrument `instrumentSizing` config (fixed lots or % of
            # capital) via sizedLots(); a lot count sent here would be ignored.
        }
        # Optional fields — include only when finite / present (schema rejects null).
        cohort = signal.get("cohort")
        if isinstance(cohort, str) and cohort:
            payload["cohort"] = cohort
        # Links this trade to its tray signal so the server can stamp the shared
        # global signalSeq (assigned when the signal was ingested) onto the trade.
        correlation_id = signal.get("correlationId")
        if isinstance(correlation_id, str) and correlation_id:
            payload["correlationId"] = correlation_id
        conf = _finite(signal.get("direction_prob_30s"))
        if conf is not None:
            payload["aiConfidence"] = conf
        rr = _finite(signal.get("rr"))
        if rr is not None:
            payload["aiRiskReward"] = rr

        resp = submit_new_trade(payload, timeout=5.0)
        if isinstance(resp, dict):
            return resp.get("tradeId")  # server tradeId, for a later targeted close
    except Exception as exc:  # never let auto-trade crash the inference loop
        print(f"  [auto-trade] skipped: {exc}", file=sys.stderr)
    return None


def _decide_via_gate(
    predictions: dict, thresholds: Thresholds, ce_ltp: float | None, pe_ltp: float | None
) -> SignalAction:
    """Thin wrapper: forward to the canonical 3-condition gate. Kept as
    its own function so the main loop reads the same way for both the
    gate and legacy paths."""
    return decide_action(predictions, thresholds, ce_ltp=ce_ltp, pe_ltp=pe_ltp)


def _pred(models, X, name: str) -> float:
    """Run one model if loaded, else return NaN.

    T25 — applies per-head isotonic calibration (V2_MASTER_SPEC D72)
    when a `.calibration.json` sidecar was loaded for this head.
    Regression heads and binary heads without a calibration map fall
    through unchanged (LoadedModels.apply_calibration is a no-op when
    no map exists)."""
    raw, cal = _pred_raw_cal(models, X, name)
    return cal


def _pred_raw_cal(models, X, name: str) -> tuple[float, float]:
    """T41 internal — returns ``(raw, calibrated)``. Same model call,
    captures both pre- and post-calibration values so
    ``prediction_logger`` can persist the pair for downstream
    calibration-drift / champion-challenger analyses (T34, T27 future).
    A single ``predict()`` call powers both values; cheap.
    """
    m = models.models.get(name)
    if m is None:
        return float("nan"), float("nan")
    raw = float(m.predict(X)[0])
    cal = float(models.apply_calibration(name, raw))
    return raw, cal


# Single source of truth for "which heads does the gate read + what dict
# key does it use." Each tuple is ``(dict_key_used_by_gate, model_name)``;
# they differ in two cases (``direction_prob_*`` vs ``direction_*``) and
# match for everything else. ``_gather_predictions`` and
# ``_gather_predictions_raw_cal`` (T41) both iterate this list so the
# head set never drifts between them.
_HEAD_PREDS: tuple[tuple[str, str], ...] = (
    # Base 3-cond targets (legacy 30s)
    ("direction_prob_30s",       "direction_30s"),
    ("risk_reward_ratio_30s",    "risk_reward_ratio_30s"),
    ("max_upside_30s",           "max_upside_30s"),
    ("max_drawdown_30s",         "max_drawdown_30s"),
    ("max_upside_300s",          "max_upside_300s"),
    ("max_drawdown_300s",        "max_drawdown_300s"),
    ("max_upside_900s",          "max_upside_900s"),
    ("max_drawdown_900s",        "max_drawdown_900s"),
    ("direction_30s_magnitude",  "direction_30s_magnitude"),
    # Wave 2 base 3-cond on 60s window
    ("direction_prob_60s",       "direction_60s"),
    ("risk_reward_ratio_60s",    "risk_reward_ratio_60s"),
    # Part B (2026-07-05): PE-leg RR — the scalp gate's C2 uses this for PUTS
    # (the CE risk_reward_ratio is the wrong leg for a put).
    ("risk_reward_ratio_pe_60s", "risk_reward_ratio_pe_60s"),
    # Wave 2 direction_persists across windows
    ("direction_persists_60s",   "direction_persists_60s"),
    ("direction_persists_120s",  "direction_persists_120s"),
    ("direction_persists_180s",  "direction_persists_180s"),
    ("direction_persists_240s",  "direction_persists_240s"),
    ("direction_persists_300s",  "direction_persists_300s"),
    # Wave 2 breakout_in
    ("breakout_in_60s",          "breakout_in_60s"),
    ("breakout_in_300s",         "breakout_in_300s"),
    # Wave 2 exit_signal
    ("exit_signal_60s",          "exit_signal_60s"),
    ("exit_signal_300s",         "exit_signal_300s"),
    # Wave 2 PE-leg targets (replace first-order swap for LONG_PE)
    ("max_upside_pe_60s",        "max_upside_pe_60s"),
    ("max_upside_pe_120s",       "max_upside_pe_120s"),
    ("max_upside_pe_180s",       "max_upside_pe_180s"),
    ("max_upside_pe_240s",       "max_upside_pe_240s"),
    ("max_upside_pe_300s",       "max_upside_pe_300s"),
    ("max_drawdown_pe_60s",      "max_drawdown_pe_60s"),
    ("max_drawdown_pe_120s",     "max_drawdown_pe_120s"),
    ("max_drawdown_pe_180s",     "max_drawdown_pe_180s"),
    ("max_drawdown_pe_240s",     "max_drawdown_pe_240s"),
    ("max_drawdown_pe_300s",     "max_drawdown_pe_300s"),
    # Wave 2 CE-leg 60s/120s/180s/240s (300s already in legacy list)
    ("max_upside_60s",           "max_upside_60s"),
    ("max_upside_120s",          "max_upside_120s"),
    ("max_upside_180s",          "max_upside_180s"),
    ("max_upside_240s",          "max_upside_240s"),
    ("max_drawdown_60s",         "max_drawdown_60s"),
    ("max_drawdown_120s",        "max_drawdown_120s"),
    ("max_drawdown_180s",        "max_drawdown_180s"),
    ("max_drawdown_240s",        "max_drawdown_240s"),
    # Trend-cohort heads (15-min / 30-min horizon). Consumed by
    # decide_action_trend (2026-06-22). Off the hot path until the
    # per-instrument JSON config's `trend.enabled: true` -- but always
    # gathered so the prediction logger captures them for analysis.
    ("trend_direction_900s",         "trend_direction_900s"),
    ("trend_direction_1800s",        "trend_direction_1800s"),
    # Part B (2026-07-05): down-direction heads — the gate fires puts off
    # these (validated val_auc 0.63/0.64) instead of guessing from the
    # up head's inverse.
    ("trend_direction_down_900s",    "trend_direction_down_900s"),
    ("trend_direction_down_1800s",   "trend_direction_down_1800s"),
    ("trend_continues_900s",         "trend_continues_900s"),
    ("trend_continues_1800s",        "trend_continues_1800s"),
    ("trend_breakout_imminent_900s",  "trend_breakout_imminent_900s"),
    ("trend_breakout_imminent_1800s", "trend_breakout_imminent_1800s"),
    ("trend_magnitude_900s",         "trend_magnitude_900s"),
    ("trend_magnitude_1800s",        "trend_magnitude_1800s"),
    ("trend_max_drawdown_900s",       "trend_max_drawdown_900s"),
    ("trend_max_drawdown_1800s",      "trend_max_drawdown_1800s"),
)


def _gather_predictions(models, X) -> dict[str, float]:
    """Pull the predictions the gate cares about into one dict.
    Used by all gate modes — entries returning NaN cost nothing and
    let the gates fail-open on missing models (e.g., Wave 1 models
    without Wave 2 targets).

    Wave 2 added 5 new target types per window (5 windows): direction_persists,
    breakout_in, exit_signal, max_upside_pe, max_drawdown_pe. Plus the
    base 3-cond moved from 30s → 60s window. Keys here cover both old
    and new shapes so any gate path runs without code branching.

    Returns the calibrated predictions only (what the gate consumes).
    Use ``_gather_predictions_raw_cal`` when both raw and calibrated
    values are needed (e.g. T41 prediction_logger).
    """
    return {gate_key: _pred(models, X, model_name)
            for gate_key, model_name in _HEAD_PREDS}


def _gather_predictions_raw_cal(
    models, X,
) -> tuple[dict[str, float], dict[str, float]]:
    """T41 variant — returns ``(raw_dict, cal_dict)`` with the SAME keys
    as ``_gather_predictions``. One ``predict()`` call per head powers
    both values (see ``_pred_raw_cal``); ~0% perf hit vs the calibrated-
    only path.

    Used by ``engine.run()`` when emitting the per-eval prediction log.
    The gate continues to consume only the calibrated dict, identical to
    the pre-T41 behaviour.
    """
    raw: dict[str, float] = {}
    cal: dict[str, float] = {}
    for gate_key, model_name in _HEAD_PREDS:
        r, c = _pred_raw_cal(models, X, model_name)
        raw[gate_key] = r
        cal[gate_key] = c
    return raw, cal


def _tail(path: Path, poll_sec: float = 0.2):
    """Generator: yield each NEW line appended to `path`.

    Seeks to the END on first open (true `tail -f`) so a mid-session restart
    resumes at the live tick immediately, instead of replaying the whole day's
    feature file from the start (which can be hundreds of MB → many minutes of
    backlog before any live signal). At market open the file is empty so this is
    a no-op. Handles file rotation (truncate / recreate → reopen from 0)."""
    pos: int | None = None
    while True:
        if not path.exists():
            time.sleep(poll_sec)
            continue
        size = path.stat().st_size
        if pos is None:
            pos = size  # start at end — skip the backlog on (re)start
        if size < pos:
            pos = 0
        with open(path, encoding="utf-8") as f:
            f.seek(pos)
            while True:
                line = f.readline()
                if not line:
                    pos = f.tell()
                    break
                yield line.rstrip("\n")
            pos = f.tell()
        time.sleep(poll_sec)


def _row_stream(live_path: Path, port: int | None, poll_sec: float = 0.2):
    """Generator: yield feature-row lines from the TCP feature socket,
    with the ndjson file as fallback (T70 tick→signal latency fix).

    Context: every SEA signal used to lag its tick by ~300s because TFA
    held rows back to backfill training labels, and SEA then discovered
    them via a 0.2s file poll (measured median 300.6s on 2026-07-02).
    TFA now emits live rows immediately; this socket removes the
    remaining file-poll hop so tick→signal is sub-second.

    Transports:
      * ``port is None`` → pure file tail; identical to ``_tail``.
      * else → listen on ``FEATURE_SOCKET_HOST:port`` (SEA is the
        listener; TFA's emitter connects OUT to us and pushes one
        NDJSON line per row, reconnecting every 3s if we restart).

    File fallback: while NO socket client is attached (TFA not started,
    an older TFA build without a socket sink, or a reconnect gap) the
    ndjson file is polled exactly like ``_tail`` — seek to end on first
    open, then yield newly appended lines. While a client IS attached
    the file is NOT read: the socket is the source of truth, and every
    socket row is also written to the file, so reading both would
    double-process. On client disconnect the file offset is
    repositioned to the file's CURRENT END before file reads resume,
    for the same reason.

    If the bind fails (port busy — e.g. a second SEA instance) a
    one-line warning is printed and we fall back to ``_tail`` forever.

    Plumbing is threads + queue (no asyncio), matching codebase style:
    one daemon thread owns accept+recv, the generator drains the queue.
    """
    if port is None:
        yield from _tail(live_path, poll_sec)
        return

    try:
        # create_server sets SO_REUSEADDR on POSIX (restart across
        # TIME_WAIT); Windows uses exclusive-bind semantics, which is
        # exactly what makes a genuinely busy port fail fast here.
        server = socket.create_server((FEATURE_SOCKET_HOST, port))
    except OSError as exc:
        print(
            f"  [row-stream] bind {FEATURE_SOCKET_HOST}:{port} failed "
            f"({exc}) -- falling back to file tail"
        )
        yield from _tail(live_path, poll_sec)
        return

    q: queue.Queue[str] = queue.Queue()
    connected = threading.Event()  # set while a TFA client is attached

    def _serve() -> None:
        while True:
            try:
                conn, _addr = server.accept()
            except OSError:  # listener closed — process exiting
                return
            connected.set()
            buf = b""
            try:
                while True:
                    chunk = conn.recv(65536)
                    if not chunk:  # TFA went away; it retries every 3s
                        break
                    buf += chunk
                    while b"\n" in buf:
                        raw, buf = buf.split(b"\n", 1)
                        if raw:
                            q.put(raw.decode("utf-8", errors="replace"))
            except OSError:
                pass  # hard disconnect — treat like a clean close
            finally:
                connected.clear()
                try:
                    conn.close()
                except OSError:
                    pass

    threading.Thread(
        target=_serve, name=f"sea-feature-socket-{port}", daemon=True
    ).start()

    pos: int | None = None  # fallback-tail file offset
    client_seen = False  # connect→disconnect edge detector
    while True:
        is_connected = connected.is_set()
        if client_seen and not is_connected:
            # Disconnect edge: rows that came via socket were ALSO
            # appended to the file — jump the fallback offset past them
            # so they are not processed twice.
            pos = live_path.stat().st_size if live_path.exists() else 0
        client_seen = is_connected

        try:
            yield q.get(timeout=poll_sec)
            continue
        except queue.Empty:
            pass

        if is_connected:
            continue  # socket attached: never read the file

        # ── file fallback (mirrors _tail) ──
        if not live_path.exists():
            continue
        size = live_path.stat().st_size
        if pos is None:
            pos = size  # start at end — skip the backlog, like _tail
        if size < pos:
            pos = 0  # rotation / truncation → reread from start
        if size > pos:
            with open(live_path, encoding="utf-8") as f:
                f.seek(pos)
                while True:
                    line = f.readline()
                    if not line:
                        break
                    yield line.rstrip("\n")
                pos = f.tell()


def _is_stale(row: dict, max_age_sec: float, now: float | None = None) -> bool:
    """T70 staleness guard: True when ``row``'s tick ``timestamp`` is more
    than ``max_age_sec`` seconds behind ``now`` (wall-clock by default).

    A stale backlog (file replay after a restart, reconnect floods) must
    never fire live signals — the tick the signal describes is long gone.
    Rows without a usable numeric ``timestamp`` count as stale: an
    unstampable row cannot prove it is fresh, and TFA always stamps live
    rows. ``max_age_sec <= 0`` disables the guard (every row passes).

    NOTE: backtest.py replays historical rows whose timestamps are
    hours/days old — run SEA with ``--max-row-age 0`` for backtests, or
    this guard will skip every replayed row.
    """
    if max_age_sec <= 0:
        return False
    if now is None:
        now = time.time()
    try:
        ts = float(row.get("timestamp") or 0)
    except (TypeError, ValueError):
        ts = 0.0
    return (now - ts) > max_age_sec


class _NullDashboard:
    """No-op stand-in for SignalDashboard when --no-dashboard is passed.

    Every public method matches SignalDashboard's signature but does
    nothing, so the engine's hook points don't need conditional
    branches everywhere. Falls back to today's scrolling print stream.
    """
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def set_gate_config(self, **_kw): pass
    def push_tick(self, **_kw): pass
    def push_signal(self, **_kw): pass
    def push_reject(self, **_kw): pass


class _RestrictedCohorts(dict):
    """Live-cohort dict with a hard allowlist (--only-cohorts).

    The control listener mutates this dict in real time from the global
    /ws/sea-control pushes. Toggleable cohorts outside the allowlist are
    forced OFF at construction and any later attempt to enable one is
    silently dropped, so a global UI toggle can never wake a cohort this
    engine instance was told not to run (MCX engines are sma5-only)."""

    _TOGGLEABLE = ("scalp", "trend", "ma", "sma5", "candleblue", "cb2")

    def __init__(self, base: dict, allowed: frozenset[str]):
        super().__init__(base)
        self._allowed = allowed
        for k in self._TOGGLEABLE:
            if k not in allowed:
                super().__setitem__(k, False)

    def __setitem__(self, key, value):
        if key in self._TOGGLEABLE and value and key not in self._allowed:
            return
        super().__setitem__(key, value)


def run(
    instrument: str,
    features_root: Path = Path("data/features"),
    config_dir: Path = Path("config/sea_thresholds"),
    use_dashboard: bool = True,
    max_row_age_sec: float = 5.0,
    only_cohorts: list[str] | None = None,
) -> None:
    """SEA main inference loop for one instrument.

    Rows arrive via ``_row_stream``: the TCP feature socket pushed by
    TFA when available (sub-second tick→signal, T70), with the ndjson
    file tail as fallback.

    ``max_row_age_sec`` (T70 staleness guard): rows whose tick
    ``timestamp`` is older than this many seconds are skipped BEFORE
    preprocessing/inference — a stale backlog must never fire live
    signals. 0 disables the guard. NOTE: backtest.py replays historical
    rows with old timestamps → run SEA with ``--max-row-age 0`` for
    backtests, or the guard will skip every replayed row.
    """
    live_path = features_root / f"{instrument}_live.ndjson"
    port = feature_socket_port(instrument)

    print()
    print(f"  SEA -- {instrument}")
    print(f"  Tail: {live_path}")
    if port is not None:
        print(f"  Rows: socket {FEATURE_SOCKET_HOST}:{port} + file fallback")
    else:
        print("  Rows: file tail (socket disabled)")
    models = load_models(instrument)
    print(f"  Model version: {models.version}")
    print(f"  Features: {len(models.feature_names)}")

    thresholds, v2_thresholds, wave2_thresholds, gate_mode = load_thresholds_full(
        instrument, config_dir,
    )
    # Trend gate (cohort=trend, 30-min horizon). Loaded independently
    # of the scalp gate mode so both can fire on the same tick.
    trend_thresholds = load_thresholds_trend(instrument, config_dir)
    # Leg-start gate (gate_mode="legstart", 2026-07-10). Stateful detector that
    # fires one trend-aligned signal per leg on the 1-min Heikin-Ashi underlying.
    # Only instantiated when active so the per-tick candle machinery is free
    # otherwise.
    legstart_thresholds = load_thresholds_legstart(instrument, config_dir)
    legstart_detector = (
        LegStartDetector(legstart_thresholds) if gate_mode == "legstart" else None
    )
    # MA-Signal gate (cohort="ma_signal", 2026-07-14). Independent of the scalp
    # gate mode (like the trend gate) — pure 20-EMA slope segmentation on the
    # underlying, fires each trend leg's start/end. SIGNAL-ONLY: never traded.
    ma_signal_thresholds = load_thresholds_ma_signal(instrument, config_dir)
    # ALWAYS construct the detector, even when the cohort starts disabled. The
    # cohort is live-toggleable from the AI menu over /ws/sea-control, and the
    # tick loop already suppresses the EMIT while `_live_cohorts["ma"]` is off
    # (it keeps feeding candles so they stay current). Gating construction on the
    # startup flag meant a SEA that booted with MA off could never be switched
    # back on — the toggle updated the flag but the detector was None forever.
    ma_signal_detector = MASignalDetector(ma_signal_thresholds)
    # SMA-5 price-cross gate (cohort="sma5_signal", 2026-08-05). Independent of
    # the scalp/trend/ma gates — pure SMA-5-vs-close cross on the underlying.
    # ALWAYS constructed (live-toggleable), like MA-Signal above.
    sma5_signal_thresholds = load_thresholds_sma5_signal(instrument, config_dir)
    sma5_signal_detector = Sma5SignalDetector(sma5_signal_thresholds)
    # Entry-gate confirmers: a continuous 5-SMA of each ATM side's premium. Fed the
    # ATM CE/PE premium every row so they stay warm; when the entry gate is on, an
    # entry only fires if the side's premium is ABOVE its own SMA5 (confirmation).
    sma5_prem_ce = _PremiumSma5()
    sma5_prem_pe = _PremiumSma5()
    # ── T163 premium-ribbon rewrite (2026-08-13, Partha) ──────────────────
    # When `ribbon` is on (the new default) the ma/sma5 cohorts IGNORE the
    # underlying detectors above and follow the trend ribbon of the SESSION-
    # LOCKED option contracts' own premiums: ribbon UP → LONG that leg, DOWN
    # → EXIT it, GRAY → no entry at all (an open ride holds). One background
    # feed polls the server for the locked CE/PE premium ticks (full session
    # first = silent warm-up, then incremental).
    def _mk_ribbon(src: str, th) -> PremiumRibbonDetector:
        return PremiumRibbonDetector(
            src,
            candle_sec=th.candle_sec,
            lookback=th.ribbon_lookback,
            gray_pctile=th.ribbon_gray_pctile,
            min_samples=th.ribbon_min_samples,
            min_noise_pct=th.ribbon_min_noise_pct,
            exit_on_gray=getattr(th, "ribbon_exit_on_gray", True),
        )
    ma_ribbon = (
        _mk_ribbon("ma", ma_signal_thresholds)
        if getattr(ma_signal_thresholds, "ribbon", False) else None
    )
    sma5_ribbon = (
        _mk_ribbon("sma5", sma5_signal_thresholds)
        if getattr(sma5_signal_thresholds, "ribbon", False) else None
    )
    # SMA5 ribbon is BINARY (Partha 2026-08-14: no gray — green and red only):
    # force the floor to 0 whatever the config says. Also removes the noise
    # warm-up, so sma5 judges ~12 min after open. MA keeps its gray knob.
    if sma5_ribbon is not None:
        sma5_ribbon.set_gray_pctile(0.0)
    # CandleBlue HH+HL structure cohort (2026-08-30). Built always so it can be
    # switched on live from the AI menu without a restart; reads the locked ATM
    # premium candles (same feed as the ribbons). Emits only while toggled on.
    candleblue_thresholds = load_thresholds_candleblue(instrument, config_dir)
    candleblue_detector = CandleBlueDetector(
        candle_sec=candleblue_thresholds.candle_sec,
        stop_buffer_pct=candleblue_thresholds.stop_buffer_pct,
        range_window=candleblue_thresholds.range_window,
    )
    # CB2 (candleblue v2, 2026-09-02) — HH+HL + range-position gate, 5-min default.
    # Runs PARALLEL to candleblue on the same locked-premium feed for a live A/B.
    cb2_thresholds = load_thresholds_candleblue2(instrument, config_dir)
    cb2_detector = CandleBlue2Detector(
        candle_sec=cb2_thresholds.candle_sec,
        stop_buffer_pct=cb2_thresholds.stop_buffer_pct,
        range_window=cb2_thresholds.range_window,
        min_range_pos=cb2_thresholds.min_range_pos,
    )
    premium_feed: LockedPremiumFeed | None = None
    if ma_ribbon is not None or sma5_ribbon is not None or candleblue_detector is not None or cb2_detector is not None:
        premium_feed = LockedPremiumFeed(instrument)
        premium_feed.start()
    if gate_mode == "wave2":
        sustain_filter = None  # model handles persistence via direction_persists_*
        print(
            f"  Filter: Wave 2 model-driven gate  "
            f"(prob>={thresholds.prob_min}, RR>={thresholds.rr_min}, "
            f"pctile>={thresholds.upside_percentile_min}, "
            f"persists_60s>={wave2_thresholds.persists_60s_min}, "
            f"persists_300s>={wave2_thresholds.persists_300s_min}, "
            f"exit_signal_60s<{wave2_thresholds.exit_signal_60s_max})"
        )
    elif gate_mode == "wave1":
        sustain_filter = SustainFilter(window_n=10)
        print(
            f"  Filter: 3-cond gate + Wave 1 deterministic layer  "
            f"(prob>={thresholds.prob_min}, RR>={thresholds.rr_min}, "
            f"pctile>={thresholds.upside_percentile_min}, "
            f"momentum>={v2_thresholds.momentum_persistence_min}, "
            f"sr_clearance>={v2_thresholds.sr_clearance_pct}%, "
            f"sustain_n={sustain_filter.window_n})"
        )
    elif gate_mode == "legstart":
        sustain_filter = None  # detector owns dedup (one signal per leg)
        _ls = legstart_thresholds
        print(
            f"  Filter: leg-start gate (1-min Heikin-Ashi, trend-aligned)  "
            f"(CE {_ls.ng_ce}-green+HL dir>={_ls.dir_ce}, "
            f"PE {_ls.ng_pe}-red+freshLL dir<={_ls.dir_pe}, "
            f"EMA{_ls.ema_period} slope{_ls.trend_slope}, "
            f"SL {_ls.sl_pct}% TP {_ls.tp_pct or 'ride'})"
        )
    else:
        sustain_filter = None
        print(
            f"  Filter: 3-condition gate (current)  "
            f"(prob>={thresholds.prob_min}, "
            f"RR>={thresholds.rr_min}, "
            f"pctile>={thresholds.upside_percentile_min})"
        )
    # Trend gate banner (2026-06-22).
    if trend_thresholds.enabled:
        print(
            f"  Trend gate: ENABLED (cohort=trend, 30-min horizon)  "
            f"(dir>={trend_thresholds.dir_prob_min}, "
            f"continues>={trend_thresholds.continues_min}, "
            f"breakout>={trend_thresholds.breakout_min}, "
            f"cooldown={trend_thresholds.min_seconds_between_signals}s)"
        )
    else:
        print(f"  Trend gate: disabled (no `trend` block in config)")
    # MA-Signal banner (2026-07-14).
    if ma_signal_thresholds.enabled:
        _ms = ma_signal_thresholds
        print(
            f"  MA-Signal: ENABLED (cohort=ma_signal, EMA{_ms.ema_period} "
            f"slope{_ms.slope_lookback} sticky hi>{_ms.thr_hi}/lo>{_ms.thr_lo}, "
            f"SL {_ms.sl_pct}% — auto-trades entries alongside scalp)"
        )
    else:
        # The detector is still built — the cohort can be switched on live from
        # the AI menu without restarting SEA.
        print(f"  MA-Signal: OFF at startup (live-toggleable from the AI menu)")
    # Premium-ribbon banner (T163, 2026-08-13).
    if premium_feed is not None:
        _rb = []
        if sma5_ribbon is not None:
            _rb.append(f"sma5 ({sma5_signal_thresholds.candle_sec}s candles)")
        if ma_ribbon is not None:
            _rb.append(f"ma ({ma_signal_thresholds.candle_sec}s candles)")
        print(
            f"  Premium ribbon: ON for {', '.join(_rb)} — signals follow the "
            f"LOCKED contract premiums (UP=enter, DOWN=exit, GRAY=no entry)"
        )
    print()

    raw_logger = SignalLogger(instrument)
    filtered_logger = SignalLogger(instrument, root=Path("logs/signals"), suffix="_filtered")
    # T41 feedback-loop foundation: persist every per-head (prediction,
    # outcome) tuple. The logger buffers in-memory and flushes per chunk;
    # ``finalise()`` on shutdown merges chunks into one parquet for the
    # day. ``outcome_*`` columns are NaN at write time — backfilled by
    # ``signal_engine_agent.outcome_backfiller`` post-session.
    _t41_date = datetime.now(_IST).strftime("%Y-%m-%d")
    prediction_logger = PredictionLogger(
        instrument=instrument, date_str=_t41_date,
    )
    # T33 D56: pre-compute head -> cohort map once at startup. The map
    # is immutable per process so we pass the same dict on every
    # log_eval call. Heads without a window-derived cohort
    # (e.g. upside_percentile_30s, regression heads outside the
    # scalp/trend/swing bands) are simply absent — logger writes NULL.
    _t33_head_types = build_head_type_map(
        [gate_key for gate_key, _ in _HEAD_PREDS]
    )
    print(
        f"  T41 predictions -> data/predictions/{_t41_date}/"
        f"{instrument}_predictions.parquet"
    )
    print(
        f"  T33 cohorts:   "
        f"{sum(1 for v in _t33_head_types.values() if v == 'scalp')} scalp / "
        f"{sum(1 for v in _t33_head_types.values() if v == 'trend')} trend / "
        f"{sum(1 for v in _t33_head_types.values() if v == 'swing')} swing"
    )
    # F4 hot-path optimisation: pre-allocate the feature vector buffer
    # once per SEA instance and reuse it on every tick. The returned
    # array is the same buffer each call — `vec` must be consumed before
    # the next `process()` call. SEA reshapes-and-predicts immediately,
    # which is safe (LightGBM copies inputs internally for prediction).
    live_preprocessor = LiveTickPreprocessor(models.feature_config)
    processed = 0
    raw_signals = 0
    filtered_signals = 0
    stale_rows = 0  # T70 staleness-guard skip counter
    started = time.time()

    # Cooldown for raw signal feed (existing UI behavior, both modes). During a
    # sustained trend the scalp gate returns the same action every tick; this
    # re-emits it at most once per COOLDOWN_SEC. Part B SEA filter (2026-07-05):
    # raise via SEA_RAW_COOLDOWN_SEC to cut mid-trend spam (scalp-trend
    # alignment already vetoes the counter-trend flips). Default 30s (legacy).
    try:
        COOLDOWN_SEC = float(os.environ.get("SEA_RAW_COOLDOWN_SEC", "") or 30)
    except ValueError:
        COOLDOWN_SEC = 30.0
    _last_action: str = ""
    _last_emit_ts: float = 0.0
    # Per-instrument trend-cohort cooldown. Trend horizon is 30 min --
    # spamming GO_CALL every tick is meaningless. One signal per
    # `min_seconds_between_signals` (default 600s = 10 min).
    _last_trend_emit_ts: float = 0.0
    trend_emitted = 0
    ma_emitted = 0

    # Liveness heartbeat — a daemon thread POSTs to the server every 5s
    # INDEPENDENT of tick flow, so the UI shows SEA as running even when the
    # feed is starved (the tail loop below blocks when there are no ticks).
    _hb_stop = threading.Event()

    def _ribbon_hb() -> dict | None:
        """T163 — warm-up state for the heartbeat, so the UI can show
        'signal engine warming up' instead of silence. Reads detector state
        cross-thread (plain int reads — GIL-safe)."""
        det = sma5_ribbon or ma_ribbon
        if det is None or premium_feed is None:
            return None
        try:
            w = det.warmup()
            fed = (
                premium_feed.last_ltp.get("CE") is not None
                or premium_feed.last_ltp.get("PE") is not None
            )
            state = "ready" if w["ready"] else ("warming" if fed else "no-feed")
            return {"state": state, "samples": w["samples"], "need": w["need"]}
        except Exception:
            return None

    def _heartbeat_loop() -> None:
        from signal_engine_agent.risk_control_client import send_heartbeat

        while True:
            try:
                send_heartbeat(instrument, ribbon=_ribbon_hb())
            except Exception:  # pragma: no cover - never crash on heartbeat
                pass
            if _hb_stop.wait(5.0):
                break

    _hb_thread = threading.Thread(
        target=_heartbeat_loop, name=f"sea-heartbeat-{instrument}", daemon=True
    )
    _hb_thread.start()

    # ── Live cohort control (2026-07-14) ──────────────────────────────────
    # Cohorts toggled from the UI over the dedicated /ws/sea-control websocket.
    # Init from config; a daemon listener updates this dict in real time. The
    # gate branches in the tick loop read it every tick — no restart to toggle.
    _live_cohorts = {
        "scalp": legstart_thresholds.enabled if gate_mode == "legstart" else True,
        "trend": trend_thresholds.enabled,
        "ma": ma_signal_thresholds.enabled,
        "rev_pct": ma_signal_thresholds.rev_pct,  # MA reversal size, live-tunable
        "ma_candle_sec": ma_signal_thresholds.candle_sec,  # MA candle timeframe (s), live-tunable
        "sma5": sma5_signal_thresholds.enabled,
        "sma5_confirm": sma5_signal_thresholds.confirm_candles,  # SMA5 exit confirm, live-tunable
        "sma5_buffer": sma5_signal_thresholds.buffer_pct,  # SMA5 deadband %, live-tunable
        "sma5_entry_watch": sma5_signal_thresholds.entry_watch,  # SMA5 entry-watch candles, live-tunable
        "sma5_entry_gate": sma5_signal_thresholds.entry_gate,  # SMA5 premium-confirm entry gate, live-tunable
        "sma5_candle_sec": sma5_signal_thresholds.candle_sec,  # SMA5 candle timeframe (s), live-tunable
        # T163 premium-ribbon knobs — follow Settings ▸ Trend angle live.
        "ribbon_lookback": sma5_signal_thresholds.ribbon_lookback,
        "ribbon_gray_pctile": sma5_signal_thresholds.ribbon_gray_pctile,
        # CandleBlue HH+HL structure cohort (2026-08-30).
        "candleblue": candleblue_thresholds.enabled,
        "candleblue_candle_sec": candleblue_thresholds.candle_sec,  # live-tunable
        # CB2 (candleblue v2, 2026-09-02) — parallel A/B cohort.
        "cb2": cb2_thresholds.enabled,
        "cb2_candle_sec": cb2_thresholds.candle_sec,  # live-tunable
    }
    # ── --only-cohorts allowlist (2026-08-10, MCX sma5-only mandate) ──────
    # Cohort control is GLOBAL across engines (T91 parked), so an MCX engine
    # started for sma5 would also fire scalp/trend off its never-validated
    # stopgap model whenever the global toggles are on. The allowlist pins
    # every non-listed cohort OFF for THIS process, and the pin survives
    # live control pushes: enabling a disallowed cohort is silently ignored.
    if only_cohorts is not None:
        _live_cohorts = _RestrictedCohorts(_live_cohorts, frozenset(only_cohorts))
    start_control_listener(_live_cohorts, instrument)
    # MA-Signal open positions (side "CE"/"PE" -> server tradeId) so the leg-end
    # EXIT signal can close the exact trade — they ride with no auto-exit.
    _ma_open: dict[str, str] = {}
    # SMA-5 open positions — same role as _ma_open for the sma5_signal cohort.
    _sma5_open: dict[str, str] = {}

    # ── Dashboard setup (2026-07-01, replaces scrolling print heartbeat) ──
    # Rich-based alt-screen showing model + gate config, feed liveness,
    # signal counters, last predictions, recent signals with tick→fire
    # latency, and reject-reason breakdowns. Falls back to a null shim
    # when use_dashboard=False so --no-dashboard preserves the old
    # print-scroll behaviour for debug sessions.
    if use_dashboard:
        dashboard: SignalDashboard | _NullDashboard = SignalDashboard(
            instrument=instrument,
            model_version=str(models.version),
            feature_count=len(models.feature_names),
        )
        dashboard.set_gate_config(
            mode=gate_mode,
            prob_min=float(thresholds.prob_min),
            rr_min=float(thresholds.rr_min),
            pctile_min=float(thresholds.upside_percentile_min),
            persists_60s_min=float(
                getattr(wave2_thresholds, "persists_60s_min", 0.0) or 0.0
            ),
            exit_signal_60s_max=float(
                getattr(wave2_thresholds, "exit_signal_60s_max", 0.0) or 0.0
            ),
            trend_enabled=bool(trend_thresholds.enabled),
            trend_dir_prob_min=float(trend_thresholds.dir_prob_min or 0.0),
            trend_continues_min=float(trend_thresholds.continues_min or 0.0),
            trend_breakout_min=float(trend_thresholds.breakout_min or 0.0),
            trend_magnitude_scale=float(getattr(
                trend_thresholds, "magnitude_scale", 0.0,
            ) or 0.0),
            trend_cooldown_sec=int(
                trend_thresholds.min_seconds_between_signals or 0
            ),
        )
    else:
        dashboard = _NullDashboard()

    dashboard.__enter__()
    try:
        for line in _row_stream(live_path, port):
            # ── Live model swap (T94) ─────────────────────────────
            # The AI menu can point the running engine at a different trained
            # version without a restart. Done HERE, at the top of the row loop,
            # so no row is ever scored half by one model and half by another —
            # and the preprocessor is rebuilt WITH the model, because it is
            # built from that model's own feature_config. Swapping one without
            # the other would select one column set and score it with another.
            # (LiveTickPreprocessor holds no rolling state — just a reusable
            # buffer — so rebuilding it costs nothing.)
            _req_model = _live_cohorts.get("model")
            if _req_model and _req_model != models.version:
                _t0 = time.time()
                try:
                    _new = load_models(instrument, version=_req_model)
                    live_preprocessor = LiveTickPreprocessor(_new.feature_config)
                    models = _new
                    print(
                        f"  [model] swapped -> {models.version} "
                        f"({len(models.feature_names)} features, {time.time() - _t0:.1f}s)",
                        flush=True,
                    )
                except Exception as exc:  # noqa: BLE001 — never kill the engine
                    print(
                        f"  [model] swap to {_req_model!r} FAILED, staying on "
                        f"{models.version}: {exc}",
                        file=sys.stderr, flush=True,
                    )
                # Clear either way: a bad version must not retry on every row.
                _live_cohorts["model"] = None

            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue

            # T70 staleness guard — BEFORE preprocessing/inference. Skip
            # silently; surface one summary line every 200 skips.
            if _is_stale(row, max_row_age_sec):
                stale_rows += 1
                if stale_rows % 200 == 0:
                    print(
                        f"  [stale] skipped {stale_rows} rows older than "
                        f"{max_row_age_sec}s"
                    )
                continue

            vec = live_preprocessor.process(row)
            if vec is None:
                continue
            X = vec.reshape(1, -1)

            # T41: gather BOTH raw + calibrated. The gate consumes the
            # calibrated ``preds`` dict exactly as before; the raw dict
            # is only passed to the prediction logger after the gate runs.
            raw_preds, preds = _gather_predictions_raw_cal(models, X)
            # The session-rank `upside_percentile_30s` is a TFA-emitted
            # live feature column on the parquet row, not a model target
            # (per Phase E9). Pull it from the row directly.
            # `.get(key, default)` only returns the default when the key is
            # MISSING. TFA may emit the column with an explicit null when the
            # session-rank window hasn't filled yet → coerce None → nan.
            _pct = row.get("upside_percentile_30s")
            preds["upside_percentile_30s"] = float(_pct) if _pct is not None else float("nan")
            # Wave 2 base gate uses 60s window — TFA emits upside_percentile_{min_window}s
            # where min_window is the profile's smallest target window. Post-Wave-2 that
            # smallest is 60s, so the column is upside_percentile_60s.
            _pct60 = row.get("upside_percentile_60s")
            preds["upside_percentile_60s"] = float(_pct60) if _pct60 is not None else float("nan")

            # Push this tick's state to the dashboard (feed counter +
            # last-preds panel). Broker ltt in row["timestamp"] is used
            # by push_signal below to compute tick→fire latency.
            dashboard.push_tick(
                row_ts=row.get("timestamp") or 0.0,
                preds=preds,
            )

            regime = row.get("regime")
            ce_ltp = row.get("opt_0_ce_ltp")
            pe_ltp = row.get("opt_0_pe_ltp")

            if gate_mode == "wave2":
                # Wave 2 model-driven gate: base 3-cond + direction_persists +
                # exit_signal + per-leg PE targets. Model handles persistence
                # so no sustained-tick filter needed.
                # Structure-aware TP/SL: build the S/R context only when the
                # flag is on (zero overhead otherwise).
                structure = (
                    _build_structure_context(row)
                    if wave2_thresholds.structure_tp_sl else None
                )
                sig = decide_action_wave2(
                    preds, thresholds, wave2_thresholds,
                    ce_ltp=ce_ltp, pe_ltp=pe_ltp, structure=structure,
                )
                # Part B SEA filter (2026-07-05): veto scalp signals that
                # fight a confident 30-min trend (COUNTER_TREND). No-op when
                # the trend is neutral / heads absent / flag off.
                sig = apply_trend_alignment(
                    sig, preds, trend_thresholds.dir_prob_min,
                    enabled=wave2_thresholds.scalp_trend_align
                    and trend_thresholds.enabled,
                )
                # Option-buildup veto (2026-07-06): block a scalp fighting a
                # strong per-leg OI×premium buildup. Reads the feature `row`
                # (buildup inputs are features, not heads). No-op when off /
                # neutral.
                sig = apply_buildup_filter(
                    sig, row, wave2_thresholds,
                    enabled=wave2_thresholds.buildup_filter,
                )
            elif gate_mode == "wave1":
                # Wave 1 deterministic gate: 3-condition + regime + momentum + S/R + sustained-N
                raw_sig = decide_action_v2(
                    preds, thresholds, v2_thresholds,
                    ce_ltp=ce_ltp, pe_ltp=pe_ltp,
                    regime=regime if isinstance(regime, str) else None,
                    momentum_persistence_ticks=row.get("momentum_persistence_ticks"),
                    distance_to_day_high_pct=row.get("distance_to_day_high_pct"),
                    distance_to_day_low_pct=row.get("distance_to_day_low_pct"),
                )
                # Apply sustained-tick filter on the raw decision
                confirmed = sustain_filter.observe(raw_sig.action)
                if confirmed != "WAIT" and raw_sig.gate_passed:
                    sig = raw_sig
                else:
                    sig = SignalAction(
                        action="WAIT", direction=raw_sig.direction,
                        entry=0.0, tp=0.0, sl=0.0, rr=0.0,
                        gate_passed=False,
                        gate_reasons=raw_sig.gate_reasons + (
                            ["C7_not_sustained"] if confirmed == "WAIT" and raw_sig.gate_passed else []
                        ),
                    )
            elif gate_mode == "legstart":
                # Stateful leg-start gate: feed the tick's spot + model
                # direction into the detector; it fires at most once per leg
                # (on the candle that starts a trend-aligned move). Exit is
                # fixed-% SL + the execution side's time/momentum exits (no
                # fixed TP when tp_pct <= 0 → ride the leg).
                _ts = _finite(row.get("timestamp"))
                _spot = _finite(row.get("spot_price"))
                _dprob = _finite(preds.get("direction_prob_60s"))
                leg = (
                    legstart_detector.on_tick(_ts, _spot, _dprob)
                    if legstart_detector is not None
                    and _ts is not None and _spot is not None else None
                )
                if leg is None:
                    sig = SignalAction(
                        action="WAIT", direction="WAIT",
                        entry=0.0, tp=0.0, sl=0.0, rr=0.0,
                        gate_passed=False, gate_reasons=["LEG_WAIT"],
                    )
                else:
                    _is_call = "CE" in leg
                    _ent = _finite(ce_ltp if _is_call else pe_ltp)
                    if _ent is None or _ent <= 0:
                        sig = SignalAction(
                            action="WAIT", direction="WAIT",
                            entry=0.0, tp=0.0, sl=0.0, rr=0.0,
                            gate_passed=False, gate_reasons=["NO_LTP"],
                        )
                    else:
                        _slp = legstart_thresholds.sl_pct
                        _tpp = legstart_thresholds.tp_pct
                        _sl = _ent * (1.0 - _slp / 100.0)
                        _tp = _ent * (1.0 + _tpp / 100.0) if _tpp > 0 else 0.0
                        _rr = round(_tpp / _slp, 2) if (_tpp > 0 and _slp > 0) else 0.0
                        sig = SignalAction(
                            action=leg,
                            direction="GO_CALL" if _is_call else "GO_PUT",
                            entry=_ent, tp=_tp, sl=_sl, rr=_rr,
                            gate_passed=True, gate_reasons=[],
                        )
            else:
                sig = _decide_via_gate(preds, thresholds, ce_ltp, pe_ltp)
            action = sig.action
            entry, tp, sl, rr = sig.entry, sig.tp, sig.sl, sig.rr
            gate_reasons = sig.gate_reasons

            # T41: persist this eval's per-head (prediction, outcome)
            # tuples. Outcome columns are NaN here; outcome_backfiller
            # joins them in post-session from the recorded tick stream.
            # Logged for EVERY eval — both heads-that-fired and heads-
            # that-didn't — so T34's reliability + calibration drift
            # analyses see the full distribution. Timestamp resolution
            # falls back to wall-clock when the row didn't carry one.
            _row_ts_ns = _derive_ts_ns(row)
            try:
                prediction_logger.log_eval(
                    ts_ns=_row_ts_ns,
                    feature_vec=vec,
                    raw_preds=raw_preds,
                    calibrated_preds=preds,
                    gate_decision=action,
                    regime_tag=regime if isinstance(regime, str) else None,
                    head_types=_t33_head_types,
                )
            except Exception as exc:
                # Never let the prediction logger crash the inference
                # loop. Log + continue; T34 will surface gaps anyway.
                print(f"  T41 log_eval error: {exc}", file=sys.stderr)

            processed += 1

            # ── Raw signal emission (cooldown, UI feed) ──
            now_ts = time.time()
            should_emit_raw = _live_cohorts["scalp"] and action != "WAIT" and (
                # legstart already fires at most once per leg — never suppress it
                gate_mode == "legstart"
                or action != _last_action or now_ts - _last_emit_ts >= COOLDOWN_SEC
            )

            if should_emit_raw:
                _last_action = action
                _last_emit_ts = now_ts
                raw_signals += 1
                # T33 D56: cohort tag on every emitted signal. Current
                # gates (wave2 / wave1 / 3-cond) are all scalp-window
                # driven, so the originating cohort is always "scalp"
                # today. When T29 lands head-type routing for trend /
                # swing gates this will derive from the firing head's
                # cohort instead of being a constant.
                signal_cohort = "scalp"
                # Human-readable "why this trade fired" — the gate drivers that
                # cleared the threshold (logged with the signal for audit).
                # Wave-2 scalp window is 60s (the 30s heads were dropped);
                # read the 60s heads the gate actually consumed.
                _dp = _finite(preds.get("direction_prob_60s")) or 0.0
                if gate_mode == "legstart":
                    reason = (
                        f"legstart · "
                        f"{'CALL up-leg' if 'CE' in action else 'PUT down-leg'} "
                        f"· trend-aligned · conviction {max(_dp, 1.0 - _dp):.2f}"
                    )
                else:
                    reason = (
                        f"{gate_mode} gate · conviction {max(_dp, 1.0 - _dp):.2f} · "
                        f"RR {_fmt(preds.get('risk_reward_ratio_60s'), 1)} · "
                        f"pctile {_fmt(preds.get('upside_percentile_30s'), 0)} · "
                        f"persist60 {_fmt(preds.get('direction_persists_60s'))} · "
                        f"persist300 {_fmt(preds.get('direction_persists_300s'))} · "
                        f"exit60 {_fmt(preds.get('exit_signal_60s'))} · regime {regime}"
                    )
                signal = {
                    "timestamp": row.get("timestamp"),
                    "timestamp_ist": datetime.now(_IST).isoformat(timespec="milliseconds"),
                    "correlationId": uuid.uuid4().hex,
                    "instrument": instrument.upper(),
                    "action": action,
                    "cohort": signal_cohort,
                    "reason": reason,
                    # Legacy field names kept for the downstream contract
                    # (Mongo schema, UI card, RCA); Wave-2 fills them with
                    # the 60s scalp heads (the 30s heads no longer exist).
                    "direction_prob_30s": round(preds["direction_prob_60s"], 4),
                    "risk_reward_ratio_30s": round(preds["risk_reward_ratio_60s"], 4),
                    "upside_percentile_30s": round(preds["upside_percentile_30s"], 2),
                    "max_upside_pred_30s": round(preds["max_upside_30s"], 2),
                    "max_drawdown_pred_30s": round(preds["max_drawdown_30s"], 2),
                    "regime": regime,
                    "entry": round(entry, 2),
                    # legstart with tp_pct<=0 rides the leg (no fixed target) →
                    # send null so the trade uses time/momentum + SL exits only.
                    "tp": (None if (gate_mode == "legstart" and tp <= 0) else round(tp, 2)),
                    "sl": round(sl, 2),
                    "rr": rr,
                    "atm_strike": row.get("atm_strike"),
                    "atm_ce_ltp": ce_ltp,
                    "atm_pe_ltp": pe_ltp,
                    "atm_ce_security_id": row.get("atm_ce_security_id"),
                    "atm_pe_security_id": row.get("atm_pe_security_id"),
                    "spot_price": row.get("spot_price"),
                    "momentum": row.get("underlying_momentum"),
                    "breakout": row.get("breakout_readiness"),
                    "model_version": models.version,
                    "gate_mode": gate_mode,
                    "direction": "GO_CALL" if "CE" in action else "GO_PUT",
                }
                raw_logger.log(signal)
                _send_signal_to_tray(signal)  # live UI tray (Mongo + WS)
                # Optional: also place the trade (off unless SEA_AUTO_TRADE set).
                _maybe_submit_ai_trade(signal)
                # Dashboard: tick→fire latency = wall_now - broker_ltt.
                _tick_ts = row.get("timestamp")
                _lat_ms = (
                    max(0.0, (time.time() - float(_tick_ts)) * 1000.0)
                    if _tick_ts else -1.0
                )
                dashboard.push_signal(signal=signal, latency_ms=_lat_ms)

            # ── Trend-cohort gate (2026-06-22) ─────────────────────
            # Independent of the scalp gate above -- can fire on the
            # same tick AND in addition to a scalp signal. Trend gate
            # consumes the 30-min horizon heads (trend_direction_1800s,
            # trend_continues_1800s, trend_breakout_imminent_1800s).
            # Disabled-by-default; opt in via the per-instrument JSON
            # config's `trend.enabled: true`.
            if _live_cohorts["trend"]:
                trend_sig = decide_action_trend(
                    preds, trend_thresholds,
                    ce_ltp=ce_ltp, pe_ltp=pe_ltp,
                )
                if trend_sig.action != "WAIT" and trend_sig.gate_passed:
                    # Per-instrument cooldown -- don't spam the same
                    # 30-min trend over and over.
                    seconds_since_last = now_ts - _last_trend_emit_ts
                    if seconds_since_last >= trend_thresholds.min_seconds_between_signals:
                        _last_trend_emit_ts = now_ts
                        trend_emitted += 1
                        trend_reason = (
                            f"trend gate · dir {_fmt(preds.get('trend_direction_1800s'))} · "
                            f"continues {_fmt(preds.get('trend_continues_1800s'))} · "
                            f"breakout {_fmt(preds.get('trend_breakout_imminent_1800s'))} · "
                            f"mag {_fmt(preds.get('trend_magnitude_1800s'), 1)} · regime {regime}"
                        )
                        trend_signal = {
                            "timestamp": row.get("timestamp"),
                            "timestamp_ist": datetime.now(_IST).isoformat(timespec="milliseconds"),
                            "correlationId": uuid.uuid4().hex,
                            "instrument": instrument.upper(),
                            "action": trend_sig.action,
                            "cohort": "trend",
                            "reason": trend_reason,
                            "trend_dir_prob_1800s": round(
                                float(preds.get("trend_direction_1800s") or 0.0), 4,
                            ),
                            "trend_continues_1800s": round(
                                float(preds.get("trend_continues_1800s") or 0.0), 4,
                            ),
                            "trend_breakout_in_1800s": round(
                                float(preds.get("trend_breakout_imminent_1800s") or 0.0), 4,
                            ),
                            "trend_magnitude_1800s": round(
                                float(preds.get("trend_magnitude_1800s") or 0.0), 2,
                            ),
                            "regime": regime,
                            "entry": trend_sig.entry,
                            "tp": trend_sig.tp,
                            "sl": trend_sig.sl,
                            "rr": trend_sig.rr,
                            "atm_strike": row.get("atm_strike"),
                            "atm_ce_ltp": ce_ltp,
                            "atm_pe_ltp": pe_ltp,
                            "atm_ce_security_id": row.get("atm_ce_security_id"),
                            "atm_pe_security_id": row.get("atm_pe_security_id"),
                            "spot_price": row.get("spot_price"),
                            "model_version": models.version,
                            "gate_mode": "trend",
                            "direction": trend_sig.direction,
                        }
                        raw_logger.log(trend_signal)
                        _send_signal_to_tray(trend_signal)  # live UI tray (Mongo + WS)
                        # Optional: also place the trend trade (off unless SEA_AUTO_TRADE set).
                        _maybe_submit_ai_trade(trend_signal)
                        # Dashboard: tick→fire latency for the trend leg.
                        _t_tick_ts = row.get("timestamp")
                        _t_lat_ms = (
                            max(0.0, (time.time() - float(_t_tick_ts)) * 1000.0)
                            if _t_tick_ts else -1.0
                        )
                        dashboard.push_signal(
                            signal=trend_signal, latency_ms=_t_lat_ms,
                        )
                    else:
                        # Trend fired the gate but was inside the cooldown
                        # window -- count as a cooldown reject so the
                        # dashboard's reject panel reflects reality.
                        dashboard.push_reject(
                            cohort="trend", reasons=["cooldown"],
                        )
                elif trend_sig.gate_reasons:
                    # Trend gate rejected this tick -- surface WHY it
                    # rejected in the dashboard's trend-reject breakdown.
                    dashboard.push_reject(
                        cohort="trend", reasons=trend_sig.gate_reasons,
                    )

            # ── T163: drain the locked-premium feed → ribbon events ──────
            # The daemon poller queues locked-contract premium ticks; here
            # (engine thread) they run through the ribbon detectors. History
            # batches warm silently; only LIVE ticks may fire events.
            _rb_ma_events: list[str] = []
            _rb_s5_events: list[str] = []
            _rb_cb_events: list[str] = []
            _rb_cb2_events: list[str] = []
            if premium_feed is not None:
                try:
                    # Live ribbon knobs (Settings ▸ Trend angle → control ws).
                    # Pctile applies at the next candle; a lookback change
                    # resets the legs and re-warms them from the feed history.
                    # Gray knob drives the MA ribbon ONLY — sma5 is pinned
                    # binary (gray 0, Partha 2026-08-14).
                    _rgp = _live_cohorts.get("ribbon_gray_pctile")
                    if _rgp is not None and ma_ribbon is not None:
                        ma_ribbon.set_gray_pctile(float(_rgp))
                    _rlb = _live_cohorts.get("ribbon_lookback")
                    if _rlb is not None:
                        _rlb_changed = False
                        for _det in (ma_ribbon, sma5_ribbon):
                            if _det is not None and _det.set_lookback(int(_rlb)):
                                _rlb_changed = True
                        if _rlb_changed:
                            premium_feed.rewarm()
                            print(f"  [ribbon] {instrument.upper()} lookback -> {_rlb} — re-warming legs", flush=True)
                    for _leg, _rst, _rb_live, _rb_ticks in premium_feed.drain():
                        if _rst:
                            if ma_ribbon is not None:
                                ma_ribbon.reset_leg(_leg)
                            if sma5_ribbon is not None:
                                sma5_ribbon.reset_leg(_leg)
                            if candleblue_detector is not None:
                                candleblue_detector.reset_leg(_leg)
                            if cb2_detector is not None:
                                cb2_detector.reset_leg(_leg)
                            print(f"  [ribbon] {instrument.upper()} {_leg} relocked — re-warming on the new contract", flush=True)
                            continue
                        if not _rb_live:
                            # Session history — warm up, don't fire on past turns.
                            # EXCEPTION: if the leg finishes warm-up already UP,
                            # warm() returns a LONG so an into-green turn that
                            # completed inside the history isn't missed.
                            if ma_ribbon is not None:
                                _rb_ma_events.extend(ma_ribbon.warm(_leg, _rb_ticks))
                            if sma5_ribbon is not None:
                                _rb_s5_events.extend(sma5_ribbon.warm(_leg, _rb_ticks))
                            if candleblue_detector is not None:
                                _rb_cb_events.extend(candleblue_detector.warm(_leg, _rb_ticks))
                            if cb2_detector is not None:
                                _rb_cb2_events.extend(cb2_detector.warm(_leg, _rb_ticks))
                            continue
                        for _pts, _pltp in _rb_ticks:
                            if ma_ribbon is not None:
                                _rb_ma_events.extend(ma_ribbon.on_leg_tick(_leg, _pts, _pltp))
                            if sma5_ribbon is not None:
                                _rb_s5_events.extend(sma5_ribbon.on_leg_tick(_leg, _pts, _pltp))
                            if candleblue_detector is not None:
                                _rb_cb_events.extend(candleblue_detector.on_leg_tick(_leg, _pts, _pltp))
                            if cb2_detector is not None:
                                _rb_cb2_events.extend(cb2_detector.on_leg_tick(_leg, _pts, _pltp))
                except Exception as exc:
                    print(f"  premium-ribbon feed error: {exc}", file=sys.stderr)

                # ── T169-B: push each CLOSED ribbon candle's line to the chart ──
                # Server-authoritative line: the chart draws these exact values
                # (the numbers the ribbon decision used) instead of recomputing.
                # Always drain (so the queue can't grow); emit only once the lock
                # date + contract id are known. Fire-and-forget, short timeout.
                try:
                    from signal_engine_agent.risk_control_client import send_line
                    _emit_date = premium_feed.date
                    for _det in (ma_ribbon, sma5_ribbon):
                        if _det is None:
                            continue
                        for (_leg, _t, _line, _state, _close, _deg) in _det.drain_closed():
                            _sid = premium_feed.sec_id(_leg)
                            if _emit_date and _sid:
                                send_line({
                                    "instrument": instrument,
                                    "date": _emit_date,
                                    "securityId": _sid,
                                    "kind": _det.source,
                                    "t": _t,
                                    "line": _line,
                                    "state": _state,
                                    "close": _close,
                                    "deg": _deg,
                                })
                except Exception as exc:
                    print(f"  ribbon line push error: {exc}", file=sys.stderr)

            # ── MA-Signal cohort (2026-07-14) ──────────────────────
            # Independent of the scalp/trend gates. Pure 20-EMA slope
            # segmentation (sticky) on the underlying — fires LONG_CE /
            # LONG_PE at a trend leg START and EXIT_CE / EXIT_PE at its
            # END. T163: in ribbon mode the events instead come from the
            # LOCKED PUT/CALL premium ribbons (see drain above).
            if ma_signal_detector is not None:
                try:
                    # Apply the live reversal size from the control panel (0 =
                    # slope mode). Takes effect on the next candle — no restart.
                    _rp = _live_cohorts.get("rev_pct")
                    if _rp is not None:
                        ma_signal_detector.rev_pct = _rp
                    # Live candle timeframe (seconds) from the panel.
                    _macs = _live_cohorts.get("ma_candle_sec")
                    if _macs is not None:
                        try:
                            ma_signal_detector.set_candle_sec(int(_macs))
                        except (TypeError, ValueError):
                            pass
                    _ma_ts = _finite(row.get("timestamp"))
                    _ma_spot = _finite(row.get("spot_price"))
                    if ma_ribbon is not None:
                        # T163: events come from the locked-premium ribbons;
                        # the live candle_sec knob applies to the legs too.
                        if _macs is not None:
                            try:
                                ma_ribbon.set_candle_sec(int(_macs))
                            except (TypeError, ValueError):
                                pass
                        ma_events = _rb_ma_events
                    else:
                        ma_events = (
                            ma_signal_detector.on_tick(_ma_ts, _ma_spot)
                            if _ma_ts is not None and _ma_spot is not None else []
                        )
                    # Keep the detector FED even when the cohort is toggled off so
                    # its candles stay current; just suppress the emit while off.
                    if not _live_cohorts["ma"]:
                        ma_events = []
                    for _ev in ma_events:
                        _ma_call = "CE" in _ev
                        _ma_exit = _ev.startswith("EXIT")
                        _ma_side = "CE" if _ma_call else "PE"
                        # Ribbon mode prices off the LOCKED contract's premium
                        # (that IS what the signal watched); ATM is the fallback.
                        _ma_ltp = None
                        if ma_ribbon is not None and premium_feed is not None:
                            _ma_ltp = _finite(premium_feed.last_ltp.get(_ma_side))
                        if _ma_ltp is None:
                            _ma_ltp = _finite(ce_ltp if _ma_call else pe_ltp)
                        ma_signal_out = {
                            "timestamp": row.get("timestamp"),
                            "timestamp_ist": datetime.now(_IST).isoformat(timespec="milliseconds"),
                            "correlationId": uuid.uuid4().hex,
                            "instrument": instrument.upper(),
                            "action": _ev,
                            "cohort": "ma_signal",
                            "reason": (
                                (
                                    f"MA ribbon {'DOWN — exit' if _ma_exit else 'UP — enter'} "
                                    f"{_ma_side} (locked {premium_feed.strikes.get(_ma_side) or '?'} premium)"
                                )
                                if ma_ribbon is not None and premium_feed is not None
                                else (
                                    f"MA-Signal · {'exit' if _ma_exit else 'enter'} "
                                    f"{'CE up-leg' if _ma_call else 'PE down-leg'} "
                                    f"· 20-EMA slope (sticky)"
                                )
                            ),
                            "regime": regime,
                            "entry": round(_ma_ltp, 2) if _ma_ltp else None,
                            "tp": None,
                            "sl": None,
                            "rr": 0.0,
                            "atm_strike": row.get("atm_strike"),
                            "atm_ce_ltp": ce_ltp,
                            "atm_pe_ltp": pe_ltp,
                            "atm_ce_security_id": row.get("atm_ce_security_id"),
                            "atm_pe_security_id": row.get("atm_pe_security_id"),
                            "spot_price": row.get("spot_price"),
                            "model_version": models.version,
                            "gate_mode": "ma_signal",
                            "direction": "GO_CALL" if _ma_call else "GO_PUT",
                        }
                        raw_logger.log(ma_signal_out)
                        _send_signal_to_tray(ma_signal_out)  # Mongo + WS (chart)
                        # MA-Signal Glide trades ride with NO auto-exit; they are
                        # closed ONLY here, on the leg-end EXIT.
                        #
                        # Close by POSITION (instrument + side), not by a
                        # remembered tradeId. One entry can create several trades
                        # (paper races strategies) and the id captured below is the
                        # first twin, not the Glide one — so closing by id left the
                        # Glide trade open forever. Position-close hits the right
                        # trade every time and survives a SEA restart (this
                        # in-memory `_ma_open` map does not).
                        if _ma_exit:
                            try:
                                from signal_engine_agent.risk_control_client import close_glide_position
                                # Same instrument string the entry stored (both
                                # go through `instrument.upper()`), so the server
                                # position-match is exact. Cohort-scoped
                                # (2026-08-13): the glide-only match left a
                                # ladder-strategy MA ride open past its ribbon
                                # exit (crude #19) — match by cohort like sma5,
                                # whatever strategy the ride runs.
                                close_glide_position(ma_signal_out["instrument"], _ma_side, cohort="ma_signal")
                            except Exception as exc:
                                print(f"  MA-Signal close error: {exc}", file=sys.stderr)
                            _ma_open.pop(_ma_side, None)  # tidy the (now unused) map
                        else:
                            _tid = _maybe_submit_ai_trade(ma_signal_out)
                            if _tid:
                                _ma_open[_ma_side] = _tid
                        ma_emitted += 1
                except Exception as exc:
                    # Never let the MA-Signal cohort crash the inference loop.
                    print(f"  MA-Signal error: {exc}", file=sys.stderr)

            # ── SMA-5 price-cross cohort (cohort="sma5_signal", 2026-08-05) ──
            # Independent of every gate above. Pure SMA-5-vs-close cross on the
            # underlying: LONG_CE when the close crosses ABOVE the line, LONG_PE
            # when it crosses BELOW; EXIT_* on the opposite cross closes the ride
            # (same close-by-position mechanism as MA-Signal). Symmetric CE/PE.
            if sma5_signal_detector is not None:
                try:
                    # Live-tunable reversal confirmation (candles) from the panel.
                    _s5c = _live_cohorts.get("sma5_confirm")
                    if _s5c is not None:
                        try:
                            sma5_signal_detector.confirm_candles = max(1, int(_s5c))
                        except (TypeError, ValueError):
                            pass
                    # Live-tunable line deadband (%) from the panel.
                    _s5b = _live_cohorts.get("sma5_buffer")
                    if _s5b is not None:
                        try:
                            sma5_signal_detector.buffer_pct = max(0.0, float(_s5b))
                        except (TypeError, ValueError):
                            pass
                    # Live-tunable entry-watch (candles) from the panel.
                    _s5w = _live_cohorts.get("sma5_entry_watch")
                    if _s5w is not None:
                        try:
                            sma5_signal_detector.entry_watch = max(0, int(_s5w))
                        except (TypeError, ValueError):
                            pass
                    # Live-tunable premium-confirm entry gate (on/off) from the panel.
                    _sma5_gate_on = bool(_live_cohorts.get("sma5_entry_gate"))
                    # Live candle timeframe (seconds) — detector + both premium SMA5s.
                    _s5cs = _live_cohorts.get("sma5_candle_sec")
                    if _s5cs is not None:
                        try:
                            _s5cs = int(_s5cs)
                            sma5_signal_detector.set_candle_sec(_s5cs)
                            sma5_prem_ce.set_candle_sec(_s5cs)
                            sma5_prem_pe.set_candle_sec(_s5cs)
                            if sma5_ribbon is not None:
                                sma5_ribbon.set_candle_sec(_s5cs)
                        except (TypeError, ValueError):
                            pass
                    _s5_ts = _finite(row.get("timestamp"))
                    _s5_spot = _finite(row.get("spot_price"))
                    # Keep the per-side premium SMA5s warm every row (continuous), so
                    # the entry gate can judge the moment a cross fires.
                    if _s5_ts is not None:
                        _pce = _finite(ce_ltp)
                        _ppe = _finite(pe_ltp)
                        if _pce is not None:
                            sma5_prem_ce.on_tick(_s5_ts, _pce)
                        if _ppe is not None:
                            sma5_prem_pe.on_tick(_s5_ts, _ppe)
                    if sma5_ribbon is not None:
                        # T163: events come from the locked-premium ribbons; the
                        # legacy premium-confirm entry gate is redundant there
                        # (the ribbon IS the premium's own judgment).
                        _sma5_gate_on = False
                        sma5_events = _rb_s5_events
                    else:
                        sma5_events = (
                            sma5_signal_detector.on_tick(_s5_ts, _s5_spot)
                            if _s5_ts is not None and _s5_spot is not None else []
                        )
                    # Entry-watch audit: print the detector's one-line transition
                    # note (armed / confirming N/M / entered / cancelled) so the
                    # deferred entry is visible in the SEA output. Only when the
                    # cohort is live, and only on the candle-close tick that set it.
                    _s5_note = getattr(sma5_signal_detector, "last_watch_note", None)
                    if _s5_note and _live_cohorts["sma5"]:
                        print(f"  [sma5 entry-watch] {instrument.upper()} {_s5_note}", flush=True)
                        _append_entrywatch_log(instrument, f"{instrument.upper()} {_s5_note}")
                    # Keep the detector FED even when toggled off (SMA stays
                    # current); just suppress the emit while off.
                    if not _live_cohorts["sma5"]:
                        sma5_events = []
                    for _ev in sma5_events:
                        _s5_call = "CE" in _ev
                        _s5_exit = _ev.startswith("EXIT")
                        _s5_side = "CE" if _s5_call else "PE"
                        # Ribbon mode prices off the LOCKED contract's premium
                        # (that IS what the signal watched); ATM is the fallback.
                        _s5_ltp = None
                        if sma5_ribbon is not None and premium_feed is not None:
                            _s5_ltp = _finite(premium_feed.last_ltp.get(_s5_side))
                        if _s5_ltp is None:
                            _s5_ltp = _finite(ce_ltp if _s5_call else pe_ltp)
                        # ENTRY GATE (option A) — skip a CE/PE entry whose premium is
                        # not above its OWN SMA5 (the premium doesn't confirm). Exits
                        # are never gated. Warmup returns confirmed, so it can't block
                        # early. One-shot: a skipped cross is simply not taken.
                        if (not _s5_exit) and _sma5_gate_on and _s5_ltp is not None:
                            _conf = (sma5_prem_ce if _s5_call else sma5_prem_pe).confirms(_s5_ltp)
                            if not _conf:
                                print(f"  [sma5 entry-gate] {instrument.upper()} {_s5_side} "
                                      f"skipped — premium {_s5_ltp} not above its SMA5", flush=True)
                                continue
                        sma5_signal_out = {
                            "timestamp": row.get("timestamp"),
                            "timestamp_ist": datetime.now(_IST).isoformat(timespec="milliseconds"),
                            "correlationId": uuid.uuid4().hex,
                            "instrument": instrument.upper(),
                            "action": _ev,
                            "cohort": "sma5_signal",
                            "reason": (
                                (
                                    f"SMA5 ribbon {'DOWN — exit' if _s5_exit else 'UP — enter'} "
                                    f"{_s5_side} (locked {premium_feed.strikes.get(_s5_side) or '?'} premium)"
                                )
                                if sma5_ribbon is not None and premium_feed is not None
                                else (
                                    f"SMA5 · {'exit' if _s5_exit else 'enter'} "
                                    f"{'CE (close above line)' if _s5_call else 'PE (close below line)'}"
                                )
                            ),
                            "regime": regime,
                            "entry": round(_s5_ltp, 2) if _s5_ltp else None,
                            "tp": None,
                            "sl": None,
                            "rr": 0.0,
                            "atm_strike": row.get("atm_strike"),
                            "atm_ce_ltp": ce_ltp,
                            "atm_pe_ltp": pe_ltp,
                            "atm_ce_security_id": row.get("atm_ce_security_id"),
                            "atm_pe_security_id": row.get("atm_pe_security_id"),
                            "spot_price": row.get("spot_price"),
                            "model_version": models.version,
                            "gate_mode": "sma5_signal",
                            "direction": "GO_CALL" if _s5_call else "GO_PUT",
                        }
                        raw_logger.log(sma5_signal_out)
                        _send_signal_to_tray(sma5_signal_out)  # Mongo + WS (chart)
                        if _s5_exit:
                            try:
                                from signal_engine_agent.risk_control_client import close_glide_position
                                # Match by COHORT so the cross closes the sma5 ride
                                # whatever strategy it runs (ladder) — not glide-only.
                                close_glide_position(sma5_signal_out["instrument"], _s5_side, cohort="sma5_signal")
                            except Exception as exc:
                                print(f"  SMA5 close error: {exc}", file=sys.stderr)
                            _sma5_open.pop(_s5_side, None)
                        else:
                            _tid = _maybe_submit_ai_trade(sma5_signal_out)
                            if _tid:
                                _sma5_open[_s5_side] = _tid
                except Exception as exc:
                    # Never let the SMA-5 cohort crash the inference loop.
                    print(f"  SMA5 error: {exc}", file=sys.stderr)

            # ── CandleBlue HH+HL structure cohort (cohort="candleblue") ──────
            # Pure swing structure on the LOCKED CE/PE premium candles (events
            # come from the drain above): LONG when a higher high AND a higher low
            # are both confirmed, EXIT on a lower high (or the hard stop under the
            # last higher low). Symmetric CE/PE. Fed even when off; emit suppressed.
            if candleblue_detector is not None:
                try:
                    _cbcs = _live_cohorts.get("candleblue_candle_sec")
                    if _cbcs is not None:
                        try:
                            candleblue_detector.set_candle_sec(int(_cbcs))
                        except (TypeError, ValueError):
                            pass
                    _cbsb = _live_cohorts.get("candleblue_stop_buffer")
                    if _cbsb is not None:
                        try:
                            candleblue_detector.set_stop_buffer(float(_cbsb))
                        except (TypeError, ValueError):
                            pass
                    cb_events = _rb_cb_events if _live_cohorts.get("candleblue") else []
                    for _ev in cb_events:
                        _cb_call = "CE" in _ev
                        _cb_exit = _ev.startswith("EXIT")
                        _cb_side = "CE" if _cb_call else "PE"
                        _cb_ltp = None
                        if premium_feed is not None:
                            _cb_ltp = _finite(premium_feed.last_ltp.get(_cb_side))
                        if _cb_ltp is None:
                            _cb_ltp = _finite(ce_ltp if _cb_call else pe_ltp)
                        candleblue_out = {
                            "timestamp": row.get("timestamp"),
                            "timestamp_ist": datetime.now(_IST).isoformat(timespec="milliseconds"),
                            "correlationId": uuid.uuid4().hex,
                            "instrument": instrument.upper(),
                            "action": _ev,
                            "cohort": "candleblue",
                            "reason": (
                                f"CandleBlue {'lower-high/stop — exit' if _cb_exit else 'HH+HL — enter'} "
                                f"{_cb_side} (locked {premium_feed.strikes.get(_cb_side) if premium_feed else '?'} premium)"
                            ),
                            "regime": regime,
                            "entry": round(_cb_ltp, 2) if _cb_ltp else None,
                            "tp": None,
                            "sl": None,
                            "rr": 0.0,
                            "atm_strike": row.get("atm_strike"),
                            "atm_ce_ltp": ce_ltp,
                            "atm_pe_ltp": pe_ltp,
                            "atm_ce_security_id": row.get("atm_ce_security_id"),
                            "atm_pe_security_id": row.get("atm_pe_security_id"),
                            "spot_price": row.get("spot_price"),
                            "model_version": models.version,
                            "gate_mode": "candleblue",
                            "direction": "GO_CALL" if _cb_call else "GO_PUT",
                        }
                        raw_logger.log(candleblue_out)
                        _send_signal_to_tray(candleblue_out)  # Mongo + WS (chart)
                        if _cb_exit:
                            try:
                                from signal_engine_agent.risk_control_client import close_glide_position
                                close_glide_position(candleblue_out["instrument"], _cb_side, cohort="candleblue")
                            except Exception as exc:
                                print(f"  CandleBlue close error: {exc}", file=sys.stderr)
                        else:
                            _maybe_submit_ai_trade(candleblue_out)
                except Exception as exc:
                    # Never let the CandleBlue cohort crash the inference loop.
                    print(f"  CandleBlue error: {exc}", file=sys.stderr)

            # ── CB2 (candleblue v2, cohort="cb2") — parallel A/B ─────────────
            # Same HH+HL structure as candleblue PLUS a range-position gate and a
            # 5-min default candle. Runs alongside candleblue on the same premium
            # feed (events from the drain above). Paper-only (pinned in discipline).
            if cb2_detector is not None:
                try:
                    _c2cs = _live_cohorts.get("cb2_candle_sec")
                    if _c2cs is not None:
                        try:
                            cb2_detector.set_candle_sec(int(_c2cs))
                        except (TypeError, ValueError):
                            pass
                    _c2sb = _live_cohorts.get("cb2_stop_buffer")
                    if _c2sb is not None:
                        try:
                            cb2_detector.set_stop_buffer(float(_c2sb))
                        except (TypeError, ValueError):
                            pass
                    _c2rp = _live_cohorts.get("cb2_min_range_pos")
                    if _c2rp is not None:
                        try:
                            cb2_detector.set_min_range_pos(float(_c2rp))
                        except (TypeError, ValueError):
                            pass
                    cb2_events = _rb_cb2_events if _live_cohorts.get("cb2") else []
                    for _ev in cb2_events:
                        _c2_call = "CE" in _ev
                        _c2_exit = _ev.startswith("EXIT")
                        _c2_side = "CE" if _c2_call else "PE"
                        _c2_ltp = None
                        if premium_feed is not None:
                            _c2_ltp = _finite(premium_feed.last_ltp.get(_c2_side))
                        if _c2_ltp is None:
                            _c2_ltp = _finite(ce_ltp if _c2_call else pe_ltp)
                        cb2_out = {
                            "timestamp": row.get("timestamp"),
                            "timestamp_ist": datetime.now(_IST).isoformat(timespec="milliseconds"),
                            "correlationId": uuid.uuid4().hex,
                            "instrument": instrument.upper(),
                            "action": _ev,
                            "cohort": "cb2",
                            "reason": (
                                f"CB2 {'lower-high/stop — exit' if _c2_exit else 'HH+HL+range — enter'} "
                                f"{_c2_side} (locked {premium_feed.strikes.get(_c2_side) if premium_feed else '?'} premium)"
                            ),
                            "regime": regime,
                            "entry": round(_c2_ltp, 2) if _c2_ltp else None,
                            "tp": None,
                            "sl": None,
                            "rr": 0.0,
                            "atm_strike": row.get("atm_strike"),
                            "atm_ce_ltp": ce_ltp,
                            "atm_pe_ltp": pe_ltp,
                            "atm_ce_security_id": row.get("atm_ce_security_id"),
                            "atm_pe_security_id": row.get("atm_pe_security_id"),
                            "spot_price": row.get("spot_price"),
                            "model_version": models.version,
                            "gate_mode": "cb2",
                            "direction": "GO_CALL" if _c2_call else "GO_PUT",
                        }
                        raw_logger.log(cb2_out)
                        _send_signal_to_tray(cb2_out)  # Mongo + WS (chart)
                        if _c2_exit:
                            try:
                                from signal_engine_agent.risk_control_client import close_glide_position
                                close_glide_position(cb2_out["instrument"], _c2_side, cohort="cb2")
                            except Exception as exc:
                                print(f"  CB2 close error: {exc}", file=sys.stderr)
                        else:
                            _maybe_submit_ai_trade(cb2_out)
                except Exception as exc:
                    # Never let the CB2 cohort crash the inference loop.
                    print(f"  CB2 error: {exc}", file=sys.stderr)

            # ── Filtered output ──
            # Log the failed-gate diagnostic line per spec §3
            # (filtered_signals.log). Only emit when prediction was
            # evaluable (i.e. we have a direction_prob_60s) — pure
            # noise rows are skipped. Wave-2 uses the 60s head; the 30s
            # head is always NaN, so guarding on it silently disabled the
            # scalp reject counter + filtered log (dashboard showed 0).
            if not np.isnan(preds["direction_prob_60s"]) and gate_reasons:
                # Dashboard: reject-by-reason tally (scalp cohort).
                dashboard.push_reject(cohort="scalp", reasons=list(gate_reasons))
                filtered_signals += 1
                would_be = "GO_CALL" if preds["direction_prob_60s"] > 0.5 else "GO_PUT"
                filtered_logger.log(
                    {
                        "timestamp": row.get("timestamp"),
                        "timestamp_ist": datetime.now(_IST).isoformat(timespec="milliseconds"),
                        "instrument": instrument.upper(),
                        "would_be_direction": would_be,
                        "fail_reasons": gate_reasons,
                        "direction_prob_30s": round(preds["direction_prob_60s"], 4),
                        "risk_reward_ratio_30s": round(preds["risk_reward_ratio_60s"], 4),
                        "upside_percentile_30s": round(preds["upside_percentile_30s"], 2),
                        "model_version": models.version,
                    }
                )

            # Periodic heartbeat (only when dashboard is disabled --
            # otherwise the dashboard's tick counter already shows this
            # information live, and writing '\r' into the alt-screen
            # would scramble the rendered frame).
            if not use_dashboard and processed % 500 == 0:
                elapsed = time.time() - started
                rate = processed / max(elapsed, 0.001)
                sys.stdout.write(
                    f"\r  [stats] ticks={processed:,}  "
                    f"raw={raw_signals}  filtered={filtered_signals}  "
                    f"rate={rate:.1f}/s"
                )
                sys.stdout.flush()
    except KeyboardInterrupt:
        print("\n  Stopping SEA...")
    finally:
        # Tear down alt-screen FIRST so subsequent prints (T41 finalise,
        # heartbeat stop, etc.) land on the primary screen instead of
        # scrambling the dashboard frame during exit.
        try:
            dashboard.__exit__(None, None, None)
        except Exception:
            pass
        _hb_stop.set()  # stop the liveness heartbeat thread
        raw_logger.close()
        filtered_logger.close()
        # T41: finalise the prediction log — merges in-progress chunks
        # into <inst>_predictions.parquet and deletes the chunks. Safe
        # to call on partial-day data; outcome_backfiller picks it up
        # post-session regardless.
        try:
            final_pred_path = prediction_logger.finalise()
            if final_pred_path is not None:
                print(f"  T41 predictions finalised -> {final_pred_path}")
        except Exception as exc:
            print(f"  T41 finalise error: {exc}", file=sys.stderr)


def main() -> int:
    p = argparse.ArgumentParser(prog="sea")
    p.add_argument(
        "--instrument", required=True, choices=("nifty50", "banknifty", "crudeoil", "naturalgas")
    )
    p.add_argument("--features-root", default="data/features")
    p.add_argument(
        "--config-dir",
        default="config/sea_thresholds",
        help="Per-instrument JSON thresholds dir (default config/sea_thresholds)",
    )
    p.add_argument(
        "--no-dashboard",
        action="store_true",
        help=(
            "Disable the rich live dashboard and fall back to the "
            "pre-2026-07-01 scrolling print stream. Use for debug "
            "sessions where you need to grep the output or run "
            "over SSH without a proper TTY."
        ),
    )
    p.add_argument(
        "--only-cohorts",
        default=None,
        help=(
            "Comma-separated cohort allowlist (scalp,trend,ma,sma5). Every "
            "other cohort is pinned OFF for this engine instance and global "
            "control-panel toggles cannot re-enable them. Used by the MCX "
            "engines, which run sma5 only (their scalp models are "
            "unvalidated stopgaps)."
        ),
    )
    p.add_argument(
        "--max-row-age",
        type=float,
        default=None,
        help=(
            "T70 staleness guard: skip rows whose tick timestamp is older "
            "than this many seconds. Default: env SEA_MAX_ROW_AGE_SEC if "
            "set, else 5.0. 0 disables. Backtests MUST pass 0 — "
            "backtest.py replays historical rows whose timestamps look "
            "stale to the guard."
        ),
    )
    args = p.parse_args()

    max_row_age = args.max_row_age
    if max_row_age is None:
        env_age = os.environ.get("SEA_MAX_ROW_AGE_SEC", "").strip()
        try:
            max_row_age = float(env_age) if env_age else 5.0
        except ValueError:
            max_row_age = 5.0

    only_cohorts = None
    if args.only_cohorts:
        # '+' or ',' both accepted — cmd.exe splits batch args on commas, so
        # the .bat launchers pass "sma5+ma" (see start-all.bat).
        only_cohorts = [c.strip() for c in args.only_cohorts.replace("+", ",").split(",") if c.strip()]

    run(
        args.instrument,
        features_root=Path(args.features_root),
        config_dir=Path(args.config_dir),
        use_dashboard=not args.no_dashboard,
        max_row_age_sec=max_row_age,
        only_cohorts=only_cohorts,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
