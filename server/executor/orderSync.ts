/**
 * Trade Executor — Order Lifecycle Sync
 *
 * Per TEA spec §6.4 (Order Manager & Lifecycle Tracking) and §4.4 (Broker
 * WebSocket Events). Subscribes to broker order updates from tickBus and
 * reconciles them with the local trade record.
 *
 * Live broker order events handled:
 *   - FILLED          → confirm trade entry; correct entryPrice / qty if
 *                       broker fill diverged from request
 *   - PARTIALLY_FILLED → log; full lifecycle tracking lands in Phase 2
 *   - CANCELLED       → mark trade CANCELLED (entry order rejected)
 *   - REJECTED        → mark trade CANCELLED (broker refused)
 *   - EXPIRED         → mark trade CANCELLED
 *
 * Paper channels never produce broker order updates (MockAdapter is fully
 * in-memory), so this module is effectively live-only. Lifecycle is owned
 * by tradeExecutor.start() / stop() — do not start it directly.
 *
 * NOTE: This module currently writes via state.ts CRUD (upsertDayRecord)
 * because the TP/SL leg case + broker-corrected entryPrice don't map
 * cleanly to PA's existing helpers. Phase 2's storage refactor will
 * introduce a `portfolioAgent.applyBrokerOrderEvent()` single-writer
 * helper to consolidate these.
 */

import { EventEmitter } from "events";
import { tickBus } from "../broker/tickBus";
import { createLogger } from "../broker/logger";
import type { OrderUpdate } from "../broker/types";
import {
  getCapitalState,
  getDayRecord,
  upsertDayRecord,
} from "../portfolio/state";
import type { Channel } from "../portfolio/state";
import { recalculateDayAggregates } from "../portfolio/compounding";

const log = createLogger("TEA", "OrderSync");

const LIVE_CHANNELS: Channel[] = ["my-live", "ai-live", "testing-live"];

class OrderSync extends EventEmitter {
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    tickBus.on("orderUpdate", this.handleOrderUpdate);
    log.important("Started — listening for broker order updates");
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    tickBus.off("orderUpdate", this.handleOrderUpdate);
    log.important("Stopped");
  }

  private handleOrderUpdate = async (update: OrderUpdate): Promise<void> => {
    try {
      await this.processUpdate(update);
    } catch (err) {
      log.error(`Error processing update: ${(err as Error)?.message ?? err}`);
    }
  };

  private async processUpdate(update: OrderUpdate): Promise<void> {
    // Broker emits intermediate statuses too (PENDING → OPEN). Only act on
    // terminal-ish ones; the rest are just lifecycle progress and don't
    // change our local state until they resolve.
    if (
      update.status !== "FILLED" &&
      update.status !== "CANCELLED" &&
      update.status !== "REJECTED" &&
      update.status !== "EXPIRED"
    ) {
      return;
    }

    // Brokers don't tell us which channel the order belongs to. Each live
    // channel could have placed it — scan all three. First match wins.
    for (const channel of LIVE_CHANNELS) {
      const state = await getCapitalState(channel).catch(() => null);
      if (!state) continue;

      const day = await getDayRecord(channel, state.currentDayIndex).catch(() => null);
      if (!day) continue;

      const trade = day.trades.find(
        (t) =>
          t.brokerOrderId === update.orderId &&
          // B11-followup 2/3 — also match broker identity. Trades placed
          // before this commit have brokerId=null; for those we fall back
          // to orderId-only (legacy behaviour) so existing OPEN positions
          // continue to reconcile.
          (t.brokerId === null || t.brokerId === update.brokerId) &&
          (t.status === "OPEN" || t.status === "PENDING"),
      );
      if (!trade) continue;

      if (update.status === "FILLED") {
        // Correct entry price + qty if the broker filled at a different
        // price than we sent (slippage on market orders, partial fills).
        if (update.averagePrice > 0 && update.averagePrice !== trade.entryPrice) {
          log.info(`Trade ${trade.id}: entry adjusted ${trade.entryPrice} → ${update.averagePrice}`);
          trade.entryPrice = update.averagePrice;
        }
        if (update.filledQuantity > 0 && update.filledQuantity !== trade.qty) {
          log.info(`Trade ${trade.id}: qty adjusted ${trade.qty} → ${update.filledQuantity}`);
          trade.qty = update.filledQuantity;
        }
        // Promote PENDING → OPEN once the broker confirms the fill.
        if (trade.status === "PENDING") trade.status = "OPEN";
      } else {
        // CANCELLED / REJECTED / EXPIRED — order never made it to market.
        log.info(`Trade ${trade.id}: order ${update.status}, marking CANCELLED`);
        trade.status = "CANCELLED";
        trade.exitPrice = trade.entryPrice;
        trade.pnl = 0;
        trade.unrealizedPnl = 0;
        trade.closedAt = Date.now();
      }

      const updated = recalculateDayAggregates(day);
      await upsertDayRecord(channel, updated);

      this.emit("sync", { channel, tradeId: trade.id, status: update.status });
      return;
    }

    // No matching trade across any live channel. Common cases:
    //   - TP / SL leg fills (broker emits these but we track legs only via
    //     trade.brokerOrderId of the entry, not the leg orderIds)
    //   - Stale events for trades closed before this server boot
    // Logged for debugging only.
    log.debug(
      `No matching open trade for orderId=${update.orderId} status=${update.status} (likely a TP/SL leg or pre-restart event)`,
    );
  }
}

export const orderSync = new OrderSync();
