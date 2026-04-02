/**
 * Dhan Subscription Manager
 *
 * Manages instrument subscriptions with:
 * - ATM sliding window: auto-subscribe +/- N strikes from ATM
 * - Position-aware: open positions always subscribed regardless of ATM distance
 * - Dynamic rebalance: when underlying crosses a strike boundary, shift window
 * - Budget tracking: respects max 5000 instruments per connection
 *
 * The manager does NOT own the WebSocket — it tells the DhanWebSocket
 * what to subscribe/unsubscribe via callbacks.
 */

import type {
  ExchangeSegment,
  FeedMode,
  SubscriptionState,
  ATMWindowConfig,
} from "../../types.js";
import {
  DHAN_WS_MAX_INSTRUMENTS_PER_CONN,
} from "./constants.js";

const LOG_PREFIX = "[SubMgr]";

// ─── Types ─────────────────────────────────────────────────────

interface InstrumentKey {
  exchange: string;
  securityId: string;
  mode: FeedMode;
}

interface StrikeInfo {
  securityId: string;
  strike: number;
  optionType: "CE" | "PE";
}

interface ATMWindowState {
  underlying: string;
  expiry: string;
  exchange: ExchangeSegment;
  strikeWindow: number;
  currentATM: number;
  strikeGap: number;
  allStrikes: StrikeInfo[];
  subscribedStrikes: Set<string>; // securityIds currently subscribed
}

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
  private positionSubscriptions = new Set<string>(); // keys that are position-locked
  private atmWindows = new Map<string, ATMWindowState>(); // key: "underlying:expiry"
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
   * Subscribe to specific instruments (manual/explicit).
   * These are NOT managed by ATM window — they persist until explicitly unsubscribed.
   */
  subscribeManual(instruments: InstrumentKey[]): void {
    const toAdd: SubscribeAction[] = [];

    for (const inst of instruments) {
      const key = `${inst.exchange}:${inst.securityId}`;
      if (!this.subscriptions.has(key)) {
        if (this.subscriptions.size >= this.maxInstruments) {
          console.warn(
            `${LOG_PREFIX} Max instruments (${this.maxInstruments}) reached. Cannot subscribe ${key}`
          );
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
   * Unsubscribe from specific instruments (manual/explicit).
   * Will NOT unsubscribe position-locked instruments.
   */
  unsubscribeManual(instruments: { exchange: string; securityId: string }[]): void {
    const toRemove: { exchange: string; securityId: string }[] = [];

    for (const inst of instruments) {
      const key = `${inst.exchange}:${inst.securityId}`;
      if (this.positionSubscriptions.has(key)) {
        console.log(
          `${LOG_PREFIX} Skipping unsubscribe for position-locked ${key}`
        );
        continue;
      }
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
   * Lock instruments for open positions — these stay subscribed
   * regardless of ATM window changes.
   */
  lockPositions(instruments: { exchange: string; securityId: string; mode?: FeedMode }[]): void {
    const toAdd: SubscribeAction[] = [];

    for (const inst of instruments) {
      const key = `${inst.exchange}:${inst.securityId}`;
      this.positionSubscriptions.add(key);

      if (!this.subscriptions.has(key)) {
        const mode = inst.mode || "full";
        this.subscriptions.set(key, { exchange: inst.exchange, mode });
        toAdd.push({
          exchange: inst.exchange,
          securityId: inst.securityId,
          mode,
        });
      }
    }

    if (toAdd.length > 0) {
      this.callbacks.onSubscribe(toAdd);
      console.log(
        `${LOG_PREFIX} Locked ${instruments.length} position instruments`
      );
    }
  }

  /**
   * Unlock instruments when positions are closed.
   * They may still remain subscribed if within ATM window.
   */
  unlockPositions(instruments: { exchange: string; securityId: string }[]): void {
    for (const inst of instruments) {
      const key = `${inst.exchange}:${inst.securityId}`;
      this.positionSubscriptions.delete(key);
    }

    // Check if any unlocked instruments are outside all ATM windows
    const toRemove: { exchange: string; securityId: string }[] = [];
    for (const inst of instruments) {
      const key = `${inst.exchange}:${inst.securityId}`;
      if (!this.isInAnyATMWindow(inst.securityId)) {
        this.subscriptions.delete(key);
        toRemove.push(inst);
      }
    }

    if (toRemove.length > 0) {
      this.callbacks.onUnsubscribe(toRemove);
    }
  }

  /**
   * Set up an ATM sliding window for an underlying+expiry.
   * Subscribes to +/- strikeWindow strikes from ATM.
   */
  setupATMWindow(
    config: ATMWindowConfig,
    strikes: StrikeInfo[],
    strikeGap: number,
    currentATM: number
  ): void {
    const windowKey = `${config.underlying}:${config.expiry}`;

    // Sort strikes by strike price
    const sortedStrikes = [...strikes].sort((a, b) => a.strike - b.strike);

    const state: ATMWindowState = {
      underlying: config.underlying,
      expiry: config.expiry,
      exchange: config.exchange,
      strikeWindow: config.strikeWindow,
      currentATM,
      strikeGap,
      allStrikes: sortedStrikes,
      subscribedStrikes: new Set(),
    };

    this.atmWindows.set(windowKey, state);

    // Calculate and subscribe the initial window
    this.rebalanceATMWindow(windowKey, currentATM);
  }

  /**
   * Update the ATM price — triggers rebalance if ATM crosses a strike boundary.
   */
  updateATM(underlying: string, expiry: string, newLTP: number): void {
    const windowKey = `${underlying}:${expiry}`;
    const state = this.atmWindows.get(windowKey);
    if (!state) return;

    // Calculate new ATM (round to nearest strike gap)
    const newATM =
      Math.round(newLTP / state.strikeGap) * state.strikeGap;

    if (newATM !== state.currentATM) {
      console.log(
        `${LOG_PREFIX} ATM shift: ${state.underlying} ${state.currentATM} → ${newATM}`
      );
      this.rebalanceATMWindow(windowKey, newATM);
    }
  }

  /**
   * Remove an ATM window and unsubscribe its instruments
   * (except position-locked ones).
   */
  removeATMWindow(underlying: string, expiry: string): void {
    const windowKey = `${underlying}:${expiry}`;
    const state = this.atmWindows.get(windowKey);
    if (!state) return;

    const toRemove: { exchange: string; securityId: string }[] = [];
    for (const secId of Array.from(state.subscribedStrikes)) {
      const key = `${state.exchange}:${secId}`;
      if (!this.positionSubscriptions.has(key)) {
        this.subscriptions.delete(key);
        toRemove.push({ exchange: state.exchange, securityId: secId });
      }
    }

    this.atmWindows.delete(windowKey);

    if (toRemove.length > 0) {
      this.callbacks.onUnsubscribe(toRemove);
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

  // ── Private Methods ────────────────────────────────────────────

  private rebalanceATMWindow(windowKey: string, newATM: number): void {
    const state = this.atmWindows.get(windowKey);
    if (!state) return;

    state.currentATM = newATM;

    // Calculate the desired strike range
    const lowerBound = newATM - state.strikeWindow * state.strikeGap;
    const upperBound = newATM + state.strikeWindow * state.strikeGap;

    // Find strikes within the window
    const desiredStrikes = new Set<string>();
    for (const strike of state.allStrikes) {
      if (strike.strike >= lowerBound && strike.strike <= upperBound) {
        desiredStrikes.add(strike.securityId);
      }
    }

    // Diff: what to add, what to remove
    const toAdd: SubscribeAction[] = [];
    const toRemove: { exchange: string; securityId: string }[] = [];

    // New subscriptions
    for (const secId of Array.from(desiredStrikes)) {
      if (!state.subscribedStrikes.has(secId)) {
        const key = `${state.exchange}:${secId}`;
        if (
          !this.subscriptions.has(key) &&
          this.subscriptions.size < this.maxInstruments
        ) {
          this.subscriptions.set(key, {
            exchange: state.exchange,
            mode: "full",
          });
          toAdd.push({
            exchange: state.exchange,
            securityId: secId,
            mode: "full",
          });
        }
      }
    }

    // Removed subscriptions (outside new window)
    for (const secId of Array.from(state.subscribedStrikes)) {
      if (!desiredStrikes.has(secId)) {
        const key = `${state.exchange}:${secId}`;
        // Don't remove position-locked instruments
        if (!this.positionSubscriptions.has(key)) {
          this.subscriptions.delete(key);
          toRemove.push({ exchange: state.exchange, securityId: secId });
        }
      }
    }

    // Update state
    state.subscribedStrikes = desiredStrikes;

    // Execute
    if (toRemove.length > 0) {
      this.callbacks.onUnsubscribe(toRemove);
    }
    if (toAdd.length > 0) {
      this.callbacks.onSubscribe(toAdd);
    }

    console.log(
      `${LOG_PREFIX} ATM window ${state.underlying}: ${desiredStrikes.size} strikes ` +
        `(+${toAdd.length} -${toRemove.length}), ATM=${newATM}, ` +
        `range=[${lowerBound}-${upperBound}]`
    );
  }

  private isInAnyATMWindow(securityId: string): boolean {
    for (const state of Array.from(this.atmWindows.values())) {
      if (state.subscribedStrikes.has(securityId)) return true;
    }
    return false;
  }
}
