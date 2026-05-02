"""
tests/test_alerts.py — Unit tests for output/alerts.py (Phase 11).

Run: python -m pytest python_modules/tick_feature_agent/tests/test_alerts.py -v
"""

from __future__ import annotations

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent.output.alerts import (
    _DA_SEVERITIES,
    CRITICAL,
    FATAL,
    INFO,
    WARN,
    AlertEmitter,
    _build_envelope,
)

# ── Helpers ────────────────────────────────────────────────────────────────────


def _emitter(da_url=None, logger=None):
    return AlertEmitter(
        instrument="NIFTY",
        exchange="NSE",
        da_url=da_url,
        logger=logger,
    )


# ══════════════════════════════════════════════════════════════════════════════
# TestBuildEnvelope
# ══════════════════════════════════════════════════════════════════════════════


class TestBuildEnvelope:

    def test_keys_present(self):
        env = _build_envelope("TEST", INFO, "NIFTY", "NSE", {})
        assert set(env.keys()) == {
            "event_type",
            "severity",
            "timestamp",
            "instrument",
            "exchange",
            "payload",
        }

    def test_event_type(self):
        env = _build_envelope("FOO", WARN, "NIFTY", "NSE", {})
        assert env["event_type"] == "FOO"

    def test_severity(self):
        env = _build_envelope("FOO", CRITICAL, "NIFTY", "NSE", {})
        assert env["severity"] == CRITICAL

    def test_payload_passed_through(self):
        env = _build_envelope("FOO", INFO, "NIFTY", "NSE", {"k": "v"})
        assert env["payload"] == {"k": "v"}

    def test_timestamp_is_iso_string(self):
        env = _build_envelope("FOO", INFO, "NIFTY", "NSE", {})
        ts = env["timestamp"]
        assert isinstance(ts, str)
        assert "T" in ts and "+" in ts  # ISO format with timezone


# ══════════════════════════════════════════════════════════════════════════════
# TestDASeverities
# ══════════════════════════════════════════════════════════════════════════════


class TestDASeverities:

    def test_critical_in_da_severities(self):
        assert CRITICAL in _DA_SEVERITIES

    def test_fatal_in_da_severities(self):
        assert FATAL in _DA_SEVERITIES

    def test_warn_not_in_da_severities(self):
        assert WARN not in _DA_SEVERITIES

    def test_info_not_in_da_severities(self):
        assert INFO not in _DA_SEVERITIES


# ══════════════════════════════════════════════════════════════════════════════
# TestAlertEnvelopes
# ══════════════════════════════════════════════════════════════════════════════


