/**
 * Live tick data — WS feed (/ws/ticks, raw Dhan binary) with a tRPC polling
 * fallback, parsed client-side for zero-latency LTP.
 *
 * Two consumption modes, both per-render-cheap:
 *   - useInstrumentTick(exchange, securityId) — reactive for ONE contract.
 *   - useTickFeed() — keep the feed connected without re-rendering on ticks;
 *     read on demand via getTickFromStore(exchange, securityId).
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
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

// ── Per-instrument subscription ───────────────────────────────────────────
// A row subscribes to ONLY its own contract's ticks, so it re-renders on its
// own ticks — never a global fan-out. Ticks are mutated in place, so each key
// carries a version counter that bumps on update.
const keyVersions = new Map<string, number>();
const keySubs = new Map<string, Set<() => void>>();
// Wall-clock of the most recent tick (any contract) — drives the feed-health
// banner. Init to "now" so a fresh page load gets a grace period before the
// staleness check can fire. Every tick path funnels through bumpKey.
let lastTickAt = Date.now();
function bumpKey(key: string) {
  lastTickAt = Date.now();
  keyVersions.set(key, (keyVersions.get(key) ?? 0) + 1);
  const subs = keySubs.get(key);
  if (subs) subs.forEach((cb) => cb());
}

/** ms timestamp of the most recent tick received (any contract). */
export function getLastTickAt(): number {
  return lastTickAt;
}

/** Whether the tick WebSocket is currently connected. */
export function isFeedConnected(): boolean {
  return wsConnected;
}
function subscribeKey(key: string, cb: () => void) {
  let set = keySubs.get(key);
  if (!set) {
    set = new Set();
    keySubs.set(key, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) keySubs.delete(key);
  };
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
  bumpKey(key);
}

function _ingestTick(tick: TickData) {
  if (tick && tick.securityId && tick.exchange) {
    const key = `${tick.exchange}:${tick.securityId}`;
    tickStore.set(key, tick);
    bumpKey(key);
  }
}

// ── Stale-tick eviction — bound tickStore memory over a long session ──
// Contracts come and go as the operator trades different strikes; without
// pruning the Map grows unbounded. Drop entries not updated in TICK_TTL_MS.
// No notify on prune — rows re-read on their next render / tick.
const TICK_TTL_MS = 15 * 60 * 1000;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
function pruneTickStore() {
  const cutoff = Date.now() - TICK_TTL_MS;
  tickStore.forEach((tick, key) => {
    if (tick.timestamp < cutoff) tickStore.delete(key);
  });
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

  if (!pruneTimer) pruneTimer = setInterval(pruneTickStore, PRUNE_INTERVAL_MS);

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
        for (const tick of data.ticks) {
          if (tick && tick.securityId && tick.exchange) {
            const key = `${tick.exchange}:${tick.securityId}`;
            tickStore.set(key, tick);
            bumpKey(key);
          }
        }
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
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
  if (wsInstance) {
    wsInstance.onclose = null;
    wsInstance.close();
    wsInstance = null;
  }
  wsConnected = false;
}

let hookRefCount = 0;

/** Shared WS connection lifecycle (ref-counted singleton). */
function useTickConnection(enabled: boolean) {
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
}

/**
 * useInstrumentTick — subscribe to ONE contract's ticks only.
 *
 * Returns the latest TickData for `exchange:securityId` and re-renders the
 * caller only when THAT contract ticks. Use this in per-row hot paths (e.g.
 * open trade rows). It manages the WS connection; a parent `useTickFeed` runs
 * the polling fallback.
 */
export function useInstrumentTick(
  exchange?: string | null,
  securityId?: string | null,
): TickData | undefined {
  useTickConnection(true);
  const key = exchange && securityId ? `${exchange}:${securityId}` : null;
  useSyncExternalStore(
    useCallback((cb: () => void) => (key ? subscribeKey(key, cb) : () => {}), [key]),
    useCallback(() => (key ? keyVersions.get(key) ?? 0 : 0), [key]),
  );
  return key ? tickStore.get(key) : undefined;
}

// ── Feed-only hook ───────────────────────────────────────────────
/**
 * useTickFeed — keep the live feed CONNECTED (WS + polling fallback) WITHOUT
 * subscribing to the global tick stream. Use this when a component only needs
 * the feed running (e.g. the app shell) and must NOT re-render on every tick.
 * Read ticks reactively via `useInstrumentTick` (per-contract) instead.
 */
export function useTickFeed(enabled = true) {
  useTickConnection(enabled);

  // Polling fallback (only when WS is not connected)
  const snapshotQuery = trpc.broker.feed.snapshot.useQuery(undefined, {
    enabled: enabled && !wsConnected,
    refetchInterval: 2000,
    refetchIntervalInBackground: true,
    retry: false,
  });

  useEffect(() => {
    if (snapshotQuery.data && Array.isArray(snapshotQuery.data)) {
      for (const tick of snapshotQuery.data) {
        if (tick && tick.securityId && tick.exchange) {
          const key = `${tick.exchange}:${tick.securityId}`;
          const existing = tickStore.get(key);
          if (!existing || tick.timestamp > existing.timestamp) {
            tickStore.set(key, tick as TickData);
            bumpKey(key);
          }
        }
      }
    }
  }, [snapshotQuery.data]);

  return snapshotQuery;
}

export function getTickFromStore(
  exchange: string,
  securityId: string
): TickData | undefined {
  return tickStore.get(`${exchange}:${securityId}`);
}
