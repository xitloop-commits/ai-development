/**
 * Trade Executor — Reconciler (event-driven, no polling).
 *
 * Per TEA spec §9: backstop for order events that the live order-update
 * WS could not deliver because we were DOWN or DISCONNECTED at the moment
 * the broker filled/rejected/cancelled the order. Dhan does NOT replay
 * missed events on reconnect — so the only way to learn the order's fate
 * is to ask the broker once, after we (re)connect.
 *
 * Trigger: the order-update WS emits `orderWsConnected` on every (re)connect
 * (first connect at startup AND every reconnect). We then sweep that broker's
 * live channels ONCE for PENDING orders, ask the broker each order's real
 * status, and — for any terminal status — emit a synthetic OrderUpdate on
 * tickBus. orderSync's existing handler reconciles via applyBrokerOrderEvent
 * (single-writer rule — we never write to PA directly from here).
 *
 * NO timer / NO polling. Steady state runs purely on the live WS stream.
 *
 * Lifecycle: tradeExecutor.start() subscribes / .stop() unsubscribes.
 */

import { createLogger } from "../broker/logger";
import { getAdapter } from "../broker/brokerService";
import { tickBus } from "../broker/tickBus";
import { getPendingPositions } from "../portfolio/storage";
import type { Channel } from "../portfolio/state";

const log = createLogger("TEA", "Reconciler");

const LIVE_CHANNELS: Channel[] = ["my-live", "ai-live", "testing-live"];

/** Don't re-hit the same order within this window if reconnects flap. */
const MIN_RECONCILE_INTERVAL_MS = 15_000;

class Reconciler {
  private running = false;
  private handler: ((payload: { brokerId: string }) => void) | null = null;
  /** Last reconcile attempt per brokerOrderId — guards against reconnect flaps. */
  private lastReconcileAt = new Map<string, number>();

  /** Subscribe to order-WS (re)connect events. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.handler = (payload) => {
      this.reconcileNow(payload?.brokerId).catch((err) =>
        log.error(`reconcileNow: ${err?.message ?? err}`),
      );
    };
    tickBus.on("orderWsConnected", this.handler);
    log.important("Started — reconcile-on-WS-connect (no polling)");
  }

  stop(): void {
    if (this.handler) {
      tickBus.off("orderWsConnected", this.handler);
      this.handler = null;
    }
    this.lastReconcileAt.clear();
    if (this.running) {
      this.running = false;
      log.important("Stopped");
    }
  }

  /**
   * One-shot sweep: for every live channel served by `brokerId`, reconcile all
   * PENDING orders against the broker. Cheap no-op when there are none.
   */
  async reconcileNow(brokerId: string): Promise<void> {
    if (!brokerId) return;
    let swept = 0;
    for (const channel of LIVE_CHANNELS) {
      let adapter;
      try {
        adapter = getAdapter(channel);
      } catch {
        continue;
      }
      if (adapter.brokerId !== brokerId) continue;

      const positions = await getPendingPositions(channel).catch(() => []);
      const now = Date.now();
      for (const p of positions) {
        if (!p.brokerOrderId) continue;
        const last = this.lastReconcileAt.get(p.brokerOrderId) ?? 0;
        if (now - last < MIN_RECONCILE_INTERVAL_MS) continue;
        this.lastReconcileAt.set(p.brokerOrderId, now);
        swept++;
        await this.reconcile(channel, p.brokerOrderId, p.tradeId);
      }
    }
    if (swept > 0) {
      log.important(`reconcile-on-connect broker=${brokerId} swept ${swept} pending order(s)`);
    }
  }

  /**
   * Ask the broker for the live order status. If terminal, emit a synthetic
   * OrderUpdate on tickBus so orderSync's existing handler reconciles the
   * position (single-writer — we never write to PA from here).
   */
  private async reconcile(channel: Channel, orderId: string, tradeId: string): Promise<void> {
    try {
      const adapter = getAdapter(channel);
      const order = await adapter.getOrderStatus(orderId);
      const isTerminal =
        order.status === "FILLED" ||
        order.status === "CANCELLED" ||
        order.status === "REJECTED" ||
        order.status === "EXPIRED";
      if (!isTerminal) return; // still live; the WS stream will carry the rest

      log.info(
        `recover orderId=${orderId} trade=${tradeId} channel=${channel} ` +
          `status=${order.status} filled=${order.filledQuantity} avg=${order.averagePrice}` +
          `${order.reason ? ` reason="${order.reason}"` : ""} — emitting`,
      );
      tickBus.emitOrderUpdate({
        brokerId: adapter.brokerId,
        orderId,
        status: order.status,
        filledQuantity: order.filledQuantity ?? 0,
        averagePrice: order.averagePrice ?? 0,
        timestamp: Date.now(),
        reason: order.reason,
      });
    } catch (err: any) {
      log.warn(`reconcile orderId=${orderId} failed: ${err?.message ?? err}`);
    }
  }
}

/** Kept the `recoveryEngine` export name for existing import sites. */
export const recoveryEngine = new Reconciler();