class TestAlertEnvelopes:

    def test_expiry_rollover_severity(self):
        env = _emitter().expiry_rollover(
            old_expiry="2026-04-17",
            new_expiry="2026-04-24",
        )
        assert env["severity"] == CRITICAL

    def test_expiry_rollover_payload(self):
        env = _emitter().expiry_rollover(
            old_expiry="2026-04-17",
            new_expiry="2026-04-24",
            unsubscribed_strikes=98,
            subscribed_strikes=102,
            buffers_cleared=True,
        )
        p = env["payload"]
        assert p["old_expiry"] == "2026-04-17"
        assert p["new_expiry"] == "2026-04-24"
        assert p["unsubscribed_strikes"] == 98
        assert p["subscribed_strikes"] == 102

    def test_outage_warm_up_starting_severity(self):
        env = _emitter().outage_warm_up_starting(
            reason="UNDERLYING_STALE",
            warm_up_duration_sec=15,
            warm_up_end_time="2026-04-13T09:15:50+05:30",
            last_tick_time="2026-04-13T09:15:35+05:30",
        )
        assert env["severity"] == CRITICAL

    def test_outage_warm_up_starting_instruction(self):
        env = _emitter().outage_warm_up_starting(
            reason="UNDERLYING_STALE",
            warm_up_duration_sec=15,
            warm_up_end_time="2026-04-13T09:15:50+05:30",
            last_tick_time="2026-04-13T09:15:35+05:30",
        )
        assert env["payload"]["instruction"] == "DA_PAUSE_TRADES"

    def test_outage_warm_up_complete_instruction(self):
        env = _emitter().outage_warm_up_complete(duration_sec=15.2)
        assert env["payload"]["instruction"] == "DA_RESUME_TRADES"
        assert env["severity"] == CRITICAL

    def test_chain_unavailable_severity(self):
        env = _emitter().chain_unavailable()
        assert env["severity"] == CRITICAL
        assert env["event_type"] == "CHAIN_UNAVAILABLE"

    def test_corrupt_chain_data_severity(self):
        env = _emitter().corrupt_chain_data(
            reason="strike_step_zero", detail="All identical", strike_count=5
        )
        assert env["severity"] == FATAL

    def test_corrupt_chain_data_payload(self):
        env = _emitter().corrupt_chain_data(
            reason="strike_step_zero", detail="All identical", strike_count=5
        )
        p = env["payload"]
        assert p["reason"] == "strike_step_zero"
        assert p["strike_count"] == 5

    def test_security_id_mismatch_severity(self):
        env = _emitter().security_id_mismatch(profile_security_id="1001", api_security_id="9999")
        assert env["severity"] == FATAL

    def test_chain_stale_severity(self):
        env = _emitter().chain_stale(
            last_chain_timestamp="2026-04-13T09:14:58+05:30",
            time_since_chain_sec=35.0,
        )
        assert env["severity"] == WARN

    def test_new_strikes_default_option_types(self):
        env = _emitter().new_strikes_detected(new_strikes=[23100, 23150])
        assert env["payload"]["option_types"] == ["CE", "PE"]

    def test_data_quality_change_0_to_1_is_info(self):
        env = _emitter().data_quality_change(from_flag=0, to_flag=1, reason="buffers_full")
        assert env["severity"] == INFO

    def test_data_quality_change_1_to_0_is_warn(self):
        env = _emitter().data_quality_change(from_flag=1, to_flag=0, reason="chain_stale")
        assert env["severity"] == WARN

    def test_performance_degraded_severity(self):
        env = _emitter().performance_degraded(avg_us=45.0, budget_us=20.0)
        assert env["severity"] == WARN

    def test_performance_degraded_ms_conversion(self):
        """µs values are converted to ms in payload."""
        env = _emitter().performance_degraded(avg_us=45000.0, budget_us=20000.0)
        assert env["payload"]["avg_tick_latency_ms"] == pytest.approx(45.0)
        assert env["payload"]["budget_ms"] == pytest.approx(20.0)

    def test_clock_skew_severity(self):
        env = _emitter().clock_skew_detected(
            chain_timestamp="2026-04-13T09:32:05+05:30",
            tick_time="2026-04-13T09:32:01+05:30",
            skew_sec=3.9,
        )
        assert env["severity"] == WARN

    def test_clock_skew_action_field(self):
        env = _emitter().clock_skew_detected(
            chain_timestamp="2026-04-13T09:32:05+05:30",
            tick_time="2026-04-13T09:32:01+05:30",
            skew_sec=3.9,
        )
        assert env["payload"]["action"] == "rejected_snapshot_using_previous"

    def test_consumer_overflow_severity(self):
        env = _emitter().consumer_overflow(socket_drops=3)
        assert env["severity"] == WARN

    def test_instrument_profile_mismatch_severity(self):
        env = _emitter().instrument_profile_mismatch(
            field="session_end", expected="15:30:00", actual="15:29:00"
        )
        assert env["severity"] == WARN

    def test_underlying_symbol_mismatch_severity(self):
        env = _emitter().underlying_symbol_mismatch(
            expected_security_id="1001", received_security_id="2002"
        )
        assert env["severity"] == WARN

    def test_instrument_and_exchange_in_envelope(self):
        em = AlertEmitter(instrument="CRUDEOIL", exchange="MCX")
        env = em.chain_stale(
            last_chain_timestamp="2026-04-13T09:00:00+05:30",
            time_since_chain_sec=31.0,
        )
        assert env["instrument"] == "CRUDEOIL"
        assert env["exchange"] == "MCX"


# ══════════════════════════════════════════════════════════════════════════════
# TestLogging
# ══════════════════════════════════════════════════════════════════════════════


