"""
tests/test_rollover_resolver.py — Phase E7 unit tests for the
near-month futures contract resolver.

Locks the rollover behaviour for both NSE FUTIDX (NIFTY/BANKNIFTY) and
MCX FUTCOM (CRUDEOIL/NATURALGAS) so any future refactor of
`main._resolve_near_month_contract` can't silently regress one
exchange while the other keeps passing. Also locks the new "fallback"
discriminator returned in the third tuple slot — the loud-fail path
in `main()` keys off it.

Run: python -m pytest python_modules/tick_feature_agent/tests/test_rollover_resolver.py -v
"""
from __future__ import annotations

import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent.parent  # python_modules/
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import pytest

from tick_feature_agent import main as tfa_main


# ── Profile stubs ─────────────────────────────────────────────────────────

def _nse_profile():
    p = MagicMock()
    p.exchange = "NSE"
    p.instrument_name = "NIFTY"
    p.underlying_security_id = "13"          # spot index id (stable)
    p.underlying_symbol = "NIFTY25APRFUT"    # stale FUT symbol from JSON
    p.ws_security_id = None
    return p


def _mcx_profile():
    p = MagicMock()
    p.exchange = "MCX"
    p.instrument_name = "CRUDEOIL"
    p.underlying_security_id = "486502"      # stale FUTCOM id (April expiry)
    p.underlying_symbol = "CRUDEOIL25APRFUT"
    p.ws_security_id = None
    return p


# ── HTTP response builders ────────────────────────────────────────────────

def _ok(payload: dict):
    r = MagicMock()
    r.status_code = 200
    r.json.return_value = payload
    return r


def _http_error(code: int = 500):
    r = MagicMock()
    r.status_code = code
    r.json.return_value = {}
    return r


def _make_get(expiry_payload: dict, lookup_payload: dict):
    """Returns a fake `requests.get` that switches on the URL path."""
    def _fake_get(url, **kwargs):
        if "expiry-list" in url:
            return _ok(expiry_payload)
        if "lookup" in url:
            return _ok(lookup_payload)
        raise AssertionError(f"Unexpected URL: {url}")
    return _fake_get


# ── NSE: nearest-future expiry is picked ──────────────────────────────────

def test_nse_resolver_picks_nearest_future_expiry():
    """Two FUTIDX expiries on offer (current + next month). Resolver
    must pick the chronologically nearest one whose date is >= today."""
    expiry_payload = {"data": ["2026-05-29", "2026-06-26"]}
    lookup_payload = {
        "success": True,
        "data": {"securityId": "70001", "tradingSymbol": "NIFTY25MAYFUT"},
    }
    fake_requests = types.SimpleNamespace(get=_make_get(expiry_payload, lookup_payload))

    with patch.object(tfa_main, "_authed_headers", return_value={}), \
         patch.dict("sys.modules", {"requests": fake_requests}):
        sec_id, symbol, source = tfa_main._resolve_near_month_contract(
            "http://localhost:3000", _nse_profile()
        )

    assert source == "scrip_master"
    assert sec_id == "70001"
    assert symbol == "NIFTY25MAYFUT"


def test_nse_resolver_skips_already_expired_dates():
    """Past expiries in the response must be filtered out before picking."""
    expiry_payload = {"data": ["2026-04-24", "2026-05-29", "2026-06-26"]}
    lookup_payload = {
        "success": True,
        "data": {"securityId": "70001", "tradingSymbol": "NIFTY25MAYFUT"},
    }

    captured_lookup_params: dict = {}

    def _fake_get(url, **kwargs):
        if "expiry-list" in url:
            return _ok(expiry_payload)
        if "lookup" in url:
            captured_lookup_params.update(kwargs.get("params") or {})
            return _ok(lookup_payload)
        raise AssertionError(url)

    fake_requests = types.SimpleNamespace(get=_fake_get)
    with patch.object(tfa_main, "_authed_headers", return_value={}), \
         patch.dict("sys.modules", {"requests": fake_requests}):
        sec_id, symbol, source = tfa_main._resolve_near_month_contract(
            "http://localhost:3000", _nse_profile()
        )

    assert source == "scrip_master"
    # Lookup call must have used 2026-05-29 (the first expiry >= today),
    # NOT the past 2026-04-24. Today is 2026-05-01 in this test context.
    assert captured_lookup_params.get("expiry") == "2026-05-29"


def test_nse_resolver_falls_back_when_expiry_list_404s():
    """Scrip-master endpoint returns 500 / 404 → fallback."""
    def _fake_get(url, **kwargs):
        return _http_error(500)
    fake_requests = types.SimpleNamespace(get=_fake_get)

    with patch.object(tfa_main, "_authed_headers", return_value={}), \
         patch.dict("sys.modules", {"requests": fake_requests}):
        sec_id, symbol, source = tfa_main._resolve_near_month_contract(
            "http://localhost:3000", _nse_profile()
        )

    assert source == "fallback"
    # NSE fallback id is the SPOT INDEX (13) — main() must halt rather
    # than subscribe to it, but the resolver itself just returns the
    # value with the fallback discriminator.
    assert sec_id == "13"
    assert symbol == "NIFTY25APRFUT"


def test_nse_resolver_falls_back_when_no_future_expiries():
    """Scrip-master returns only past dates (or empty). No usable
    contract → fallback."""
    expiry_payload = {"data": []}
    fake_requests = types.SimpleNamespace(
        get=_make_get(expiry_payload, {"success": True, "data": {}})
    )

    with patch.object(tfa_main, "_authed_headers", return_value={}), \
         patch.dict("sys.modules", {"requests": fake_requests}):
        sec_id, symbol, source = tfa_main._resolve_near_month_contract(
            "http://localhost:3000", _nse_profile()
        )

    assert source == "fallback"


