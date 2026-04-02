#!/usr/bin/env python3
"""
WebSocket Feed Module
---------------------
Connects to the Node.js Broker Service tick WebSocket at /ws/ticks.
Maintains an in-memory store of the latest tick data for all subscribed
security IDs (ATM +/- 10 strikes, open positions, active strikes).

The server sends:
  1. Initial JSON snapshot: {"type": "snapshot", "ticks": {key: tickData}}
  2. Subsequent raw binary frames: Dhan Full Packet (Code 8) format

This module parses both and exposes a thread-safe tick store that the
Momentum Engine and Executor can query.

Usage:
    from websocket_feed import TickFeed
    feed = TickFeed()
    feed.start()  # starts background thread
    tick = feed.get_tick("NSE_FNO:12345")
    all_ticks = feed.get_all_ticks()
    feed.stop()
"""

import env_loader  # noqa: F401

import json
import os
import struct
import sys
import threading
import time
from datetime import datetime
from collections import defaultdict

try:
    import websocket  # websocket-client library
except ImportError:
    print("websocket-client not installed. Run: pip install websocket-client")
    sys.exit(1)


# --- Configuration ---

WS_URL = os.environ.get("TICK_WS_URL", "ws://localhost:3000/ws/ticks").strip()
RECONNECT_DELAY_BASE = 2   # seconds, doubles on each retry
RECONNECT_DELAY_MAX = 30   # max reconnect delay
HEARTBEAT_INTERVAL = 30    # seconds between ping frames


# --- Dhan Binary Packet Parsing ---
# Full Packet (Code 8) structure from Dhan WebSocket spec:
#   Header: 2 bytes (packet_type: u8, num_packets: u8)
#   Per-instrument: 42 bytes each
#     security_id: u32 (4 bytes)
#     ltp: f32 (4 bytes)
#     ltq: u16 (2 bytes)
#     ltt: u32 (4 bytes)  — epoch seconds
#     avg_price: f32 (4 bytes)
#     volume: u32 (4 bytes)
#     total_sell_qty: u32 (4 bytes)
#     total_buy_qty: u32 (4 bytes)
#     oi: u32 (4 bytes)
#     high: f32 (4 bytes)
#     low: f32 (4 bytes)
#     open: f32 (4 bytes)
#     close: f32 (4 bytes)  — prev close

FULL_PACKET_CODE = 8
FULL_PACKET_INSTRUMENT_SIZE = 50  # actual size per Dhan docs (may vary)


def parse_dhan_full_packet(data):
    """
    Parse Dhan binary Full Packet (Code 8).
    Returns a list of tick dicts, or empty list if not a full packet.
    """
    if len(data) < 2:
        return []

    packet_type = data[0]
    num_packets = data[1]

    if packet_type != FULL_PACKET_CODE:
        return []

    ticks = []
    offset = 2

    for _ in range(num_packets):
        if offset + 50 > len(data):
            break

        try:
            # Parse fields (little-endian)
            security_id = struct.unpack_from('<I', data, offset)[0]
            ltp = struct.unpack_from('<f', data, offset + 4)[0]
            ltq = struct.unpack_from('<H', data, offset + 8)[0]
            ltt = struct.unpack_from('<I', data, offset + 10)[0]
            avg_price = struct.unpack_from('<f', data, offset + 14)[0]
            volume = struct.unpack_from('<I', data, offset + 18)[0]
            total_sell_qty = struct.unpack_from('<I', data, offset + 22)[0]
            total_buy_qty = struct.unpack_from('<I', data, offset + 26)[0]
            oi = struct.unpack_from('<I', data, offset + 30)[0]
            high = struct.unpack_from('<f', data, offset + 34)[0]
            low = struct.unpack_from('<f', data, offset + 38)[0]
            open_price = struct.unpack_from('<f', data, offset + 42)[0]
            close_price = struct.unpack_from('<f', data, offset + 46)[0]

            tick = {
                "securityId": str(security_id),
                "ltp": round(ltp, 2),
                "ltq": ltq,
                "ltt": ltt,
                "avgPrice": round(avg_price, 2),
                "volume": volume,
                "totalSellQty": total_sell_qty,
                "totalBuyQty": total_buy_qty,
                "oi": oi,
                "high": round(high, 2),
                "low": round(low, 2),
                "open": round(open_price, 2),
                "close": round(close_price, 2),
                "localTimestamp": datetime.now().isoformat(),
            }
            ticks.append(tick)
        except struct.error:
            break

        offset += 50

    return ticks


