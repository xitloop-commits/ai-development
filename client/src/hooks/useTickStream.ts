/**
 * useTickStream — Live tick data hook
 *
 * Connects to /ws/ticks which forwards raw Dhan binary packets.
 * Parses binary on the client side for zero-latency LTP display.
 * Falls back to tRPC polling if WS fails.
 *
 * Usage:
 *   const { getTick, isConnected } = useTickStream();
 *   const niftyTick = getTick("IDX_I", "13");
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { trpc } from "@/lib/trpc";
import * as chainStore from "@/stores/optionChainStore";

export interface TickData {
  securityId: string;
  exchange: string;
  ltp: number;
  ltq: number;
  ltt: number;
  atp: number;
  volume: number;
  totalSellQty: number;
  totalBuyQty: number;
  oi: number;
  highOI: number;
  lowOI: number;
  dayOpen: number;
  dayClose: number;
  dayHigh: number;
  dayLow: number;
  prevClose: number;
  prevOI: number;
  depth: Array<{
    bidQty: number;
    askQty: number;
    bidOrders: number;
    askOrders: number;
    bidPrice: number;
    askPrice: number;
  }>;
  bidPrice: number;
  askPrice: number;
  timestamp: number;
}

// ── Dhan binary constants ──────────────────────────────────────
const EXCHANGE_SEGMENT: Record<number, string> = {
  0: "IDX_I",
  1: "NSE_EQ",
  2: "NSE_FNO",
  3: "NSE_CURRENCY",
  4: "BSE_EQ",
  5: "MCX_COMM",
  7: "BSE_CURRENCY",
  8: "BSE_FNO",
};

const RESPONSE = {
  INDEX: 1,
  TICKER: 2,
  QUOTE: 4,
  OI: 5,
  PREV_CLOSE: 6,
  FULL: 8,
};

// ── Binary parser ──────────────────────────────────────────────
function parseBinaryPacket(buf: DataView, byteLen: number): { key: string; partial: Partial<TickData> } | null {
  if (byteLen < 8) return null;

  const responseCode = buf.getUint8(0);
  const exchangeSeg = buf.getUint8(3);
  const securityId = buf.getInt32(4, true); // little-endian

  const exchange = EXCHANGE_SEGMENT[exchangeSeg] || "UNKNOWN";
  const secId = String(securityId);
  const key = `${exchange}:${secId}`;

  switch (responseCode) {
    case RESPONSE.INDEX:
    case RESPONSE.TICKER:
      return {
        key,
        partial: {
          securityId: secId,
          exchange,
          ltp: buf.getFloat32(8, true),
          ltt: buf.getInt32(12, true),
          timestamp: Date.now(),
        },
      };

    case RESPONSE.QUOTE:
      if (byteLen < 50) return null;
      return {
        key,
        partial: {
          securityId: secId,
          exchange,
          ltp: buf.getFloat32(8, true),
          ltq: buf.getInt16(12, true),
          ltt: buf.getInt32(14, true),
          atp: buf.getFloat32(18, true),
          volume: buf.getInt32(22, true),
          totalSellQty: buf.getInt32(26, true),
          totalBuyQty: buf.getInt32(30, true),
          dayOpen: buf.getFloat32(34, true),
          dayClose: buf.getFloat32(38, true),
          dayHigh: buf.getFloat32(42, true),
          dayLow: buf.getFloat32(46, true),
          timestamp: Date.now(),
        },
      };

    case RESPONSE.OI:
      if (byteLen < 12) return null;
      return {
        key,
        partial: {
          securityId: secId,
          exchange,
          oi: buf.getInt32(8, true),
          timestamp: Date.now(),
        },
      };

    case RESPONSE.PREV_CLOSE:
      if (byteLen < 16) return null;
      return {
        key,
        partial: {
          securityId: secId,
          exchange,
          prevClose: buf.getFloat32(8, true),
          prevOI: buf.getInt32(12, true),
          timestamp: Date.now(),
        },
      };

    case RESPONSE.FULL:
      if (byteLen < 62) return null;
      return {
        key,
        partial: {
          securityId: secId,
          exchange,
          ltp: buf.getFloat32(8, true),
          ltq: buf.getInt16(12, true),
          ltt: buf.getInt32(14, true),
          atp: buf.getFloat32(18, true),
          volume: buf.getInt32(22, true),
          totalSellQty: buf.getInt32(26, true),
          totalBuyQty: buf.getInt32(30, true),
          oi: buf.getInt32(34, true),
          highOI: buf.getInt32(38, true),
          lowOI: buf.getInt32(42, true),
          dayOpen: buf.getFloat32(46, true),
          dayClose: buf.getFloat32(50, true),
          dayHigh: buf.getFloat32(54, true),
          dayLow: buf.getFloat32(58, true),
          timestamp: Date.now(),
        },
      };

    default:
      return null;
  }
}

// ── Global tick store (shared across all hook instances) ─────────
const tickStore = new Map<string, TickData>();
const listeners: Array<() => void> = [];
let storeVersion = 0;

function notifyListeners() {
  storeVersion++;
  for (let i = 0; i < listeners.length; i++) {
    listeners[i]();
  }
}

function subscribe(listener: () => void) {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function getSnapshot() {
  return storeVersion;
}

function updateTick(key: string, partial: Partial<TickData>) {
  const existing = tickStore.get(key);
  if (existing) {
    // Direct property writes — no Object.assign, no new object
    if (partial.ltp !== undefined) existing.ltp = partial.ltp;
    if (partial.ltt !== undefined) existing.ltt = partial.ltt;
    if (partial.ltq !== undefined) existing.ltq = partial.ltq;
    if (partial.atp !== undefined) existing.atp = partial.atp;
    if (partial.volume !== undefined) existing.volume = partial.volume;
    if (partial.totalSellQty !== undefined) existing.totalSellQty = partial.totalSellQty;
    if (partial.totalBuyQty !== undefined) existing.totalBuyQty = partial.totalBuyQty;
    if (partial.oi !== undefined) existing.oi = partial.oi;
    if (partial.highOI !== undefined) existing.highOI = partial.highOI;
    if (partial.lowOI !== undefined) existing.lowOI = partial.lowOI;
    if (partial.dayOpen !== undefined) existing.dayOpen = partial.dayOpen;
    if (partial.dayClose !== undefined) existing.dayClose = partial.dayClose;
    if (partial.dayHigh !== undefined) existing.dayHigh = partial.dayHigh;
    if (partial.dayLow !== undefined) existing.dayLow = partial.dayLow;
    if (partial.prevClose !== undefined) existing.prevClose = partial.prevClose;
    if (partial.prevOI !== undefined) existing.prevOI = partial.prevOI;
    if (partial.timestamp !== undefined) existing.timestamp = partial.timestamp;
  } else {
    tickStore.set(key, {
      securityId: partial.securityId || "",
      exchange: partial.exchange || "",
      ltp: 0, ltq: 0, ltt: 0, atp: 0, volume: 0,
      totalSellQty: 0, totalBuyQty: 0,
      oi: 0, highOI: 0, lowOI: 0,
      dayOpen: 0, dayClose: 0, dayHigh: 0, dayLow: 0,
      prevClose: 0, prevOI: 0,
      depth: [], bidPrice: 0, askPrice: 0,
      timestamp: Date.now(),
      ...partial,
    } as TickData);
  }
  notifyListeners();
}

function ingestTick(tick: TickData) {
  if (tick && tick.securityId && tick.exchange) {
    const key = `${tick.exchange}:${tick.securityId}`;
    tickStore.set(key, tick);
    notifyListeners();
  }
}

// ── WebSocket connection manager (singleton) ──────────────────────
let wsInstance: WebSocket | null = null;
let wsConnected = false;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function getWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/ticks`;
}

function connectWs() {
  if (wsInstance && (wsInstance.readyState === WebSocket.CONNECTING || wsInstance.readyState === WebSocket.OPEN)) {
    return;
  }

  const ws = new WebSocket(getWsUrl());
  ws.binaryType = "arraybuffer"; // receive binary as ArrayBuffer
  wsInstance = ws;

  ws.onopen = () => {
    if (import.meta.env.DEV) console.log("[TickWS] Connected");
    wsConnected = true;
  };

  ws.onmessage = (event) => {
    // Binary message — raw Dhan packet
    if (event.data instanceof ArrayBuffer) {
      const view = new DataView(event.data);
      const result = parseBinaryPacket(view, event.data.byteLength);
      if (result) {
        updateTick(result.key, result.partial);
      }
      return;
    }

    // Text message — JSON envelope (tick snapshot, chain update, chain snapshot)
    try {
      const data = JSON.parse(event.data);
      if (data.type === "snapshot" && Array.isArray(data.ticks)) {
        let changed = false;
        for (const tick of data.ticks) {
          if (tick && tick.securityId && tick.exchange) {
            const key = `${tick.exchange}:${tick.securityId}`;
            tickStore.set(key, tick);
            changed = true;
          }
        }
        if (changed) notifyListeners();
      } else if (data.type === "chainUpdate" && data.chain) {
        // One option-chain update pushed by server when its chainCache refreshes
        chainStore._ingest(data.chain);
      } else if (data.type === "chainSnapshot" && Array.isArray(data.chains)) {
        // Bulk hydrate on new WS connect
        chainStore._ingestBulk(data.chains);
      }
    } catch {
      // ignore
    }
  };

  ws.onclose = () => {
    if (import.meta.env.DEV) console.log("[TickWS] Disconnected, reconnecting in 1s...");
    wsConnected = false;
    wsInstance = null;
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWs, 1000);
  };

  ws.onerror = () => {
    wsConnected = false;
  };
}

function disconnectWs() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (wsInstance) {
    wsInstance.onclose = null;
    wsInstance.close();
    wsInstance = null;
  }
  wsConnected = false;
}

let hookRefCount = 0;

// ── Hook ────────────────────────────────────────────────────────
export function useTickStream(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    hookRefCount++;
    if (hookRefCount === 1) {
      connectWs();
    }
    return () => {
      hookRefCount--;
      if (hookRefCount === 0) {
        disconnectWs();
      }
    };
  }, [enabled]);

  // Polling fallback (only when WS is not connected)
  const snapshotQuery = trpc.broker.feed.snapshot.useQuery(undefined, {
    enabled: enabled && !wsConnected,
    refetchInterval: 2000,
    refetchIntervalInBackground: true,
    retry: false,
  });

  useEffect(() => {
    if (snapshotQuery.data && Array.isArray(snapshotQuery.data)) {
      let changed = false;
      for (const tick of snapshotQuery.data) {
        if (tick && tick.securityId && tick.exchange) {
          const key = `${tick.exchange}:${tick.securityId}`;
          const existing = tickStore.get(key);
          if (!existing || tick.timestamp > existing.timestamp) {
            tickStore.set(key, tick as TickData);
            changed = true;
          }
        }
      }
      if (changed) notifyListeners();
    }
  }, [snapshotQuery.data]);

  useSyncExternalStore(subscribe, getSnapshot);

  const getTick = useCallback(
    (exchange: string, securityId: string): TickData | undefined => {
      return tickStore.get(`${exchange}:${securityId}`);
    },
    []
  );

  const getAllTicks = useCallback((): TickData[] => {
    return Array.from(tickStore.values());
  }, []);

  return {
    ticks: tickStore,
    getTick,
    getAllTicks,
    isConnected: wsConnected || (snapshotQuery.data?.length ?? 0) > 0,
    tickCount: tickStore.size,
  };
}

export function getTickFromStore(
  exchange: string,
  securityId: string
): TickData | undefined {
  return tickStore.get(`${exchange}:${securityId}`);
}
