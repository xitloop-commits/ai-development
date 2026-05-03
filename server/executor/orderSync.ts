/**
 * Trade Executor — broker order-event forwarder.
 *
 * Listens for broker-emitted OrderUpdate events on tickBus and forwards
 * them to portfolioAgent.applyBrokerOrderEvent, which owns the actual
 * trade reconciliation (single-writer rule, B11-followup 3/3).
 *
 * Lifecycle owned by tradeExecutor.start() / stop().
 */

import { EventEmitter } from "events";
import { tickBus } from "../broker/tickBus";
import { createLogger } from "../broker/logger";
import type { OrderUpdate } from "../broker/types";
import { portfolioAgent } from "../portfolio";

const log = createLogger("TEA", "OrderSync");

class OrderSync extends EventEmitter {
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    tickBus.on("orderUpdate", this.handleOrderUpdate);
    log.important("Started — forwarding broker order events to PA");
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    tickBus.off("orderUpdate", this.handleOrderUpdate);
    log.important("Stopped");
  }

  private handleOrderUpdate = async (update: OrderUpdate): Promise<void> => {
    try {
      const result = await portfolioAgent.applyBrokerOrderEvent(update);
      if (result.matched) {
        log.info(
          `apply ok broker=${update.brokerId} order=${update.orderId} ` +
            `status=${update.status} → trade=${result.tradeId} channel=${result.channel} newStatus=${result.newStatus}`,
        );
        this.emit("sync", {
          channel: result.channel,
          tradeId: result.tradeId,
          status: update.status,
        });
      } else {
        // No matching open trade. Common cases:
        //   - TP / SL leg fills (broker emits these but we track legs only via
        //     trade.brokerOrderId of the entry, not the leg orderIds)
        //   - Stale events for trades closed before this server boot
        log.debug(
          `no match broker=${update.brokerId} order=${update.orderId} status=${update.status} ` +
            `(likely a TP/SL leg or pre-restart event)`,
        );
      }
    } catch (err) {
      log.error(`forward failed: ${(err as Error)?.message ?? err}`);
    }
  };
}

export const orderSync = new OrderSync();
