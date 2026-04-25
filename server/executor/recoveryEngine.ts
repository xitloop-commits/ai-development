/**
 * Trade Executor — Recovery Engine.
 *
 * Per TEA spec §9: backstop for stuck partial fills and missed WS
 * events. When a live broker order fills (or cancels) the broker
 * normally emits a WS event that orderSync picks up. If that event
 * is dropped (network blip, broker hiccup, server restart between
 * place and confirm), the trade sits in PENDING status forever.
 *
 * This engine polls the broker for every PENDING-status open
 * position older than `stuckThresholdMs` (default 60 s) and, when
 * the broker reports a terminal status (FILLED / CANCELLED /
 * REJECTED / EXPIRED), emits a synthetic OrderUpdate on tickBus.
 * orderSync subscribes to tickBus.orderUpdate and reconciles the
 * trade state via its existing pipeline — no duplicate write
 * paths.
 *
 * Lifecycle: tradeExecutor.start() / stop().
 */

import { createLogger } from "../broker/logger";
import { getAdapter } from "../broker/brokerService";
import { tickBus } from "../broker/tickBus";
import { getOpenPositions } from "../portfolio/storage";
import type { Channel } from "../portfolio/state";

const log = createLogger("RecoveryEngine");

const LIVE_CHANNELS: Channel[] = ["my-live", "ai-live", "testing-live"];

/** Default age (ms) before a PENDING position is considered "stuck" and worth polling. */
const DEFAULT_STUCK_THRESHOLD_MS = 60_000;
/** Poll cadence — sweep all live channels once a minute. */
const TICK_INTERVAL_MS = 60_000;

interface RecoveryEngineOptions {
  stuckThresholdMs?: number;
  channels?: Channel[];
}

class RecoveryEngine {
  private running = false;
  private tickHandle: NodeJS.Timeout | null = null;
  private stuckThresholdMs: number = DEFAULT_STUCK_THRESHOLD_MS;
  private channels: Channel[] = LIVE_CHANNELS;
  /** Track recent reconciliation attempts to avoid hammering the broker. */
  private lastPollAt = new Map<string, number>();

  start(opts: RecoveryEngineOptions = {}): void {
    if (this.running) return;
    this.stuckThresholdMs = opts.stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS;
    this.channels = opts.channels ?? LIVE_CHANNELS;
    this.running = true;
    this.tickHandle = setInterval(
      () => this.tick().catch((err) => log.error(`tick: ${err?.message ?? err}`)),
      TICK_INTERVAL_MS,
    );
    log.info(
      `Started — stuckThreshold=${this.stuckThresholdMs}ms channels=[${this.channels.join(",")}]`,
    );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.lastPollAt.clear();
    log.info("Stopped");
  }

  /** Scan every monitored live channel for stuck PENDING orders. */
  private async tick(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    for (const channel of this.channels) {
      const positions = await getOpenPositions(channel).catch(() => []);
      for (const p of positions) {
        if (p.status !== "PENDING") continue;
        if (!p.brokerId) continue;
        if (now - p.openedAt < this.stuckThresholdMs) continue;
        // Avoid polling the same orderId more than once a minute.
        const last = this.lastPollAt.get(p.brokerId) ?? 0;
        if (now - last < TICK_INTERVAL_MS) continue;
        this.lastPollAt.set(p.brokerId, now);
        await this.reconcile(channel, p.brokerId, p.tradeId);
      }
    }
  }

  /**
   * Poll the broker for the live order status. If the broker reports
   * a terminal status, emit a synthetic OrderUpdate on tickBus so
   * orderSync's existing handler reconciles the position. We never
   * write directly to PA from here — orderSync owns the write path
   * (single-writer rule).
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
      if (!isTerminal) return; // still live; orderSync will catch it on the next WS event

      log.info(
        `recover orderId=${orderId} trade=${tradeId} channel=${channel} ` +
          `status=${order.status} filled=${order.filledQuantity} avg=${order.averagePrice} — emitting`,
      );
      tickBus.emitOrderUpdate({
        orderId,
        status: order.status,
        filledQuantity: order.filledQuantity ?? 0,
        averagePrice: order.averagePrice ?? 0,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      log.warn(`reconcile orderId=${orderId} failed: ${err?.message ?? err}`);
    }
  }
}

export const recoveryEngine = new RecoveryEngine();
