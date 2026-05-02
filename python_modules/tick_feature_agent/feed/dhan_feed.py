"""
dhan_feed.py — Asyncio WebSocket connection to Dhan Live Market Feed v2.

Single connection handles both underlying and all option instruments.
Connects directly to api-feed.dhan.co — no Node.js hop (eliminates one
serialization cycle per tick at 500+ ticks/sec).

Connection URL:
    wss://api-feed.dhan.co?version=2&token={token}&clientId={clientId}&authType=2

Credentials are fetched from GET /api/broker/token (Node.js internal endpoint)
at startup and on every reconnect — Settings page is the single source of truth.
"""

from __future__ import annotations

import asyncio
import json
import socket
import time
from collections.abc import Awaitable, Callable

try:
    import websockets
    import websockets.asyncio.client as ws_client
except ImportError:
    raise ImportError("websockets package not installed.\n" "Run: pip install 'websockets>=12.0'")

from tick_feature_agent.feed.binary_parser import (
    EXCHANGE_SEGMENT_NAME,
    RequestCode,
    ResponseCode,
    dispatch,
)
from tick_feature_agent.log.tfa_logger import get_logger

_DHAN_WS_URL = "wss://api-feed.dhan.co"
_MAX_INSTRUMENTS_PER_MSG = 100
_CONNECT_TIMEOUT_SEC = 15.0

# Exchange segment strings by profile exchange
# Underlying futures (NSE_FNO / MCX_COMM) send FULL binary packets over the
# WebSocket feed. IDX_I (index) instruments do not emit tick data via the feed.
_UNDERLYING_EXCHANGE_SEG: dict[str, str] = {
    "NSE": "NSE_FNO",
    "MCX": "MCX_COMM",
}
_OPTION_EXCHANGE_SEG: dict[str, str] = {
    "NSE": "NSE_FNO",
    "MCX": "MCX_COMM",
}


