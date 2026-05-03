"""
Internal-API helpers for Python callers (B1).

Wraps `requests.get/post/etc.` so every call to the Node API
automatically includes the `X-Internal-Token` header read from
`INTERNAL_API_SECRET` env. If the secret is unset, the helper still
sends the request (header omitted) — matches the warn-only rollout
mode on the server.

Usage:
    from python_modules.internal_api import authed_get, authed_post

    resp = authed_get(f"{BROKER_URL}/api/broker/option-chain", params=...)
    resp = authed_post(f"{DASHBOARD_URL}/api/trading/heartbeat", json=...)
"""

from __future__ import annotations

import os
from typing import Any

import requests

HEADER = "X-Internal-Token"


def _auth_headers() -> dict[str, str]:
    secret = os.environ.get("INTERNAL_API_SECRET", "")
    return {HEADER: secret} if secret else {}


def _merge(headers: dict[str, str] | None) -> dict[str, str]:
    merged = dict(headers or {})
    merged.update(_auth_headers())
    return merged


def authed_get(url: str, **kwargs: Any) -> requests.Response:
    """requests.get with X-Internal-Token added (no-op if secret unset)."""
    kwargs["headers"] = _merge(kwargs.get("headers"))
    return requests.get(url, **kwargs)


def authed_post(url: str, **kwargs: Any) -> requests.Response:
    """requests.post with X-Internal-Token added (no-op if secret unset)."""
    kwargs["headers"] = _merge(kwargs.get("headers"))
    return requests.post(url, **kwargs)


def authed_put(url: str, **kwargs: Any) -> requests.Response:
    kwargs["headers"] = _merge(kwargs.get("headers"))
    return requests.put(url, **kwargs)


def authed_patch(url: str, **kwargs: Any) -> requests.Response:
    kwargs["headers"] = _merge(kwargs.get("headers"))
    return requests.patch(url, **kwargs)


def authed_delete(url: str, **kwargs: Any) -> requests.Response:
    kwargs["headers"] = _merge(kwargs.get("headers"))
    return requests.delete(url, **kwargs)
