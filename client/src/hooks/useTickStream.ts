/**
 * useTickStream — Live tick data hook
 *
 * Connects to the server's native WebSocket at /ws/ticks for
 * zero-latency LTP streaming. Falls back to tRPC polling if WS fails.
 *
 * Usage:
 *   const { getTick, isConnected } = useTickStream();
 *   const niftyTick = getTick("IDX_I", "13");
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { trpc } from "@/lib/trpc";

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
  wsInstance = ws;

  ws.onopen = () => {
    console.log("[TickWS] Connected");
    wsConnected = true;
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      // Snapshot message (array of cached ticks on connect)
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
        return;
      }
      // Single tick message
      ingestTick(data as TickData);
    } catch {
      // ignore parse errors
    }
  };

  ws.onclose = () => {
    console.log("[TickWS] Disconnected, reconnecting in 1s...");
    wsConnected = false;
    wsInstance = null;
    // Auto-reconnect
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWs, 1000);
  };

  ws.onerror = () => {
    // onclose will fire after this
    wsConnected = false;
  };
}

function disconnectWs() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (wsInstance) {
    wsInstance.onclose = null; // prevent reconnect
    wsInstance.close();
    wsInstance = null;
  }
  wsConnected = false;
}

// Track how many hook instances are active
let hookRefCount = 0;

// ── Hook ────────────────────────────────────────────────────────
export function useTickStream(enabled = true) {
  // Manage WS lifecycle based on hook mount/unmount
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

  // Polling fallback (only when WS is not connected, every 2s)
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

  // Re-render when store changes
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

// Utility: get a single tick without hook (for non-React code)
export function getTickFromStore(
  exchange: string,
  securityId: string
): TickData | undefined {
  return tickStore.get(`${exchange}:${securityId}`);
}
