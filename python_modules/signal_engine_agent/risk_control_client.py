"""
SEA → Node trade-pipeline HTTP client.

Two endpoints:

    submit_new_trade(payload) → POST /api/discipline/validateTrade
        New-trade signal. Server-side chain runs DA pre-trade gate →
        RCA evaluate → TEA submitTrade in one round-trip. Returns the
        final decision + trade id (when APPROVE'd).

    send_ai_signal(instrument, signal, ...) → POST /api/risk-control/ai-signal
        Continuous-analysis signal on existing positions. Server-side
        RCA validates against current position state, then forwards
        EXIT to TEA.exitTrade or MODIFY_SL/TP to TEA.modifyOrder.

Auth: every call carries the X-Internal-Token header (B1). Secret is
read from INTERNAL_API_SECRET env per python_modules.internal_api.

Logging: structured per-call — request_id (echo of executionId),
decision, latency, blockedBy reasons. Operator can grep
SEA_TRADE_PIPELINE in stdout.

Failure modes:
- HTTP 4xx (zod validation rejects): logged + caller gets the JSON body
- HTTP 5xx (server error): logged with status + body
- Connection failure: logged + caller gets a Python exception. SEA
  callers catch + skip; the next signal will retry.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, TypedDict

try:
    import requests
except ImportError:  # pragma: no cover
    raise ImportError("requests package not installed. Run: pip install requests")

logger = logging.getLogger("SEA_TRADE_PIPELINE")
logger.setLevel(logging.INFO)


# ─── Public types ────────────────────────────────────────────────


class ValidateTradeResponse(TypedDict, total=False):
    success: bool
    stage: str
    decision: str
    blockedBy: list[str]
    warnings: list[str]
    reason: str | None
    tradeId: str | None
    orderId: str | None
    status: str | None


class AiSignalResponse(TypedDict, total=False):
    success: bool
    data: dict[str, Any]
    error: str | None


# ─── Helpers ─────────────────────────────────────────────────────


def _headers() -> dict[str, str]:
    """Auth header (B1). Empty when secret unset → server runs warn-only."""
    secret = os.environ.get("INTERNAL_API_SECRET", "")
    return (
        {"X-Internal-Token": secret, "Content-Type": "application/json"}
        if secret
        else {"Content-Type": "application/json"}
    )


def _broker_url() -> str:
    return os.environ.get("BROKER_URL", "http://localhost:3000")


def _log_call(endpoint: str, request_id: str, decision: str, dt_ms: float, extra: str = "") -> None:
    logger.info(
        "endpoint=%s request_id=%s decision=%s dt_ms=%.1f%s",
        endpoint,
        request_id,
        decision,
        dt_ms,
        f" {extra}" if extra else "",
    )


# ─── /api/discipline/validateTrade ──────────────────────────────


def submit_new_trade(payload: dict[str, Any], timeout: float = 10.0) -> ValidateTradeResponse:
    """
    POST a new-trade signal through the full DA → RCA → TEA chain.

    payload shape (matches server/discipline/routes.ts validateTradeSchema):
        executionId, channel, origin,
        instrument, exchange, transactionType, optionType, strike,
        entryPrice, quantity, estimatedValue,
        stopLoss, takeProfit, capitalPercent?,
        aiConfidence?, aiRiskReward?, emotionalState?,
        currentCapital, currentExposure
    """
    url = f"{_broker_url()}/api/discipline/validateTrade"
    request_id = str(payload.get("executionId", "?"))
    t0 = time.monotonic()

    try:
        resp = requests.post(url, headers=_headers(), data=json.dumps(payload), timeout=timeout)
    except requests.RequestException as exc:
        dt = (time.monotonic() - t0) * 1000.0
        logger.error(
            "validateTrade connect failed request_id=%s dt_ms=%.1f exc=%s", request_id, dt, exc
        )
        raise

    dt = (time.monotonic() - t0) * 1000.0

    if resp.status_code >= 500:
        logger.error(
            "validateTrade server-error status=%s request_id=%s dt_ms=%.1f body=%s",
            resp.status_code,
            request_id,
            dt,
            resp.text[:300],
        )
        return {"success": False, "stage": "ERROR", "decision": "ERROR", "reason": resp.text[:200]}

    if resp.status_code >= 400:
        # zod validation rejection from B8 — body shape didn't match
        logger.warning(
            "validateTrade bad-request status=%s request_id=%s dt_ms=%.1f body=%s",
            resp.status_code,
            request_id,
            dt,
            resp.text[:300],
        )
        return {
            "success": False,
            "stage": "BAD_REQUEST",
            "decision": "REJECT",
            "reason": resp.text[:200],
        }

    body: ValidateTradeResponse = resp.json()
    decision = body.get("decision", "?")
    extra = ""
    if not body.get("success") and body.get("blockedBy"):
        extra = f"blocked_by={','.join(body['blockedBy'])}"
    elif body.get("tradeId"):
        extra = f"trade_id={body['tradeId']}"
    _log_call("validateTrade", request_id, decision, dt, extra)
    return body


# ─── /api/risk-control/ai-signal ────────────────────────────────


def send_ai_signal(
    instrument: str,
    signal: str,
    *,
    new_price: float | None = None,
    confidence: float | None = None,
    detail: str | None = None,
    timeout: float = 5.0,
) -> AiSignalResponse:
    """
    Send a continuous-analysis signal on EXISTING positions.

    signal = "EXIT" | "MODIFY_SL" | "MODIFY_TP"
    new_price required when signal is MODIFY_SL or MODIFY_TP.

    RCA-side validates against current position state before forwarding
    to TEA. No-op when no open position matches the instrument.
    """
    if signal not in ("EXIT", "MODIFY_SL", "MODIFY_TP"):
        raise ValueError(f"invalid signal: {signal}")
    if signal != "EXIT" and new_price is None:
        raise ValueError(f"newPrice required for {signal}")

    url = f"{_broker_url()}/api/risk-control/ai-signal"
    payload: dict[str, Any] = {"instrument": instrument, "signal": signal}
    if new_price is not None:
        payload["newPrice"] = new_price
    if confidence is not None:
        payload["confidence"] = confidence
    if detail is not None:
        payload["detail"] = detail

    request_id = f"AI-{instrument}-{signal}-{int(time.time() * 1000)}"
    t0 = time.monotonic()

    try:
        resp = requests.post(url, headers=_headers(), data=json.dumps(payload), timeout=timeout)
    except requests.RequestException as exc:
        dt = (time.monotonic() - t0) * 1000.0
        logger.error(
            "ai-signal connect failed request_id=%s dt_ms=%.1f exc=%s", request_id, dt, exc
        )
        raise

    dt = (time.monotonic() - t0) * 1000.0

    if resp.status_code >= 400:
        body_text = resp.text[:300]
        logger.warning(
            "ai-signal status=%s request_id=%s dt_ms=%.1f body=%s",
            resp.status_code,
            request_id,
            dt,
            body_text,
        )
        return {"success": False, "data": {}, "error": body_text}

    body: AiSignalResponse = resp.json()
    extra = f"acted={body.get('data', {}).get('acted', '?')} skipped={body.get('data', {}).get('skipped', '?')}"
    _log_call("ai-signal", request_id, "DELIVERED", dt, extra)
    return body
