/**
 * Risk Control Agent (RCA) — Phase 1 monitor.
 *
 * Per RiskControlAgent_Spec_v2.0, RCA is responsible for watching every
 * open position and triggering exits when risk conditions are breached.
 * The full spec covers momentum exits, volatility exits, age exits,
 * stale-price detection, and DISCIPLINE_EXIT propagation.
 *
 * Phase 1 scope (MVP):
 *   - Age-based exit ONLY. Any open AI position older than `maxAgeMs`
 *     (default 30 min) is exited via executor.exitTrade with
 *     reason=AGE_EXIT, triggeredBy=RCA.
 *   - This is the safety net — AI must not hold positions indefinitely
 *     while we're still validating the model. Tighter triggers
 *     (momentum, volatility) ship in Phase 2 once we have a
 *     real-time market-state feed RCA can consume.
 *
 * Channels: ai-paper + ai-live (when activated). My-Trades and Testing
 * channels are user-driven; RCA stays out of them.
 *
 * Lifecycle owned by tradeExecutor.start() / stop().
 */

import { createLogger } from "../broker/logger";
import { portfolioAgent } from "../portfolio";
import { tradeExecutor } from "./tradeExecutor";
import type { Channel, TradeRecord } from "../portfolio/state";

const log = createLogger("RcaMonitor");

const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const TICK_INTERVAL_MS = 30_000;            // 30 seconds

interface RcaMonitorOptions {
  /** Max position age before age-exit. Default 30 min. */
  maxAgeMs?: number;
  /** Channels under RCA supervision. Default ai-paper. */
  channels?: Channel[];
}

class RcaMonitor {
  private running = false;
  private tickHandle: NodeJS.Timeout | null = null;
  private maxAgeMs: number = DEFAULT_MAX_AGE_MS;
  private channels: Channel[] = ["ai-paper"];
  /** Trades we've already attempted to exit; avoids retry spam. */
  private exitAttempted = new Set<string>();

  /**
   * Lifecycle — invoked from tradeExecutor.start(). Idempotent.
   * Optional opts override the defaults at start time.
   */
  start(opts: RcaMonitorOptions = {}): void {
    if (this.running) return;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.channels = opts.channels ?? ["ai-paper"];
    this.running = true;
    this.tickHandle = setInterval(
      () => this.tick().catch((err) => log.error(`tick: ${err?.message ?? err}`)),
      TICK_INTERVAL_MS,
    );
    log.info(
      `Started — age-exit monitor: maxAgeMs=${this.maxAgeMs} channels=[${this.channels.join(",")}]`,
    );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.exitAttempted.clear();
    log.info("Stopped");
  }

  /** One supervisory pass over every monitored channel. */
  private async tick(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    for (const channel of this.channels) {
      let positions: TradeRecord[] = [];
      try {
        positions = await portfolioAgent.getPositions(channel);
      } catch (err: any) {
        log.warn(`getPositions ${channel} failed: ${err?.message ?? err}`);
        continue;
      }
      for (const trade of positions) {
        if (trade.status !== "OPEN") continue;
        if (this.exitAttempted.has(trade.id)) continue;
        const ageMs = now - trade.openedAt;
        if (ageMs >= this.maxAgeMs) {
          await this.exitForAge(channel, trade, ageMs);
        }
      }
    }
  }

  private async exitForAge(channel: Channel, trade: TradeRecord, ageMs: number): Promise<void> {
    const positionId = `POS-${trade.id.replace(/^T/, "")}`;
    const ageMin = Math.round(ageMs / 60_000);
    log.info(`age-exit ${trade.id} on ${channel} (age ${ageMin} min ≥ ${this.maxAgeMs / 60_000} min)`);
    this.exitAttempted.add(trade.id);
    const resp = await tradeExecutor.exitTrade({
      executionId: `RCA-AGE-${trade.id}-${Date.now()}`,
      positionId,
      channel,
      exitType: "MARKET",
      reason: "AGE_EXIT",
      triggeredBy: "RCA",
      detail: `Age ${ageMin} min exceeded ${this.maxAgeMs / 60_000} min limit`,
      timestamp: Date.now(),
    });
    if (resp.success) {
      log.info(
        `age-exit ok trade=${trade.id} channel=${channel} pnl=${resp.realizedPnl} ` +
          `pct=${resp.realizedPnlPct.toFixed(2)}%`,
      );
    } else {
      log.warn(`age-exit failed trade=${trade.id}: ${resp.error}`);
      // Allow retry on next tick if the exit failed for a transient reason.
      this.exitAttempted.delete(trade.id);
    }
  }
}

export const rcaMonitor = new RcaMonitor();
