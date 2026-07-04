"""
_shared/feature_stream.py — feature-row socket transport settings.

Single source of truth for the per-instrument localhost TCP port that
carries live feature rows from TFA (producer, connects out) to SEA
(consumer, listens). Both agents import this module so the two sides
can never drift.

Latency context (2026-07-03): TFA historically published rows only via
data/features/{instrument}_live.ndjson, which SEA tail-polls every
0.2s. The socket path removes that poll delay; the ndjson file remains
as the fallback transport + the UI/health data source.

Override per instrument with the env var FEATURE_SOCKET_PORT (used by
tests and by any non-standard multi-instance setup).
"""

from __future__ import annotations

import os

# Fixed localhost ports, one per instrument. Chosen in an unassigned
# private range; keep in sync with startup/start-tfa.bat comments.
_PORTS: dict[str, int] = {
    "nifty50": 7761,
    "banknifty": 7762,
    "crudeoil": 7763,
    "naturalgas": 7764,
}

FEATURE_SOCKET_HOST = "127.0.0.1"


def feature_socket_port(instrument: str) -> int | None:
    """Return the feature-stream TCP port for `instrument`.

    Env var FEATURE_SOCKET_PORT (if set) wins — "0" disables the socket
    path entirely (file-only mode). Unknown instruments return None so
    callers fall back to file-only transport instead of crashing.
    """
    env = os.environ.get("FEATURE_SOCKET_PORT")
    if env is not None:
        try:
            port = int(env)
        except ValueError:
            return None
        return port if port > 0 else None
    return _PORTS.get(instrument)