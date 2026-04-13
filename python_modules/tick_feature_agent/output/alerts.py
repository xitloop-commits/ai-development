"""
output/alerts.py — Structured alert catalog with DA handshake (§1.3, spec §§1.4, 8.17).

Each alert:
  1. Builds the standard JSON envelope.
  2. Logs via tfa_logger at the correct severity.
  3. For CRITICAL/FATAL: fires a non-blocking HTTP POST to the DA endpoint
     (fire-and-forget — no retry, no ACK, TFA continues regardless).

Usage:

    from tick_feature_agent.output.alerts import AlertEmitter

    alerts = AlertEmitter(
        instrument="NIFTY",
        exchange="NSE",
        da_url="http://localhost:8765/tfa-alert",   # or None to disable DA handshake
    )

    alerts.expiry_rollover(old_expiry="2026-04-17", new_expiry="2026-04-24",
                           unsubscribed_strikes=98, subscribed_strikes=102)
    alerts.chain_unavailable()
    alerts.corrupt_chain_data(reason="strike_step_zero", detail="All strikes identical",
                              strike_count=5)

Alert catalog (spec §1.4, implementation plan Phase 11):

  Event                       Severity  DA POST
  ─────────────────────────────────────────────
  EXPIRY_ROLLOVER             CRITICAL  yes
  OUTAGE_WARM_UP_STARTING     CRITICAL  yes
  OUTAGE_WARM_UP_COMPLETE     CRITICAL  yes
  CHAIN_UNAVAILABLE           CRITICAL  yes
  CORRUPT_CHAIN_DATA          FATAL     yes
  SECURITY_ID_MISMATCH        FATAL     yes
  CHAIN_STALE                 WARN      no
  NEW_STRIKES_DETECTED        WARN      no
  DATA_QUALITY_CHANGE         INFO/WARN no
  UNDERLYING_SYMBOL_MISMATCH  WARN      no
  INSTRUMENT_PROFILE_MISMATCH WARN      no
  PERFORMANCE_DEGRADED        WARN      no
  CLOCK_SKEW_DETECTED         WARN      no
  CONSUMER_OVERFLOW           WARN      no
"""

from __future__ import annotations

import json
import threading
import urllib.request
from datetime import datetime, timezone, timedelta
from typing import Any

_IST = timezone(timedelta(hours=5, minutes=30))


# ── Severity constants ────────────────────────────────────────────────────────

INFO     = "INFO"
WARN     = "WARN"
CRITICAL = "CRITICAL"
FATAL    = "FATAL"

# Severities that trigger a DA handshake
_DA_SEVERITIES = {CRITICAL, FATAL}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(_IST).isoformat(timespec="milliseconds")


def _build_envelope(
    event_type: str,
    severity: str,
    instrument: str,
    exchange: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "event_type": event_type,
        "severity":   severity,
        "timestamp":  _now_iso(),
        "instrument": instrument,
        "exchange":   exchange,
        "payload":    payload,
    }


# ── DA handshake ──────────────────────────────────────────────────────────────

def _post_to_da(url: str, envelope: dict[str, Any]) -> None:
    """
    Fire-and-forget HTTP POST to Decision Agent.
    Called in a daemon thread — never blocks the tick event loop.
    Spec §1.3: DA handshake is advisory.  No retry.  TFA continues regardless.
    """
    try:
        data = json.dumps(envelope).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=2) as _:
            pass
    except Exception:
        pass  # DA unreachable — swallow silently per spec §1.3


# ── AlertEmitter ──────────────────────────────────────────────────────────────

