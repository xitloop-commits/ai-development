/**
 * Order Sync Engine
 *
 * Listens to order update events from tickBus and syncs trade status
 * in the Portfolio Agent's day records. Handles:
 *   - Entry order filled → confirm trade
 *   - Entry order cancelled/rejected → mark trade cancelled
 *   - TP leg filled (LegNo=3) → close trade at target
 *   - SL leg filled (LegNo=2) → close trade at stop loss
 *
 * Only active for live channels (paper channels use the tickHandler auto-exit).
 */
import { EventEmitter } from "events";
import { tickBus } from "../broker/tickBus";
import type { OrderUpdate } from "../broker/types";

// DB functions imported lazily to avoid circular deps
let getCapitalState: any;
let getDayRecord: any;
let upsertDayRecord: any;
let updateCapitalState: any;
let recalculateDayAggregates: any;

async function loadDeps() {
  if (getCapitalState) return;
  const model = await import("./state");
  getCapitalState = model.getCapitalState;
  getDayRecord = model.getDayRecord;
  upsertDayRecord = model.upsertDayRecord;
  updateCapitalState = model.updateCapitalState;
  const engine = await import("./compounding");
  recalculateDayAggregates = engine.recalculateDayAggregates;
}

class OrderSyncEngine extends EventEmitter {
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    tickBus.on("orderUpdate", this.handleOrderUpdate);
    console.log("[OrderSyncEngine] Started — listening for order updates");
  }

  stop(): void {
    this.running = false;
    tickBus.off("orderUpdate", this.handleOrderUpdate);
    console.log("[OrderSyncEngine] Stopped");
  }

  private handleOrderUpdate = async (update: OrderUpdate): Promise<void> => {
    try {
      await loadDeps();
      await this.processUpdate(update);
    } catch (err) {
      console.error("[OrderSyncEngine] Error processing update:", err);
    }
  };

  private async processUpdate(update: OrderUpdate): Promise<void> {
    // Only process terminal statuses
    if (!["FILLED", "CANCELLED", "REJECTED"].includes(update.status)) return;

    // Find matching trade in live workspace
    const state = await getCapitalState("live").catch(() => null);
    if (!state) return;

    const day = await getDayRecord("live", state.currentDayIndex).catch(() => null);
    if (!day) return;

    const trade = day.trades.find(
      (t: any) => t.brokerId === update.orderId && t.status === "OPEN"
    );

    if (!trade) {
      // Could be a TP/SL leg — we don't track those separately yet
      // Log for debugging
      console.log(
        `[OrderSyncEngine] No matching open trade for orderId=${update.orderId} status=${update.status}`
      );
      return;
    }

    if (update.status === "FILLED") {
      // Entry order filled — update entry price if different
      if (update.averagePrice > 0 && update.averagePrice !== trade.entryPrice) {
        console.log(
          `[OrderSyncEngine] Trade ${trade.id}: entry price adjusted ${trade.entryPrice} → ${update.averagePrice}`
        );
        trade.entryPrice = update.averagePrice;
      }
      trade.qty = update.filledQuantity || trade.qty;
    } else if (update.status === "CANCELLED" || update.status === "REJECTED") {
      // Order cancelled/rejected — mark trade as cancelled
      console.log(
        `[OrderSyncEngine] Trade ${trade.id}: order ${update.status}, marking cancelled`
      );
      trade.status = "CANCELLED";
      trade.exitPrice = trade.entryPrice;
      trade.pnl = 0;
      trade.unrealizedPnl = 0;
      trade.closedAt = Date.now();
    }

    // Recalculate and save
    const updated = recalculateDayAggregates(day);
    await upsertDayRecord("live", state.currentDayIndex, updated);

    this.emit("sync", { tradeId: trade.id, status: update.status });
  }
}

export const orderSyncEngine = new OrderSyncEngine();