def parse_other_packet(data):
    """
    Parse non-full-packet binary frames (ticker, quote, OI, etc.).
    Returns a list of partial tick dicts with whatever fields are available.
    """
    if len(data) < 2:
        return []

    packet_type = data[0]
    num_packets = data[1]
    ticks = []
    offset = 2

    # Ticker packet (Code 2): security_id(4) + ltp(4) = 8 bytes per instrument
    if packet_type == 2:
        for _ in range(num_packets):
            if offset + 8 > len(data):
                break
            security_id = struct.unpack_from('<I', data, offset)[0]
            ltp = struct.unpack_from('<f', data, offset + 4)[0]
            ticks.append({
                "securityId": str(security_id),
                "ltp": round(ltp, 2),
                "localTimestamp": datetime.now().isoformat(),
            })
            offset += 8

    # Quote packet (Code 4): security_id(4) + ltp(4) + ltq(2) + ltt(4) + avg(4) + vol(4) + tsq(4) + tbq(4) = 30 bytes
    elif packet_type == 4:
        for _ in range(num_packets):
            if offset + 30 > len(data):
                break
            security_id = struct.unpack_from('<I', data, offset)[0]
            ltp = struct.unpack_from('<f', data, offset + 4)[0]
            ltq = struct.unpack_from('<H', data, offset + 8)[0]
            ltt = struct.unpack_from('<I', data, offset + 10)[0]
            avg_price = struct.unpack_from('<f', data, offset + 14)[0]
            volume = struct.unpack_from('<I', data, offset + 18)[0]
            total_sell_qty = struct.unpack_from('<I', data, offset + 22)[0]
            total_buy_qty = struct.unpack_from('<I', data, offset + 26)[0]
            ticks.append({
                "securityId": str(security_id),
                "ltp": round(ltp, 2),
                "ltq": ltq,
                "ltt": ltt,
                "avgPrice": round(avg_price, 2),
                "volume": volume,
                "totalSellQty": total_sell_qty,
                "totalBuyQty": total_buy_qty,
                "localTimestamp": datetime.now().isoformat(),
            })
            offset += 30

    # OI packet (Code 5): security_id(4) + oi(4) = 8 bytes per instrument
    elif packet_type == 5:
        for _ in range(num_packets):
            if offset + 8 > len(data):
                break
            security_id = struct.unpack_from('<I', data, offset)[0]
            oi_val = struct.unpack_from('<I', data, offset + 4)[0]
            ticks.append({
                "securityId": str(security_id),
                "oi": oi_val,
                "localTimestamp": datetime.now().isoformat(),
            })
            offset += 8

    return ticks


# --- Tick Store ---

