/**
 * P&L Engine — Real-time MTM updater for open trades.
 *
 * Listens to tickBus for live ticks and updates:
 *   - trade.ltp (last traded price)
 *   - trade.unrealizedPnl (mark-to-market)
 *   - day aggregates (totalPnl, etc.)
 *
 * Also checks TP/SL triggers and auto-exits trades when hit.
 *
 * Flow: tickBus.on("tick") → match open trades → update LTP/P&L → persist → emit pnlUpdate
 */
import { EventEmitter } from "events";
import { tickBus } from "../broker/tickBus";
import {
  getCapitalState,
  updateCapitalState,
  getDayRecord,
  upsertDayRecord,
} from "./capitalModel";
import type { Channel, DayRecord, TradeRecord } from "./capitalModel";
import { recalculateDayAggregates } from "./capitalEngine";
import { calculateTradeCharges } from "./chargesEngine";
import type { ChargeRate } from "./chargesEngine";
import { getUserSettings } from "../userSettings";
import { getActiveBroker } from "../broker/brokerService";
import { getActiveBrokerConfig } from "../broker/brokerConfig";
import type { OrderParams, TickData } from "../broker/types";

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

// ─── P&L Engine Class ───────────────────────────────────────────

class PnlEngine extends EventEmitter {
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
    console.log("[PnlEngine] Started — listening for ticks");
  }

  /** Stop listening */
  stop(): void {
    this.running = false;
    tickBus.off("tick", this.handleTick);
    if (this.updateDebounce) {
      clearTimeout(this.updateDebounce);
      this.updateDebounce = null;
    }
    console.log("[PnlEngine] Stopped");
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

        // Update LTP
        trade.ltp = tick.ltp;
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

    // Auto-exit triggered trades
    for (const { trade, reason, exitPrice } of tradesToExit) {
      try {
        await this.autoExitTrade(channel, state, day, trade, reason, exitPrice);
        anyUpdated = true;
      } catch (err) {
        console.error(`[PnlEngine] Auto-exit failed for ${trade.id}:`, err);
      }
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

  /** Auto-exit a trade that hit TP or SL */
  private async autoExitTrade(
    channel: Channel,
    state: Awaited<ReturnType<typeof getCapitalState>>,
    day: DayRecord,
    trade: TradeRecord,
    reason: "TP" | "SL",
    exitPrice: number
  ): Promise<void> {
    console.log(
      `[PnlEngine] Auto-exit ${reason}: ${trade.instrument} ${trade.type} @ ${exitPrice} (entry: ${trade.entryPrice})`
    );

    // Send broker exit order for live channels
    const isLiveChannel = channel === "my-live" || channel === "ai-live" || channel === "testing-live";
    if (isLiveChannel && trade.brokerId) {
      const broker = getActiveBroker();
      const config = await getActiveBrokerConfig();
      if (broker && config && !config.isPaperBroker) {
        try {
          const isBuyTxn = trade.type.includes("BUY");
          const optType = trade.type.startsWith("CALL")
            ? ("CE" as const)
            : trade.type.startsWith("PUT")
            ? ("PE" as const)
            : ("FUT" as const);
          const exchange =
            trade.instrument.includes("CRUDE") ||
            trade.instrument.includes("NATURAL")
              ? ("MCX_COMM" as const)
              : ("NSE_FNO" as const);

          const exitOrder: OrderParams = {
            instrument: trade.instrument,
            exchange,
            transactionType: isBuyTxn ? "SELL" : "BUY",
            optionType: optType,
            strike: trade.strike ?? 0,
            expiry: "",
            quantity: trade.qty,
            price: exitPrice,
            orderType: "MARKET",
            productType: config.settings.productType ?? "INTRADAY",
            tag: `AUTO-${reason}-${trade.id}`,
          };

          const result = await broker.placeOrder(exitOrder);
          console.log(
            `[PnlEngine] Broker auto-exit order: ${result.orderId} (${result.status})`
          );
        } catch (err) {
          console.error("[PnlEngine] Broker auto-exit failed:", err);
        }
      }
    }

    // Calculate P&L
    const isBuy = trade.type.includes("BUY");
    const direction = isBuy ? 1 : -1;
    const grossPnl = (exitPrice - trade.entryPrice) * trade.qty * direction;

    // Calculate charges
    const settings = await getUserSettings(1);
    const chargeRates = settings.charges.rates as ChargeRate[];
    const charges = calculateTradeCharges(
      {
        entryPrice: trade.entryPrice,
        exitPrice,
        qty: trade.qty,
        isBuy,
        exchange:
          trade.instrument.includes("CRUDE") ||
          trade.instrument.includes("NATURAL")
            ? "MCX"
            : "NSE",
      },
      chargeRates
    );

    // Update trade record
    trade.exitPrice = exitPrice;
    trade.pnl = Math.round((grossPnl - charges.total) * 100) / 100;
    trade.charges = charges.total;
    trade.chargesBreakdown = charges.breakdown;
    trade.unrealizedPnl = 0;
    trade.ltp = exitPrice;
    trade.closedAt = Date.now();
    trade.status = reason === "TP" ? "CLOSED_TP" : "CLOSED_SL";

    // Update capital state
    await updateCapitalState(channel, {
      sessionPnl: state.sessionPnl + trade.pnl,
      cumulativePnl: state.cumulativePnl + trade.pnl,
      cumulativeCharges: state.cumulativeCharges + charges.total,
    });
  }
}

// ─── Singleton ──────────────────────────────────────────────────

export const pnlEngine = new PnlEngine();
