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

  /** Emit a SEA signal for live push to browser clients. History lives in
   *  Mongo (sea_signals); this is the real-time fan-out only — no caching. */
  emitSeaSignal(signal: unknown): void {
    this.emit("seaSignal", signal);
  }

  /** Emit the SEA engine liveness snapshot for live push to browser clients.
   *  Replaces UI polling of the seaStatus tRPC query. */
  emitSeaStatus(status: unknown): void {
    this.emit("seaStatus", status);
  }

  /** Emit a portfolio day-record update for live push to browser clients.
   *  Replaces the 2s allDays poll — the client swaps in the pushed day. */
  emitPortfolio(payload: { channel: string; day: unknown }): void {
    this.emit("portfolio", payload);
  }

  /** Signal that a channel's capital state (pools / projections) changed.
   *  Replaces the 3s portfolio.state poll — the client refetches state on this
   *  (infrequent: trade close, inject/reset/transfer), not on a timer. */
  emitCapitalChanged(channel: string): void {
    this.emit("capitalChanged", { channel });
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