class TickStore:
    """Thread-safe in-memory store for latest tick data per security ID."""

    def __init__(self):
        self._lock = threading.Lock()
        self._ticks = {}  # key: "exchange:securityId" or just "securityId"
        self._tick_history = defaultdict(list)  # key -> list of {timestamp, ltp, volume, oi}
        self._max_history = 360  # ~6 minutes at 1 tick/sec

    def update(self, key, tick_data):
        """Update or insert a tick. Merges partial updates into existing data."""
        with self._lock:
            if key in self._ticks:
                self._ticks[key].update(tick_data)
            else:
                self._ticks[key] = tick_data

            # Append to history for momentum calculations
            entry = {
                "timestamp": time.time(),
                "ltp": tick_data.get("ltp", self._ticks[key].get("ltp", 0)),
                "volume": tick_data.get("volume", self._ticks[key].get("volume", 0)),
                "oi": tick_data.get("oi", self._ticks[key].get("oi", 0)),
            }
            history = self._tick_history[key]
            history.append(entry)
            if len(history) > self._max_history:
                self._tick_history[key] = history[-self._max_history:]

    def get(self, key):
        """Get the latest tick for a security ID."""
        with self._lock:
            return self._ticks.get(key, {}).copy()

    def get_all(self):
        """Get all latest ticks."""
        with self._lock:
            return {k: v.copy() for k, v in self._ticks.items()}

    def get_history(self, key, seconds=None):
        """Get tick history for a security ID, optionally limited to last N seconds."""
        with self._lock:
            history = self._tick_history.get(key, [])
            if seconds is not None:
                cutoff = time.time() - seconds
                return [h for h in history if h["timestamp"] >= cutoff]
            return list(history)

    def get_by_security_id(self, security_id):
        """Find a tick by security ID regardless of exchange prefix."""
        sid = str(security_id)
        with self._lock:
            # Try exact match first
            if sid in self._ticks:
                return self._ticks[sid].copy()
            # Try with exchange prefixes
            for key, tick in self._ticks.items():
                if key.endswith(f":{sid}") or tick.get("securityId") == sid:
                    return tick.copy()
        return {}

    def clear(self):
        """Clear all ticks."""
        with self._lock:
            self._ticks.clear()
            self._tick_history.clear()

    @property
    def count(self):
        with self._lock:
            return len(self._ticks)


# --- WebSocket Feed Client ---

