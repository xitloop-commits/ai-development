/**
 * Dhan Subscription Manager
 *
 * Manages instrument subscriptions for the Dhan WebSocket feed.
 * - Subscription registry: tracks which securityIds are subscribed and at which mode
 * - Budget tracking: guards against the 5000 instrument Dhan limit
 * - Re-subscribe all on WebSocket reconnect
 *
 * ATM window management and position locking are NOT BSA's concern —
 * consumers own their subscription strategy.
 */

import type {
  ExchangeSegment,
  FeedMode,
  SubscriptionState,
} from "../../types.js";
import {
  DHAN_WS_MAX_INSTRUMENTS_PER_CONN,
} from "./constants.js";

import { createLogger } from "../../logger.js";
const log = createLogger("SubManager");

// ─── Types ─────────────────────────────────────────────────────

export interface SubscribeAction {
  exchange: string;
  securityId: string;
  mode: FeedMode;
}

export interface SubscriptionManagerCallbacks {
  onSubscribe: (instruments: SubscribeAction[]) => void;
  onUnsubscribe: (instruments: { exchange: string; securityId: string }[]) => void;
}

// ─── SubscriptionManager Class ─────────────────────────────────

export class SubscriptionManager {
  private subscriptions = new Map<string, { exchange: string; mode: FeedMode }>();
  private callbacks: SubscriptionManagerCallbacks;
  private maxInstruments: number;

  constructor(
    callbacks: SubscriptionManagerCallbacks,
    maxInstruments = DHAN_WS_MAX_INSTRUMENTS_PER_CONN
  ) {
    this.callbacks = callbacks;
    this.maxInstruments = maxInstruments;
  }

  // ── Public API ─────────────────────────────────────────────────

  /**
   * Subscribe to specific instruments (batch). Deduplicates and enforces budget.
   */
  subscribeManual(instruments: { exchange: string; securityId: string; mode: FeedMode }[]): void {
    const toAdd: SubscribeAction[] = [];

    for (const inst of instruments) {
      const key = `${inst.exchange}:${inst.securityId}`;
      if (!this.subscriptions.has(key)) {
        if (this.subscriptions.size >= this.maxInstruments) {
          log.warn(`Max instruments (${this.maxInstruments}) reached. Cannot subscribe ${key}`);
          continue;
        }
        this.subscriptions.set(key, { exchange: inst.exchange, mode: inst.mode });
        toAdd.push({
          exchange: inst.exchange,
          securityId: inst.securityId,
          mode: inst.mode,
        });
      }
    }

    if (toAdd.length > 0) {
      this.callbacks.onSubscribe(toAdd);
    }
  }

  /**
   * Unsubscribe from specific instruments (batch). Removes from registry.
   */
  unsubscribeManual(instruments: { exchange: string; securityId: string }[]): void {
    const toRemove: { exchange: string; securityId: string }[] = [];

    for (const inst of instruments) {
      const key = `${inst.exchange}:${inst.securityId}`;
      if (this.subscriptions.has(key)) {
        this.subscriptions.delete(key);
        toRemove.push(inst);
      }
    }

    if (toRemove.length > 0) {
      this.callbacks.onUnsubscribe(toRemove);
    }
  }

  /**
   * Re-subscribe all currently registered instruments.
   * Called automatically on WebSocket reconnect.
   */
  resubscribeAll(): void {
    const all = this.getAllSubscriptions();
    if (all.length > 0) {
      this.callbacks.onSubscribe(all);
      log.info(`Re-subscribed ${all.length} instruments after reconnect`);
    }
  }

  /** Get current subscription state */
  getState(): SubscriptionState {
    return {
      totalSubscriptions: this.subscriptions.size,
      maxSubscriptions: this.maxInstruments,
      instruments: new Map(
        Array.from(this.subscriptions.entries()).map(([key, val]) => [
          key,
          { exchange: val.exchange as ExchangeSegment, mode: val.mode },
        ])
      ),
      wsConnected: true, // caller should override with actual ws state
    };
  }

  /** Get all subscription keys */
  getAllSubscriptions(): SubscribeAction[] {
    return Array.from(this.subscriptions.entries()).map(([key, val]) => {
      const [exchange, securityId] = key.split(":");
      return {
        exchange: exchange || val.exchange,
        securityId: securityId || "",
        mode: val.mode,
      };
    });
  }
}
