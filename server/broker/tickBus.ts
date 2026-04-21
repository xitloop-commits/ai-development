/**
 * Tick Event Bus
 *
 * Global EventEmitter that broadcasts tick data from the active broker adapter
 * to all tRPC subscription consumers. Single source of truth for live market data.
 *
 * Flow: BrokerAdapter.subscribeLTP → tickCallback → tickBus.emit → tRPC SSE → Frontend
 */

import { EventEmitter } from "events";
import type { TickData, OrderUpdate, OptionChainData } from "./types";

/**
 * Chain update payload carried on the "chainUpdate" event and cached in
 * tickBus.latestChains. Keyed by `${underlying}|${expiry}|${segment}`.
 * Mirrors the server's internal DhanAdapter.chainCache content.
 */
export interface ChainUpdate {
  underlying: string;
  expiry: string;
  exchangeSegment: string;
  data: OptionChainData;
}

class TickBus extends EventEmitter {
  private latestTicks = new Map<string, TickData>();
  private latestChains = new Map<string, ChainUpdate>();

  constructor() {
    super();
    this.setMaxListeners(100);
  }

  /** Emit a tick and cache it */
  emitTick(tick: TickData): void {
    const key = `${tick.exchange}:${tick.securityId}`;
    this.latestTicks.set(key, tick);
    this.emit("tick", tick);
  }

  /** Emit raw binary data for direct forwarding to browser clients */
  emitRawBinary(data: Buffer): void {
    this.emit("rawBinary", data);
  }

  /** Emit an order update */
  emitOrderUpdate(update: OrderUpdate): void {
    this.emit("orderUpdate", update);
  }

  /**
   * Emit an option-chain update and cache it. Cached so newly-connected
   * browser clients can hydrate their client store immediately without
   * waiting for the next upstream chain fetch.
   */
  emitChainUpdate(underlying: string, expiry: string, exchangeSegment: string, data: OptionChainData): void {
    const key = `${underlying}|${expiry}|${exchangeSegment}`;
    const payload: ChainUpdate = { underlying, expiry, exchangeSegment, data };
    this.latestChains.set(key, payload);
    this.emit("chainUpdate", payload);
  }

  /** Get the latest cached tick for an instrument */
  getLatestTick(exchange: string, securityId: string): TickData | undefined {
    return this.latestTicks.get(`${exchange}:${securityId}`);
  }

  /** Get all cached ticks */
  getAllTicks(): TickData[] {
    return Array.from(this.latestTicks.values());
  }

  /** Get all cached option chains (used for new-connection hydration) */
  getAllChains(): ChainUpdate[] {
    return Array.from(this.latestChains.values());
  }

  /** Clear all cached ticks */
  clear(): void {
    this.latestTicks.clear();
    this.latestChains.clear();
  }
}

export const tickBus = new TickBus();