class TickFeed:
    """
    WebSocket client that connects to the Node.js tick server at /ws/ticks.
    Runs in a background thread and populates a TickStore.
    """

    def __init__(self, url=None):
        self.url = url or WS_URL
        self.store = TickStore()
        self._ws = None
        self._thread = None
        self._running = False
        self._connected = False
        self._reconnect_delay = RECONNECT_DELAY_BASE
        self._last_tick_time = 0
        self._tick_count = 0
        self._error_count = 0

    @property
    def connected(self):
        return self._connected

    @property
    def tick_count(self):
        return self._tick_count

    def start(self):
        """Start the WebSocket feed in a background thread."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="TickFeed")
        self._thread.start()
        _log(f"TickFeed started. Connecting to {self.url}")

    def stop(self):
        """Stop the WebSocket feed."""
        self._running = False
        if self._ws:
            try:
                self._ws.close()
            except Exception:
                pass
        if self._thread:
            self._thread.join(timeout=5)
        _log("TickFeed stopped.")

    def get_tick(self, key):
        """Get latest tick for a security ID or exchange:securityId key."""
        return self.store.get(key)

    def get_all_ticks(self):
        """Get all latest ticks."""
        return self.store.get_all()

    def get_tick_history(self, key, seconds=None):
        """Get tick history for momentum calculations."""
        return self.store.get_history(key, seconds)

    def get_status(self):
        """Get feed connection status."""
        return {
            "connected": self._connected,
            "url": self.url,
            "tick_count": self._tick_count,
            "error_count": self._error_count,
            "subscribed_instruments": self.store.count,
            "last_tick_time": self._last_tick_time,
        }

    # --- Internal ---

    def _run_loop(self):
        """Main reconnection loop."""
        while self._running:
            try:
                self._connect()
            except Exception as e:
                _log(f"TickFeed connection error: {e}")
                self._connected = False
                self._error_count += 1

            if self._running:
                delay = min(self._reconnect_delay, RECONNECT_DELAY_MAX)
                _log(f"TickFeed reconnecting in {delay}s...")
                time.sleep(delay)
                self._reconnect_delay = min(self._reconnect_delay * 2, RECONNECT_DELAY_MAX)

    def _connect(self):
        """Establish WebSocket connection."""
        self._ws = websocket.WebSocketApp(
            self.url,
            on_open=self._on_open,
            on_message=self._on_message,
            on_error=self._on_error,
            on_close=self._on_close,
        )
        self._ws.run_forever(
            ping_interval=HEARTBEAT_INTERVAL,
            ping_timeout=10,
        )

    def _on_open(self, ws):
        _log("TickFeed connected.")
        self._connected = True
        self._reconnect_delay = RECONNECT_DELAY_BASE

    def _on_message(self, ws, message):
        """Handle incoming messages — JSON snapshot or binary tick data."""
        try:
            if isinstance(message, str):
                # JSON message (snapshot or control)
                self._handle_json_message(message)
            elif isinstance(message, (bytes, bytearray)):
                # Binary tick data
                self._handle_binary_message(message)
        except Exception as e:
            self._error_count += 1
            if self._error_count % 100 == 1:  # Log every 100th error to avoid spam
                _log(f"TickFeed message parse error: {e}")

    def _on_error(self, ws, error):
        self._error_count += 1
        _log(f"TickFeed error: {error}")

    def _on_close(self, ws, close_status_code, close_msg):
        self._connected = False
        _log(f"TickFeed disconnected. Code: {close_status_code}, Msg: {close_msg}")

    def _handle_json_message(self, message):
        """Parse JSON snapshot from server."""
        data = json.loads(message)
        msg_type = data.get("type")

        if msg_type == "snapshot":
            ticks = data.get("ticks", {})
            for key, tick_data in ticks.items():
                self.store.update(key, tick_data)
                self._tick_count += 1
            _log(f"TickFeed snapshot loaded: {len(ticks)} instruments")

        elif msg_type == "tick":
            # Single tick JSON (fallback mode)
            tick_data = data.get("data", data)
            key = tick_data.get("key") or f"{tick_data.get('exchange', '')}:{tick_data.get('securityId', '')}"
            self.store.update(key, tick_data)
            self._tick_count += 1

    def _handle_binary_message(self, data):
        """Parse binary Dhan tick packets."""
        if len(data) < 2:
            return

        packet_type = data[0]

        if packet_type == FULL_PACKET_CODE:
            ticks = parse_dhan_full_packet(data)
        else:
            ticks = parse_other_packet(data)

        for tick in ticks:
            sid = tick.get("securityId", "")
            key = sid  # Use securityId as key; exchange prefix added by server if available
            self.store.update(key, tick)
            self._tick_count += 1
            self._last_tick_time = time.time()


# --- Module-level helpers ---

def _log(message):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [TICK_FEED] {message}")
    sys.stdout.flush()


# --- Singleton instance for import convenience ---

_default_feed = None


def get_feed():
    """Get or create the default TickFeed singleton."""
    global _default_feed
    if _default_feed is None:
        _default_feed = TickFeed()
    return _default_feed


def start_feed():
    """Start the default feed."""
    feed = get_feed()
    feed.start()
    return feed


def stop_feed():
    """Stop the default feed."""
    global _default_feed
    if _default_feed:
        _default_feed.stop()
        _default_feed = None


# --- Standalone test ---

if __name__ == "__main__":
    print("Starting WebSocket Feed (standalone test)...")
    print(f"Connecting to: {WS_URL}")
    print("Press Ctrl+C to stop.\n")

    feed = TickFeed()
    feed.start()

    try:
        while True:
            status = feed.get_status()
            print(f"\r  Connected: {status['connected']} | "
                  f"Ticks: {status['tick_count']} | "
                  f"Instruments: {status['subscribed_instruments']} | "
                  f"Errors: {status['error_count']}  ", end="")
            time.sleep(2)
    except KeyboardInterrupt:
        print("\nStopping...")
        feed.stop()
        print("Done.")