def test_nse_resolver_falls_back_when_lookup_unsuccessful():
    """expiry-list works, lookup returns success=false → fallback."""
    expiry_payload = {"data": ["2026-05-29"]}
    lookup_payload = {"success": False, "data": {}}
    fake_requests = types.SimpleNamespace(
        get=_make_get(expiry_payload, lookup_payload)
    )

    with patch.object(tfa_main, "_authed_headers", return_value={}), \
         patch.dict("sys.modules", {"requests": fake_requests}):
        sec_id, symbol, source = tfa_main._resolve_near_month_contract(
            "http://localhost:3000", _nse_profile()
        )

    assert source == "fallback"


def test_nse_resolver_falls_back_when_security_id_blank():
    """Lookup succeeds but securityId is empty/missing → fallback."""
    expiry_payload = {"data": ["2026-05-29"]}
    lookup_payload = {"success": True,
                      "data": {"securityId": "", "tradingSymbol": "NIFTY25MAYFUT"}}
    fake_requests = types.SimpleNamespace(
        get=_make_get(expiry_payload, lookup_payload)
    )

    with patch.object(tfa_main, "_authed_headers", return_value={}), \
         patch.dict("sys.modules", {"requests": fake_requests}):
        _, _, source = tfa_main._resolve_near_month_contract(
            "http://localhost:3000", _nse_profile()
        )

    assert source == "fallback"


def test_nse_resolver_falls_back_on_network_exception():
    """`requests.get` raises (connection refused / timeout) → fallback."""
    def _boom(url, **kwargs):
        raise ConnectionError("simulated connection refused")
    fake_requests = types.SimpleNamespace(get=_boom)

    with patch.object(tfa_main, "_authed_headers", return_value={}), \
         patch.dict("sys.modules", {"requests": fake_requests}):
        _, _, source = tfa_main._resolve_near_month_contract(
            "http://localhost:3000", _nse_profile()
        )

    assert source == "fallback"


# ── MCX: nearest-future expiry is picked, instrumentName is FUTCOM ────────

def test_mcx_resolver_uses_futcom_instrument_type():
    """MCX must query scrip-master with instrumentName=FUTCOM (not FUTIDX)."""
    captured: dict = {}

    def _fake_get(url, **kwargs):
        captured.setdefault(url, []).append(kwargs.get("params") or {})
        if "expiry-list" in url:
            return _ok({"data": ["2026-05-19"]})
        if "lookup" in url:
            return _ok({"success": True,
                        "data": {"securityId": "490001",
                                 "tradingSymbol": "CRUDEOIL25MAYFUT"}})
        raise AssertionError(url)

    fake_requests = types.SimpleNamespace(get=_fake_get)
    with patch.object(tfa_main, "_authed_headers", return_value={}), \
         patch.dict("sys.modules", {"requests": fake_requests}):
        sec_id, symbol, source = tfa_main._resolve_near_month_contract(
            "http://localhost:3000", _mcx_profile()
        )

    assert source == "scrip_master"
    assert sec_id == "490001"
    assert symbol == "CRUDEOIL25MAYFUT"
    # Both calls must have used FUTCOM
    for url, calls in captured.items():
        for params in calls:
            assert params.get("instrumentName") == "FUTCOM", (
                f"MCX resolver used wrong instrumentName: {params}"
            )


def test_mcx_resolver_fallback_returns_stale_id_with_discriminator():
    """When MCX scrip-master fails, the fallback id is the LAST EXPIRED
    FUTCOM contract — the very thing the 2026-04-21 CRUDEOIL halt was
    caused by. The resolver returns it for backward compat, but the
    `'fallback'` discriminator forces main() to halt."""
    def _fake_get(url, **kwargs):
        return _http_error(500)
    fake_requests = types.SimpleNamespace(get=_fake_get)

    with patch.object(tfa_main, "_authed_headers", return_value={}), \
         patch.dict("sys.modules", {"requests": fake_requests}):
        sec_id, symbol, source = tfa_main._resolve_near_month_contract(
            "http://localhost:3000", _mcx_profile()
        )

    assert source == "fallback"
    assert sec_id == "486502"  # the stale April FUTCOM id
    assert symbol == "CRUDEOIL25APRFUT"


# ── NSE post-expiry rollover semantics ────────────────────────────────────

def test_nse_resolver_rolls_to_next_month_after_today_passes_current_expiry():
    """Day-of-expiry transition: today is the last day on which the
    'current' expiry is still future-dated. Once today moves past it,
    the resolver must pick the NEXT expiry (the rollover)."""
    # Two expiries: the first is in the past relative to "today" (2026-05-01),
    # so the resolver should pick the second one.
    expiry_payload = {"data": ["2026-04-24", "2026-05-29"]}
    lookup_payload = {"success": True,
                      "data": {"securityId": "70002",
                               "tradingSymbol": "NIFTY25MAYFUT"}}

    captured_lookup: dict = {}

    def _fake_get(url, **kwargs):
        if "expiry-list" in url:
            return _ok(expiry_payload)
        if "lookup" in url:
            captured_lookup.update(kwargs.get("params") or {})
            return _ok(lookup_payload)
        raise AssertionError(url)

    fake_requests = types.SimpleNamespace(get=_fake_get)
    with patch.object(tfa_main, "_authed_headers", return_value={}), \
         patch.dict("sys.modules", {"requests": fake_requests}):
        sec_id, symbol, source = tfa_main._resolve_near_month_contract(
            "http://localhost:3000", _nse_profile()
        )

    assert source == "scrip_master"
    assert sec_id == "70002"
    assert symbol == "NIFTY25MAYFUT"
    # The lookup must target the May expiry, not the April one.
    assert captured_lookup.get("expiry") == "2026-05-29"
