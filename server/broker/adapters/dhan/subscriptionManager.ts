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
const log = createLogger("BSA", "SubManager");

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
  // Each entry carries a refCount so multiple independent subscribers
  // (e.g. several open trades on the same option contract, plus the
  // new-trade-form + quick-order popup composing on the same strike) share
  // one WS subscription without the first close ripping the feed out from
  // under the others. refCount-aware subscribe / unsubscribe pair with each
  // other 1:1 — the WS sub is created on the first subscribe and torn down
  // only when refCount reaches 0.
  private subscriptions = new Map<string, { exchange: string; mode: FeedMode; refCount: number }>();
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
   * Subscribe to specific instruments (batch). Increments the refCount for
   * any instrument already subscribed; only emits a fresh WS subscribe when
   * the entry is being created for the first time. Enforces the per-WS
   * instrument cap on new entries.
   */
  subscribeManual(instruments: { exchange: string; securityId: string; mode: FeedMode }[]): void {
    const toAdd: SubscribeAction[] = [];

    for (const inst of instruments) {
      const key = `${inst.exchange}:${inst.securityId}`;
      const existing = this.subscriptions.get(key);
      if (existing) {
        existing.refCount += 1;
        log.info(`[SUBDIAG] +ref ${key} → refCount=${existing.refCount}`);
        continue;
      }
      if (this.subscriptions.size >= this.maxInstruments) {
        log.warn(`Max instruments (${this.maxInstruments}) reached. Cannot subscribe ${key}`);
        continue;
      }
      this.subscriptions.set(key, { exchange: inst.exchange, mode: inst.mode, refCount: 1 });
      log.important(`[SUBDIAG] NEW-SUB ${key} mode=${inst.mode} → total=${this.subscriptions.size}`);
      toAdd.push({
        exchange: inst.exchange,
        securityId: inst.securityId,
        mode: inst.mode,
      });
    }

    if (toAdd.length > 0) {
      this.callbacks.onSubscribe(toAdd);
      log.important(`[SUBDIAG] sent ${toAdd.length} subscribe(s) to Dhan feed · total instruments=${this.subscriptions.size}`);
    }
  }

  /**
   * Unsubscribe from specific instruments (batch). Decrements the refCount;
   * only emits an actual WS unsubscribe when the count drops to 0. Silent
   * no-op for keys that aren't registered (preserves prior behaviour).
   */
  unsubscribeManual(instruments: { exchange: string; securityId: string }[]): void {
    const toRemove: { exchange: string; securityId: string }[] = [];

    for (const inst of instruments) {
      const key = `${inst.exchange}:${inst.securityId}`;
      const entry = this.subscriptions.get(key);
      if (!entry) continue;
      entry.refCount -= 1;
      if (entry.refCount <= 0) {
        this.subscriptions.delete(key);
        toRemove.push(inst);
        log.important(`[SUBDIAG] DROP-SUB ${key} → total=${this.subscriptions.size}`);
      } else {
        log.info(`[SUBDIAG] -ref ${key} → refCount=${entry.refCount}`);
      }
    }

    if (toRemove.length > 0) {
      this.callbacks.onUnsubscribe(toRemove);
      log.important(`[SUBDIAG] sent ${toRemove.length} unsubscribe(s) to Dhan feed · total instruments=${this.subscriptions.size}`);
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
