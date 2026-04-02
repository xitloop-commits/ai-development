/**
 * useTickStream — Live tick data hook
 *
 * Dual strategy:
 *  1. SSE subscription (broker.feed.onTick) for real-time ticks
 *  2. Polling fallback (broker.feed.snapshot) every 2s for reliability
 *
 * Both feed into the same global tickStore so the UI always has data.
 *
 * Usage:
 *   const { getTick, isConnected } = useTickStream();
 *   const niftyTick = getTick("NSE_FNO", "NIFTY_50");
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

// ── Hook ────────────────────────────────────────────────────────
export function useTickStream(enabled = true) {
  const sseConnectedRef = useRef(false);

  // Strategy 1: SSE subscription (real-time)
  trpc.broker.feed.onTick.useSubscription(undefined, {
    enabled,
    onData(data) {
      const tick = data as unknown as TickData;
      ingestTick(tick);
      sseConnectedRef.current = true;
    },
    onError(err) {
      console.warn("[TickStream] SSE error (polling fallback active):", err.message);
      sseConnectedRef.current = false;
    },
  });

  // Strategy 2: Polling fallback (every 2s)
  const snapshotQuery = trpc.broker.feed.snapshot.useQuery(undefined, {
    enabled,
    refetchInterval: 2000,
    refetchIntervalInBackground: true,
    retry: false,
  });

  // Ingest polled ticks into the store
  useEffect(() => {
    if (snapshotQuery.data && Array.isArray(snapshotQuery.data)) {
      let changed = false;
      for (const tick of snapshotQuery.data) {
        if (tick && tick.securityId && tick.exchange) {
          const key = `${tick.exchange}:${tick.securityId}`;
          const existing = tickStore.get(key);
          // Only update if newer or not present
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
    isConnected: sseConnectedRef.current || (snapshotQuery.data?.length ?? 0) > 0,
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
