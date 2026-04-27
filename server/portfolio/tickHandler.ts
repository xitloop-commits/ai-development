/**
 * Portfolio Agent — Tick Handler (was: pnlEngine)
 *
 * Internal service of PortfolioAgent. Subscribes to tickBus and feeds
 * open positions for mark-to-market + auto-exit on TP/SL.
 *
 * Lifecycle is owned by portfolioAgent.start() / stop(). Consumers should
 * use the portfolioAgent singleton — this module's `tickHandler` export
 * is for PA's internal use only.
 *
 * Flow: tickBus.on("tick") → match open trades → update LTP/P&L → persist
 *       → emit pnlUpdate (consumed by SSE / live UI)
 */
import { EventEmitter } from "events";
import { tickBus } from "../broker/tickBus";
import { createLogger } from "../broker/logger";
import {
  getCapitalState,
  getDayRecord,
  upsertDayRecord,
} from "./state";
import type { Channel, TradeRecord } from "./state";
import { recalculateDayAggregates } from "./compounding";
import { getActiveBrokerConfig } from "../broker/brokerConfig";
import type { TickData } from "../broker/types";

const log = createLogger("PA", "TickHandler");

// ─── Types ──────────────────────────────────────────────────────

export interface PnlSnapshot {
  channel: Channel;
  dayIndex: number;
  trades: Array<{
    id: string;
    instrument: string;
    ltp: number;
    unrealizedPnl: number;
    status: string;
  }>;
  totalPnl: number;
  updatedAt: number;
}

/**
 * Fired by tickHandler when an open paper trade hits its TP or SL on an
 * incoming tick. The actual close is the responsibility of the listener
 * (TEA), which routes through portfolioAgent.closeTrade — preserving the
 * single-writer invariant.
 */
export interface AutoExitEvent {
  channel: Channel;
  tradeId: string;
  reason: "TP" | "SL";
  exitPrice: number;
  timestamp: number;
}

/** Channels whose open trades get tick-driven MTM + auto-SL/TP. */
const TICK_CHANNELS: Channel[] = ["my-live", "my-paper", "ai-live", "ai-paper", "testing-live", "testing-sandbox"];

// ─── Instrument → Trade Mapping ─────────────────────────────────

/**
 * Maps instrument names to the securityId used in tick data.
 * For now, trades use instrument names (NIFTY_50, BANKNIFTY, etc.)
 * and ticks use the same names as securityId in mock mode.
 * For Dhan, the adapter resolves securityId from scrip master.
 */
export function tickMatchesTrade(tick: TickData, trade: TradeRecord): boolean {
  // Option trades with a specific contract: ONLY match via contractSecurityId.
  // This prevents underlying-price ticks from being applied to option trades where
  // TP/SL prices are expressed in option-premium terms (CE and PE behave identically
  // in premium space — both profit when premium rises for BUY, falls for SELL).
  if (trade.contractSecurityId) {
    return tick.securityId === trade.contractSecurityId;
  }

  // Direct match: securityId equals instrument name
  if (tick.securityId === trade.instrument) return true;

  // Underlying instrument name aliases (futures / non-option trades)
  const nameMap: Record<string, string[]> = {
    NIFTY_50:   ["NIFTY_50", "NIFTY 50", "NIFTY"],
    BANKNIFTY:  ["BANKNIFTY", "BANK NIFTY", "BANK_NIFTY"],
    CRUDEOIL:   ["CRUDEOIL", "CRUDE OIL", "CRUDE_OIL"],
    NATURALGAS: ["NATURALGAS", "NATURAL GAS", "NATURAL_GAS"],
  };

  for (const [, aliases] of Object.entries(nameMap)) {
    if (aliases.includes(tick.securityId) && aliases.includes(trade.instrument)) {
      return true;
    }
  }

  return false;
}

// ─── Tick Handler (formerly PnlEngine) ─────────────────────────
//
// Subscribes to tickBus and feeds open positions for MTM + auto-exit on
// TP/SL. Owned by PortfolioAgent — see portfolioAgent.start() / stop().
// Emits "pnlUpdate" snapshots that downstream UI consumers can subscribe
// to for live P&L. Class kept as a self-contained service so PA can
// orchestrate lifecycle without a circular dep.

class TickHandler extends EventEmitter {
  private running = false;
  private updateDebounce: NodeJS.Timeout | null = null;
  private pendingUpdates = new Map<string, TickData>(); // key → latest tick
  /** Track peak price per trade for trailing stop logic. Key = tradeId */
  private peakPrices = new Map<string, number>();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /** Start listening to tick bus */
  start(): void {
    if (this.running) return;
    this.running = true;
    tickBus.on("tick", this.handleTick);
    log.important("Started — listening for ticks");
  }

  /** Stop listening */
  stop(): void {
    this.running = false;
    tickBus.off("tick", this.handleTick);
    if (this.updateDebounce) {
      clearTimeout(this.updateDebounce);
      this.updateDebounce = null;
    }
    log.important("Stopped");
  }

  /** Handle incoming tick — debounce to batch updates */
  private handleTick = (tick: TickData): void => {
    const key = `${tick.exchange}:${tick.securityId}`;
    this.pendingUpdates.set(key, tick);

    // Debounce: process all pending ticks every 500ms
    if (!this.updateDebounce) {
      this.updateDebounce = setTimeout(() => {
        this.updateDebounce = null;
        this.processPendingUpdates();
      }, 500);
    }
  };