class DhanFeed:
    """
    Asyncio WebSocket client for the Dhan Live Market Feed.

    Usage (from the asyncio event loop):
        feed = DhanFeed(
            access_token=creds["accessToken"],
            client_id=creds["clientId"],
            exchange="NSE",
            on_underlying_tick=handle_underlying,
            on_option_tick=handle_option,
            on_connected=handle_connected,
            on_disconnected=handle_disconnected,
        )
        await feed.connect()
        feed.subscribe_underlying(security_id="13")
        feed.subscribe_options({"52175": (21800, "CE"), "52176": (21800, "PE"), ...})
        # run forever
        await feed.run()
    """

    def __init__(
        self,
        access_token: str,
        client_id: str,
        exchange: str,  # "NSE" or "MCX"
        underlying_security_id: str,
        on_underlying_tick: Callable[[dict], Awaitable[None] | None],
        on_option_tick: Callable[[int, str, dict], Awaitable[None] | None],
        on_connected: Callable[[], None] | None = None,
        on_disconnected: Callable[[], None] | None = None,
        on_disconnect_code: Callable[[int, str], None] | None = None,
        credential_fetcher: Callable[[], dict | None] | None = None,
        on_reconnecting: Callable[[float, int], None] | None = None,
        instrument_name: str = "",
    ) -> None:
        self._token = access_token
        self._client_id = client_id
        self._credential_fetcher = credential_fetcher
        self._on_reconnecting = on_reconnecting
        self._exchange = exchange
        self._underlying_security_id = str(underlying_security_id)
        self._on_underlying_tick = on_underlying_tick
        self._on_option_tick = on_option_tick
        self._on_connected = on_connected
        self._on_disconnected = on_disconnected
        self._on_disconnect_code = on_disconnect_code

        self._log = get_logger("tfa.dhan_feed", instrument=instrument_name)

        # Exchange segments
        self._underlying_seg = _UNDERLYING_EXCHANGE_SEG.get(exchange, "NSE_FNO")
        self._option_seg = _OPTION_EXCHANGE_SEG.get(exchange, "NSE_FNO")

        # security_id → (strike, opt_type) lookup — built by subscribe_options()
        self._sec_id_map: dict[str, tuple[int, str]] = {}

        # Per-instrument tick cache — merges partial packets (like mergeTick in TS)
        self._tick_cache: dict[str, dict] = {}

        # Subscription registry — survives reconnects
        self._subscriptions: dict[str, dict] = {}  # key: "seg:sec_id"

        # Connection state
        self._ws = None
        self._connected = False
        self._running = False
        self._reconnect_attempts = 0
        self._last_was_429 = False
        self._stop_event = asyncio.Event()

    # ── Public API ────────────────────────────────────────────────────────────

    @property
    def connected(self) -> bool:
        return self._connected

    def subscribe_underlying(self, security_id: str | None = None) -> None:
        """
        Register underlying futures subscription (called before connect or any time).
        Uses the underlying_security_id from the constructor if not specified.
        """
        sec_id = str(security_id or self._underlying_security_id)
        key = f"{self._underlying_seg}:{sec_id}"
        self._subscriptions[key] = {
            "exchange": self._underlying_seg,
            "security_id": sec_id,
            "mode": "full",
        }
        if self._connected and self._ws:
            self._send_subscribe([{"exchange": self._underlying_seg, "security_id": sec_id}])

    def subscribe_options(self, sec_id_map: dict[str, tuple[int, str]]) -> None:
        """
        Register option subscriptions and update the security_id→(strike, opt_type) lookup.

        Args:
            sec_id_map: {security_id_str: (strike_int, opt_type_str), ...}
                        e.g. {"52175": (21800, "CE"), "52176": (21800, "PE")}
        """
        self._sec_id_map.update(sec_id_map)
        new_entries = []
        for sec_id in sec_id_map:
            key = f"{self._option_seg}:{sec_id}"
            entry = {"exchange": self._option_seg, "security_id": sec_id, "mode": "full"}
            self._subscriptions[key] = entry
            new_entries.append(entry)
        if self._connected and self._ws and new_entries:
            self._send_subscribe(new_entries)

    def unsubscribe_options(self, security_ids: list[str]) -> None:
        """Unsubscribe and remove from registry (used on expiry rollover)."""
        to_remove = []
        for sec_id in security_ids:
            key = f"{self._option_seg}:{sec_id}"
            if key in self._subscriptions:
                to_remove.append(self._subscriptions.pop(key))
                self._tick_cache.pop(key, None)
            self._sec_id_map.pop(sec_id, None)
        if self._connected and self._ws and to_remove:
            self._send_unsubscribe(to_remove)

    async def run(self) -> None:
        """
        Main entry point — connects and runs the receive loop with auto-reconnect.
        Call this as an asyncio task. Returns when stop() is called or max
        reconnect attempts are exceeded.
        """
        self._running = True
        self._stop_event.clear()
        while self._running:
            try:
                await self._connect_and_receive()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self._log.warn("FEED_ERROR", msg=f"Feed error: {exc}")

            if not self._running:
                break

            delay = self._backoff_delay()
            retry_at = time.time() + delay
            self._log.info(
                "FEED_RECONNECTING",
                msg=f"Reconnecting in {delay:.1f}s " f"(attempt {self._reconnect_attempts})",
            )
            if self._on_reconnecting:
                self._on_reconnecting(retry_at, self._reconnect_attempts)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
                break  # stop() was called during backoff
            except TimeoutError:
                pass

    async def stop(self) -> None:
        """Gracefully stop the feed."""
        self._running = False
        self._stop_event.set()
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass

    # ── Internal connection ────────────────────────────────────────────────────

    async def _connect_and_receive(self) -> None:
        # Refresh credentials before each attempt — picks up token rotations
        if self._credential_fetcher and self._reconnect_attempts > 0:
            try:
                fresh = self._credential_fetcher()
                if fresh and "_error" not in fresh:
                    new_token = fresh.get("accessToken") or fresh.get("access_token", "")
                    new_client_id = fresh.get("clientId") or fresh.get("client_id", "")
                    if new_token and new_client_id:
                        self._token = new_token
                        self._client_id = new_client_id
                        self._log.info("CREDS_REFRESHED", msg="Credentials refreshed for reconnect")
            except Exception as exc:
                self._log.warn("CREDS_REFRESH_FAILED", msg=f"Could not refresh credentials: {exc}")

        url = (
            f"{_DHAN_WS_URL}"
            f"?version=2&token={self._token}&clientId={self._client_id}&authType=2"
        )

        try:
            self._last_was_429 = False
            async with ws_client.connect(
                url,
                open_timeout=_CONNECT_TIMEOUT_SEC,
                ping_interval=None,  # Don't send WS pings — Dhan doesn't pong them
                ping_timeout=None,  # Disable client-side ping timeout entirely
                # Dhan sends its own pings every 10s; websockets
                # auto-responds with pongs to keep connection alive
            ) as ws:
                self._ws = ws
                self._connected = True
                self._reconnect_attempts = 0

                # Disable Nagle for minimal latency
                try:
                    raw_sock = ws.socket
                    if raw_sock:
                        raw_sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                except Exception:
                    pass

                self._log.info("FEED_CONNECTED", msg="Connected to Dhan Live Market Feed")

                # Re-send all subscriptions (covers both initial connect and reconnect)
                if self._subscriptions:
                    entries = list(self._subscriptions.values())
                    self._send_subscribe(entries)

                if self._on_connected:
                    self._on_connected()

                async for raw_msg in ws:
                    if isinstance(raw_msg, bytes):
                        await self._handle_message(raw_msg)
                    # text messages are not expected but silently ignored

        except (
            websockets.exceptions.ConnectionClosedError,
            websockets.exceptions.ConnectionClosedOK,
        ):
            pass
        except (OSError, websockets.exceptions.WebSocketException) as exc:
            msg = str(exc)
            if "429" in msg:
                self._last_was_429 = True
                self._log.warn(
                    "FEED_RATE_LIMITED",
                    msg="Dhan rate-limited connection (HTTP 429) — backing off 60s",
                )
            else:
                self._log.warn("FEED_CONNECT_FAILED", msg=msg)
        finally:
            self._ws = None
            self._connected = False
            self._reconnect_attempts += 1
            if self._on_disconnected:
                self._on_disconnected()
            self._log.info("FEED_DISCONNECTED", msg="Disconnected from Dhan feed")

    async def _handle_message(self, buf: bytes) -> None:
        header, payload = dispatch(buf)
        if payload is None:
            if header.response_code == ResponseCode.MARKET_STATUS:
                pass  # ignore
            elif header.response_code not in (0,):
                self._log.debug(
                    "UNKNOWN_PACKET",
                    msg=f"Unknown response code: {header.response_code}",
                )
            return

        if header.response_code == ResponseCode.DISCONNECT:
            code = payload.get("disconnect_code", 0)
            reason = payload.get("reason", "")
            self._log.warn("SERVER_DISCONNECT", msg=f"Server disconnected: {reason}", code=code)
            # Always print to terminal so it is visible regardless of log level
            print(
                f"\n  \033[31m✗ DHAN DISCONNECT\033[0m  code={code}  reason={reason}\n", flush=True
            )
            if self._on_disconnect_code:
                self._on_disconnect_code(code, reason)
            return

        sec_id = str(header.security_id)
        exch_seg = EXCHANGE_SEGMENT_NAME.get(header.exchange_segment, "UNKNOWN")
        cache_key = f"{exch_seg}:{sec_id}"

        # Merge partial packet into tick cache
        existing = self._tick_cache.get(cache_key, {})
        merged = {**existing, **payload}
        self._tick_cache[cache_key] = merged

        merged["security_id"] = sec_id
        merged["exchange_segment"] = exch_seg

        if sec_id == self._underlying_security_id:
            # INDEX (code 1) and TICKER (code 2) packets carry ltp — route all
            # types for the underlying so IDX_I instruments are not filtered out.
            cb = self._on_underlying_tick(merged)
            if asyncio.iscoroutine(cb):
                await cb
        elif sec_id in self._sec_id_map:
            # Options: require FULL packets (bid/ask depth needed for features)
            if header.response_code != ResponseCode.FULL:
                return
            strike, opt_type = self._sec_id_map[sec_id]
            cb = self._on_option_tick(strike, opt_type, merged)
            if asyncio.iscoroutine(cb):
                await cb

    # ── Subscription messages ─────────────────────────────────────────────────

    def _send_subscribe(self, entries: list[dict]) -> None:
        self._send_subscription_batch(entries, RequestCode.SUBSCRIBE_FULL)

    def _send_unsubscribe(self, entries: list[dict]) -> None:
        self._send_subscription_batch(entries, RequestCode.UNSUBSCRIBE_FULL)

    def _send_subscription_batch(self, entries: list[dict], request_code: int) -> None:
        if not self._ws or not self._connected:
            return
        for i in range(0, len(entries), _MAX_INSTRUMENTS_PER_MSG):
            batch = entries[i : i + _MAX_INSTRUMENTS_PER_MSG]
            msg = {
                "RequestCode": request_code,
                "InstrumentCount": len(batch),
                "InstrumentList": [
                    {
                        "ExchangeSegment": e["exchange"],
                        "SecurityId": e["security_id"],
                    }
                    for e in batch
                ],
            }
            try:
                asyncio.ensure_future(self._ws.send(json.dumps(msg)))
            except Exception as exc:
                self._log.warn("SUBSCRIBE_SEND_FAILED", msg=str(exc))

    def _backoff_delay(self) -> float:
        """
        Exponential backoff capped at 30s normally.
        60s flat when last failure was HTTP 429 (Dhan rate limit).
        """
        if self._last_was_429:
            return 60.0
        return min(1.0 * (2 ** (self._reconnect_attempts - 1)), 30.0)