class TestLogging:

    def test_warn_alert_calls_log_warn(self):
        mock_log = MagicMock()
        em = _emitter(logger=mock_log)
        em.clock_skew_detected(chain_timestamp="ts", tick_time="ts", skew_sec=3.0)
        mock_log.warn.assert_called_once()

    def test_critical_alert_calls_log_warn(self):
        """CRITICAL uses log.warn() — no log.critical() in TFALogger."""
        mock_log = MagicMock()
        em = _emitter(logger=mock_log)
        em.chain_unavailable()
        mock_log.warn.assert_called_once()

    def test_fatal_alert_calls_log_error(self):
        mock_log = MagicMock()
        # Patch sys.exit so the process doesn't actually exit during the test
        mock_log.error.side_effect = lambda *a, **kw: None
        em = _emitter(logger=mock_log)
        em.corrupt_chain_data(reason="test", strike_count=3)
        mock_log.error.assert_called_once()

    def test_info_alert_calls_log_info(self):
        mock_log = MagicMock()
        em = _emitter(logger=mock_log)
        em.data_quality_change(from_flag=0, to_flag=1, reason="buffers_full")
        mock_log.info.assert_called_once()

    def test_no_log_no_error(self):
        """AlertEmitter without logger should not raise."""
        em = _emitter(logger=None)
        env = em.chain_stale(last_chain_timestamp="ts", time_since_chain_sec=31.0)
        assert env["event_type"] == "CHAIN_STALE"


# ══════════════════════════════════════════════════════════════════════════════
# TestDAHandshake
# ══════════════════════════════════════════════════════════════════════════════


class TestDAHandshake:

    def test_warn_alert_no_da_post(self):
        """WARN severity → no thread spawned for DA handshake."""
        with patch("tick_feature_agent.output.alerts.threading.Thread") as mock_thread:
            em = _emitter(da_url="http://localhost:9999/alert")
            em.chain_stale(last_chain_timestamp="ts", time_since_chain_sec=31.0)
            mock_thread.assert_not_called()

    def test_critical_alert_spawns_da_thread(self):
        """CRITICAL → daemon thread started for DA POST."""
        with patch("tick_feature_agent.output.alerts.threading.Thread") as mock_thread:
            mock_t = MagicMock()
            mock_thread.return_value = mock_t
            em = _emitter(da_url="http://localhost:9999/alert")
            em.chain_unavailable()
            mock_thread.assert_called_once()
            mock_t.start.assert_called_once()

    def test_fatal_alert_spawns_da_thread(self):
        """FATAL → daemon thread started."""
        with patch("tick_feature_agent.output.alerts.threading.Thread") as mock_thread:
            mock_t = MagicMock()
            mock_thread.return_value = mock_t
            mock_log = MagicMock()
            mock_log.error.side_effect = lambda *a, **kw: None
            em = _emitter(da_url="http://localhost:9999/alert", logger=mock_log)
            em.corrupt_chain_data(reason="test", strike_count=1)
            mock_thread.assert_called_once()
            mock_t.start.assert_called_once()

    def test_critical_no_da_url_no_thread(self):
        """CRITICAL with no da_url → no thread spawned."""
        with patch("tick_feature_agent.output.alerts.threading.Thread") as mock_thread:
            em = _emitter(da_url=None)
            em.chain_unavailable()
            mock_thread.assert_not_called()

    def test_da_thread_is_daemon(self):
        """Thread must be a daemon so it doesn't block process exit."""
        spawned_kwargs = {}

        def capture_thread(*args, **kwargs):
            spawned_kwargs.update(kwargs)
            t = MagicMock()
            t.start = MagicMock()
            return t

        with patch("tick_feature_agent.output.alerts.threading.Thread", side_effect=capture_thread):
            em = _emitter(da_url="http://localhost:9999/alert")
            em.chain_unavailable()

        assert spawned_kwargs.get("daemon") is True

    def test_unreachable_da_does_not_raise(self):
        """
        If DA is unreachable, the POST silently fails.
        We run the actual post function in a thread against a bad URL.
        """
        from tick_feature_agent.output.alerts import _post_to_da

        envelope = {"event_type": "TEST"}
        # Should not raise — swallowed internally
        _post_to_da("http://localhost:1/nonexistent", envelope)

    def test_da_receives_correct_envelope(self):
        """
        Spin up a tiny HTTP server, emit a CRITICAL alert,
        and verify the envelope arrives with correct content.
        """
        received: list[dict] = []
        threading.Event()

        class _Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length)
                received.append(json.loads(body))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), _Handler)
        port = server.server_address[1]
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()

        try:
            em = AlertEmitter(
                instrument="NIFTY",
                exchange="NSE",
                da_url=f"http://127.0.0.1:{port}/alert",
            )
            em.chain_unavailable()
            # Give background thread time to deliver
            deadline = time.time() + 3.0
            while not received and time.time() < deadline:
                time.sleep(0.05)

            assert len(received) == 1
            env = received[0]
            assert env["event_type"] == "CHAIN_UNAVAILABLE"
            assert env["severity"] == CRITICAL
            assert env["instrument"] == "NIFTY"
        finally:
            server.shutdown()
