/**
 * optionChainStore — Client-side cache of option-chain metadata.
 *
 * Mirrors entries pushed from the server over /ws/ticks as `chainUpdate`
 * text frames. Keyed by `${underlying}|${expiry}|${exchangeSegment}`.
 *
 * Stores only the static bits of a chain (strike grid + CE/PE security IDs
 * + lot size + spot). LTPs/OI/IV live on the binary tick stream and are NOT
 * duplicated here.
 *
 * Pattern: module-level Map + listener set + useSyncExternalStore —
 * same approach as client/src/hooks/useTickStream.ts. No library deps.
 */
import { useSyncExternalStore } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

export interface StrikeMeta {
  strike: number;
  ceSecurityId: string | null;
  peSecurityId: string | null;
  /** LTP from chain snapshot — updates ~every 5s. For per-tick precision,
   *  read from useTickStream.getTickFromStore(exchange, secId) instead. */
  ceLTP: number;
  peLTP: number;
}

export interface ChainEntry {
  underlying: string;
  expiry: string;
  exchangeSegment: string;
  spotPrice: number;
  lotSize: number;
  timestamp: number;        // server-side chain timestamp (UTC ms)
  updatedAt: number;        // client-side ingest time (Date.now())
  strikes: StrikeMeta[];    // sorted ascending by strike
}

/** Payload shape received on the wire (type=chainUpdate or inside chainSnapshot). */
export interface ChainPayload {
  underlying: string;
  expiry: string;
  exchangeSegment: string;
  spotPrice: number;
  lotSize: number;
  timestamp: number;
  strikes: StrikeMeta[];
}

// ── Store (module-level, singleton) ────────────────────────────────────────

const chainStore = new Map<string, ChainEntry>();
const listeners: Array<() => void> = [];
let storeVersion = 0;

function keyOf(underlying: string, expiry: string, exchangeSegment: string): string {
  return `${underlying}|${expiry}|${exchangeSegment}`;
}

function notifyListeners() {
  storeVersion++;
  for (let i = 0; i < listeners.length; i++) {
    listeners[i]();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function getSnapshot(): number {
  return storeVersion;
}

// ── Mutators ───────────────────────────────────────────────────────────────

/**
 * Ingest one chain payload from the wire. Idempotent — newer timestamps win.
 * Called by the WS message handler in useTickStream and by the fallback
 * tRPC query in useChain consumers.
 */
export function _ingest(p: ChainPayload): void {
  if (!p || !p.underlying || !p.expiry || !p.exchangeSegment) return;
  const key = keyOf(p.underlying, p.expiry, p.exchangeSegment);
  const existing = chainStore.get(key);
  if (existing && existing.timestamp >= p.timestamp) {
    // Same or older snapshot — skip to avoid churn.
    return;
  }
  const sorted = [...p.strikes].sort((a, b) => a.strike - b.strike);
  chainStore.set(key, {
    underlying: p.underlying,
    expiry: p.expiry,
    exchangeSegment: p.exchangeSegment,
    spotPrice: p.spotPrice,
    lotSize: p.lotSize,
    timestamp: p.timestamp,
    updatedAt: Date.now(),
    strikes: sorted,
  });
  notifyListeners();
}

/** Hydrate from a chainSnapshot array (sent on new WS connect). */
export function _ingestBulk(chains: ChainPayload[]): void {
  if (!Array.isArray(chains) || chains.length === 0) return;
  for (const c of chains) _ingest(c);
}

/** Remove an entry (not currently used; for future expiry-rollover handling). */
export function clearChain(underlying: string, expiry: string, exchangeSegment: string): void {
  if (chainStore.delete(keyOf(underlying, expiry, exchangeSegment))) {
    notifyListeners();
  }
}

// ── Readers ────────────────────────────────────────────────────────────────

export function getChain(
  underlying: string,
  expiry: string,
  exchangeSegment: string
): ChainEntry | undefined {
  return chainStore.get(keyOf(underlying, expiry, exchangeSegment));
}

export function getAllChains(): ChainEntry[] {
  return Array.from(chainStore.values());
}

/**
 * Subscribe a component to a specific chain entry. Re-renders only when the
 * store version increments (any entry changes). Consumers that care about
 * exactly this entry should memoize derived values with useMemo.
 */
export function useChain(
  underlying: string | null | undefined,
  expiry: string | null | undefined,
  exchangeSegment: string | null | undefined
): ChainEntry | undefined {
  useSyncExternalStore(subscribe, getSnapshot);
  if (!underlying || !expiry || !exchangeSegment) return undefined;
  return chainStore.get(keyOf(underlying, expiry, exchangeSegment));
}

// ── Dev helper ─────────────────────────────────────────────────────────────

if (typeof window !== "undefined") {
  (window as any).__optionChainStore = {
    getAll: getAllChains,
    get: getChain,
    size: () => chainStore.size,
  };
}
