/**
 * Tick Event Bus
 *
 * Global EventEmitter that broadcasts tick data from the active broker adapter
 * to all tRPC subscription consumers. Single source of truth for live market data.
 *
 * Flow: BrokerAdapter.subscribeLTP → tickCallback → tickBus.emit → tRPC SSE → Frontend
 */

import { EventEmitter } from "events";
import type { TickData, OrderUpdate } from "./types";

class TickBus extends EventEmitter {
  private latestTicks = new Map<string, TickData>();
  private debugCounts = new Map<string, number>();

  constructor() {
    super();
    this.setMaxListeners(100);
  }

  /** Emit a tick and cache it */
  emitTick(tick: TickData): void {
    const key = `${tick.exchange}:${tick.securityId}`;
    this.latestTicks.set(key, tick);
    // DEBUG: Log first 5 ticks per key, then every 100th
    const count = (this.debugCounts.get(key) ?? 0) + 1;
    this.debugCounts.set(key, count);
    if (count <= 5 || count % 100 === 0) {
      console.log(`[TickBus] [DEBUG] emit #${count}: ${key} ltp=${tick.ltp} listeners=${this.listenerCount("tick")}`);
    }
    this.emit("tick", tick);
  }

  /** Emit an order update */
  emitOrderUpdate(update: OrderUpdate): void {
    this.emit("orderUpdate", update);
  }

  /** Get the latest cached tick for an instrument */
  getLatestTick(exchange: string, securityId: string): TickData | undefined {
    return this.latestTicks.get(`${exchange}:${securityId}`);
  }

  /** Get all cached ticks */
  getAllTicks(): TickData[] {
    return Array.from(this.latestTicks.values());
  }

  /** Clear all cached ticks */
  clear(): void {
    this.latestTicks.clear();
  }
}

export const tickBus = new TickBus();