  /** Process all pending tick updates */
  private async processPendingUpdates(): Promise<void> {
    const ticks = Array.from(this.pendingUpdates.values());
    this.pendingUpdates.clear();

    if (ticks.length === 0) return;

    // Update every channel that gets MTM-driven updates
    for (const channel of TICK_CHANNELS) {
      try {
        await this.updateChannel(channel, ticks);
      } catch (err) {
        // Silently skip — DB might not be connected
      }
    }
  }

  /** Update open trades in a channel with new tick data */
  private async updateChannel(
    channel: Channel,
    ticks: TickData[]
  ): Promise<void> {
    let state;
    try {
      state = await getCapitalState(channel);
    } catch {
      return; // DB not connected
    }

    const day = await getDayRecord(channel, state.currentDayIndex);
    if (!day) return;

    const openTrades = day.trades.filter((t) => t.status === "OPEN");
    if (openTrades.length === 0) return;

    // Read trailing stop config from broker settings (centralized)
    const brokerConfig = await getActiveBrokerConfig();
    const trailingStopEnabled = brokerConfig?.settings?.trailingStopEnabled ?? false;
    const trailingStopPercent = brokerConfig?.settings?.trailingStopPercent ?? 1.0;

    let anyUpdated = false;
    const tradesToExit: Array<{ trade: TradeRecord; reason: "TP" | "SL"; exitPrice: number }> = [];

    for (const trade of openTrades) {
      for (const tick of ticks) {
        if (!tickMatchesTrade(tick, trade)) continue;

        // Update LTP + stamp the tick timestamp so RCA's stale-price
        // monitor can detect broker disconnects / illiquid contracts.
        trade.ltp = tick.ltp;
        trade.lastTickAt = Date.now();
        anyUpdated = true;

        // Check TP/SL triggers for paper/sandbox channels; live channels are managed by broker bracket orders
        if (channel === "my-live" || channel === "ai-live" || channel === "testing-live") continue;
        const isBuy = trade.type.includes("BUY");

        // ── Trailing Stop Logic ──────────────────────────────
        // Track peak price and dynamically trail the stop loss
        const peakKey = trade.id;
        const currentPeak = this.peakPrices.get(peakKey) ?? trade.entryPrice;
        const newPeak = isBuy
          ? Math.max(currentPeak, tick.ltp)
          : Math.min(currentPeak, tick.ltp);
        this.peakPrices.set(peakKey, newPeak);

        // Apply trailing stop if enabled: check trade-level override first, then broker config
        const trailingStopActiveForTrade = trade.trailingStopEnabled !== undefined ? trade.trailingStopEnabled : trailingStopEnabled;
        if (trailingStopActiveForTrade && trade.stopLossPrice !== null && newPeak !== currentPeak) {
          const trailedSL = isBuy
            ? Math.round(newPeak * (1 - trailingStopPercent / 100) * 100) / 100
            : Math.round(newPeak * (1 + trailingStopPercent / 100) * 100) / 100;
          // Only trail in the favorable direction (never widen the stop)
          const shouldTrail = isBuy
            ? trailedSL > trade.stopLossPrice
            : trailedSL < trade.stopLossPrice;
          if (shouldTrail) {
            trade.stopLossPrice = trailedSL;
            anyUpdated = true;
          }
        }

        if (trade.targetPrice !== null) {
          const tpHit = isBuy
            ? tick.ltp >= trade.targetPrice
            : tick.ltp <= trade.targetPrice;
          if (tpHit) {
            this.peakPrices.delete(peakKey); // cleanup
            tradesToExit.push({ trade, reason: "TP", exitPrice: tick.ltp });
            continue; // Don't check SL if TP hit
          }
        }
        if (trade.stopLossPrice !== null) {
          const slHit = isBuy
            ? tick.ltp <= trade.stopLossPrice
            : tick.ltp >= trade.stopLossPrice;
          if (slHit) {
            this.peakPrices.delete(peakKey); // cleanup
            tradesToExit.push({ trade, reason: "SL", exitPrice: tick.ltp });
          }
        }
      }
    }

    // Emit autoExitDetected for each triggered trade — TEA listens and
    // routes the close through portfolioAgent.closeTrade so the single-
    // writer invariant holds. tickHandler is detection-only; it does NOT
    // mutate the trade record itself.
    for (const { trade, reason, exitPrice } of tradesToExit) {
      const event: AutoExitEvent = {
        channel,
        tradeId: trade.id,
        reason,
        exitPrice,
        timestamp: Date.now(),
      };
      this.emit("autoExitDetected", event);
    }

    if (!anyUpdated) return;

    // Recalculate day aggregates and persist
    const updated = recalculateDayAggregates(day);
    await upsertDayRecord(channel, updated);

    // Emit snapshot for SSE consumers
    const snapshot: PnlSnapshot = {
      channel,
      dayIndex: state.currentDayIndex,
      trades: updated.trades
        .filter((t) => t.status === "OPEN")
        .map((t) => ({
          id: t.id,
          instrument: t.instrument,
          ltp: t.ltp,
          unrealizedPnl: t.unrealizedPnl,
          status: t.status,
        })),
      totalPnl: updated.totalPnl,
      updatedAt: Date.now(),
    };
    this.emit("pnlUpdate", snapshot);
  }

}

// ─── Singleton ──────────────────────────────────────────────────

export const tickHandler = new TickHandler();
