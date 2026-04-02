/**
 * useTickStream — Live tick data hook
 *
 * Connects to the broker.feed.onTick SSE subscription and maintains
 * a Map of latest ticks keyed by "exchange:securityId".
 *
 * Usage:
 *   const { ticks, getTick, isConnected } = useTickStream();
 *   const niftyTick = getTick("NSE_FNO", "12345");
 */

import { useCallback, useRef, useSyncExternalStore } from "react";
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

// Global tick store (shared across all hook instances)
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

export function useTickStream(enabled = true) {
  const connectedRef = useRef(false);

  // Subscribe to the SSE tick stream
  // tRPC v11 tracked() wraps data — onData receives the unwrapped data directly
  trpc.broker.feed.onTick.useSubscription(undefined, {
    enabled,
    onData(data) {
      // data is the tracked envelope — extract the actual tick
      const tick = data as unknown as TickData;
      if (tick && tick.securityId && tick.exchange) {
        const key = `${tick.exchange}:${tick.securityId}`;
        tickStore.set(key, tick);
        connectedRef.current = true;
        notifyListeners();
      }
    },
    onError(err) {
      console.error("[TickStream] Error:", err);
      connectedRef.current = false;
    },
  });

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
    isConnected: connectedRef.current,
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