class AlertEmitter:
    """
    Emit structured alerts, log them, and optionally notify the DA.

    Args:
        instrument:  Instrument name for envelope (e.g. "NIFTY").
        exchange:    Exchange name for envelope (e.g. "NSE").
        da_url:      Full URL for DA HTTP POST, or None to disable DA handshake.
        logger:      Optional TFALogger instance.  If None, alerts are emitted
                     without logging (useful in tests).
    """

    def __init__(
        self,
        instrument: str,
        exchange: str,
        da_url: str | None = None,
        logger: Any = None,
    ) -> None:
        self.instrument = instrument
        self.exchange   = exchange
        self.da_url     = da_url
        self._log       = logger

    # ── Internal dispatch ─────────────────────────────────────────────────────

    def _emit(
        self,
        event_type: str,
        severity: str,
        payload: dict[str, Any],
        msg: str = "",
    ) -> dict[str, Any]:
        """Build envelope, log it, fire DA POST if needed.  Returns envelope."""
        envelope = _build_envelope(
            event_type, severity, self.instrument, self.exchange, payload
        )

        # Log
        if self._log is not None:
            if severity in (FATAL,):
                self._log.error(event_type, msg=msg or event_type, **payload)
            elif severity == CRITICAL:
                self._log.warn(event_type, msg=msg or event_type, **payload)
            elif severity == WARN:
                self._log.warn(event_type, msg=msg or event_type, **payload)
            else:
                self._log.info(event_type, msg=msg or event_type, **payload)

        # DA handshake (CRITICAL / FATAL only)
        if severity in _DA_SEVERITIES and self.da_url:
            t = threading.Thread(
                target=_post_to_da,
                args=(self.da_url, envelope),
                daemon=True,
            )
            t.start()

        return envelope

    # ── Alert methods ─────────────────────────────────────────────────────────

    def expiry_rollover(
        self,
        *,
        old_expiry: str,
        new_expiry: str,
        unsubscribed_strikes: int = 0,
        subscribed_strikes: int = 0,
        buffers_cleared: bool = True,
    ) -> dict[str, Any]:
        """CRITICAL — Active expiry changed; TFA auto-re-subscribes."""
        return self._emit(
            "EXPIRY_ROLLOVER", CRITICAL,
            payload={
                "old_expiry":           old_expiry,
                "new_expiry":           new_expiry,
                "unsubscribed_strikes": unsubscribed_strikes,
                "subscribed_strikes":   subscribed_strikes,
                "buffers_cleared":      buffers_cleared,
            },
        )

    def outage_warm_up_starting(
        self,
        *,
        reason: str,
        warm_up_duration_sec: int,
        warm_up_end_time: str,
        last_tick_time: str,
    ) -> dict[str, Any]:
        """CRITICAL — Feed stale; TFA enters warm-up; DA must pause trades."""
        return self._emit(
            "OUTAGE_WARM_UP_STARTING", CRITICAL,
            payload={
                "reason":               reason,
                "warm_up_duration_sec": warm_up_duration_sec,
                "warm_up_end_time":     warm_up_end_time,
                "instruction":          "DA_PAUSE_TRADES",
                "last_tick_time":       last_tick_time,
            },
        )

    def outage_warm_up_complete(
        self,
        *,
        duration_sec: float,
        underlying_buffer_ticks: int = 0,
        option_buffers_warm: bool = True,
        chain_age_sec: float = 0.0,
    ) -> dict[str, Any]:
        """CRITICAL — Warm-up done; buffers ready; DA must resume trades."""
        return self._emit(
            "OUTAGE_WARM_UP_COMPLETE", CRITICAL,
            payload={
                "instruction":  "DA_RESUME_TRADES",
                "duration_sec": round(duration_sec, 3),
                "buffers_status": {
                    "underlying_buffer_ticks": underlying_buffer_ticks,
                    "option_buffers_warm":     option_buffers_warm,
                    "chain_age_sec":           chain_age_sec,
                },
            },
        )

    def chain_unavailable(self) -> dict[str, Any]:
        """CRITICAL — Chain REST API exhausted all retries; TFA halts."""
        return self._emit(
            "CHAIN_UNAVAILABLE", CRITICAL,
            payload={},
            msg="Chain fetch failed after all retries — TFA halting",
        )

    def corrupt_chain_data(
        self,
        *,
        reason: str,
        detail: str = "",
        strike_count: int = 0,
    ) -> dict[str, Any]:
        """FATAL — Chain validation failed critically; TFA halts immediately."""
        return self._emit(
            "CORRUPT_CHAIN_DATA", FATAL,
            payload={
                "reason":       reason,
                "detail":       detail,
                "strike_count": strike_count,
            },
        )

    def security_id_mismatch(
        self,
        *,
        profile_security_id: str,
        api_security_id: str,
    ) -> dict[str, Any]:
        """FATAL — Profile underlying_security_id ≠ chain API at startup; TFA halts."""
        return self._emit(
            "SECURITY_ID_MISMATCH", FATAL,
            payload={
                "profile_security_id": profile_security_id,
                "api_security_id":     api_security_id,
            },
        )

    def chain_stale(
        self,
        *,
        last_chain_timestamp: str,
        time_since_chain_sec: float,
        data_quality_flag: int = 0,
    ) -> dict[str, Any]:
        """WARN — No chain snapshot received within staleness threshold (30 s)."""
        return self._emit(
            "CHAIN_STALE", WARN,
            payload={
                "last_chain_timestamp": last_chain_timestamp,
                "time_since_chain_sec": time_since_chain_sec,
                "data_quality_flag":    data_quality_flag,
            },
        )

    def new_strikes_detected(
        self,
        *,
        new_strikes: list[int],
        option_types: list[str] | None = None,
        subscribed: bool = True,
        chain_size_before: int = 0,
        chain_size_after: int = 0,
    ) -> dict[str, Any]:
        """WARN — Chain snapshot contains new strikes not previously seen."""
        return self._emit(
            "NEW_STRIKES_DETECTED", WARN,
            payload={
                "new_strikes":       new_strikes,
                "option_types":      option_types or ["CE", "PE"],
                "subscribed":        subscribed,
                "chain_size_before": chain_size_before,
                "chain_size_after":  chain_size_after,
            },
        )

    def data_quality_change(
        self,
        *,
        from_flag: int,
        to_flag: int,
        reason: str,
    ) -> dict[str, Any]:
        """INFO (0→1) or WARN (1→0) — data_quality_flag transition."""
        sev = INFO if to_flag == 1 else WARN
        return self._emit(
            "DATA_QUALITY_CHANGE", sev,
            payload={"from": from_flag, "to": to_flag, "reason": reason},
        )

    def underlying_symbol_mismatch(
        self,
        *,
        expected_security_id: str,
        received_security_id: str,
    ) -> dict[str, Any]:
        """WARN — Tick security_id ≠ profile underlying_security_id."""
        return self._emit(
            "UNDERLYING_SYMBOL_MISMATCH", WARN,
            payload={
                "expected_security_id": expected_security_id,
                "received_security_id": received_security_id,
            },
        )

    def instrument_profile_mismatch(
        self,
        *,
        field: str,
        expected: Any,
        actual: Any,
    ) -> dict[str, Any]:
        """WARN — Runtime state conflicts with Instrument Profile values."""
        return self._emit(
            "INSTRUMENT_PROFILE_MISMATCH", WARN,
            payload={"field": field, "expected": expected, "actual": actual},
        )

    def performance_degraded(
        self,
        *,
        avg_us: float,
        budget_us: float,
    ) -> dict[str, Any]:
        """WARN — Rolling 1000-tick avg latency exceeds per-tick budget."""
        return self._emit(
            "PERFORMANCE_DEGRADED", WARN,
            payload={
                "avg_tick_latency_ms":  round(avg_us / 1000, 6),
                "budget_ms":            round(budget_us / 1000, 6),
            },
        )

    def clock_skew_detected(
        self,
        *,
        chain_timestamp: str,
        tick_time: str,
        skew_sec: float,
    ) -> dict[str, Any]:
        """WARN — chain_timestamp > tick_time by more than 2 s."""
        return self._emit(
            "CLOCK_SKEW_DETECTED", WARN,
            payload={
                "chain_timestamp": chain_timestamp,
                "tick_time":       tick_time,
                "skew_sec":        round(skew_sec, 3),
                "action":          "rejected_snapshot_using_previous",
            },
        )

    def consumer_overflow(self, *, socket_drops: int = 0) -> dict[str, Any]:
        """WARN — ML consumer socket send buffer exhausted; row dropped."""
        return self._emit(
            "CONSUMER_OVERFLOW", WARN,
            payload={"socket_drops": socket_drops},
        )
