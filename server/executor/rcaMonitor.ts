/**
 * Risk Control Agent (RCA) — Phase 2 monitor.
 *
 * Per RiskControlAgent_Spec_v2.0, RCA watches every open AI position
 * and triggers exits when risk conditions are breached. Phase 1 only
 * had age-exit. Phase 2 adds two more triggers:
 *
 *   1. STALE PRICE — open position hasn't received a tick for X
 *      minutes (default 5). Indicates broker disconnect, contract
 *      illiquidity, or feed gap. Exit before the position drifts
 *      blind. tradeRecord.lastTickAt is stamped by tickHandler.
 *
 *   2. MOMENTUM (signal flip) — the latest filtered SEA signal for
 *      the same instrument now points opposite to the open trade
 *      direction. e.g., we hold LONG_CE on BANKNIFTY and the latest
 *      filtered signal says GO_PUT / LONG_PE. Exit before the
 *      position bleeds further.
 *
 * All Phase 2 triggers reuse executor.exitTrade with reason mapped to
 * the spec vocab (AGE_EXIT for stale-price; MOMENTUM_EXIT for signal
 * flip) and triggeredBy=RCA. A trade exited by Discipline doesn't
 * feed Discipline counters (handled in PA Phase 3); RCA exits do
 * count toward streak / cooldown bookkeeping.
 *
 * Tick interval is 30 s; checks happen sequentially per channel.
 *
 * Lifecycle owned by tradeExecutor.start() / stop().
 */

import { createLogger } from "../broker/logger";
import { portfolioAgent } from "../portfolio";
import { tradeExecutor } from "./tradeExecutor";
import { getSEASignals, type SEASignal } from "../seaSignals";
import type { Channel, TradeRecord } from "../portfolio/state";
import type { ExitTradeReason } from "./types";
import { getExecutorSettings } from "./settings";

const log = createLogger("RcaMonitor");

const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;          // 30 min — Phase 1 trigger
const DEFAULT_STALE_TICK_MS = 5 * 60 * 1000;         // 5 min — Phase 2 trigger
const DEFAULT_VOL_THRESHOLD = 0.7;                   // max_drawdown_pred_30s above which RCA exits
const TICK_INTERVAL_MS = 30_000;                     // 30 s monitor cadence

interface RcaMonitorOptions {
  /** Max position age before age-exit. Default 30 min. */
  maxAgeMs?: number;
  /** Max time without a tick before stale-price exit. Default 5 min. */
  staleTickMs?: number;
  /** max_drawdown_pred_30s above which RCA volatility-exits. Default 0.7. */
  volThreshold?: number;
  /** Channels under RCA supervision. Default ai-paper. */
  channels?: Channel[];
}

/** What kind of RCA-driven exit was triggered. Logged for analytics. */
type RcaExitKind = "AGE" | "STALE_PRICE" | "VOLATILITY" | "MOMENTUM_FLIP";

class RcaMonitor {
  private running = false;
  private tickHandle: NodeJS.Timeout | null = null;
  private maxAgeMs: number = DEFAULT_MAX_AGE_MS;
  private staleTickMs: number = DEFAULT_STALE_TICK_MS;
  private volThreshold: number = DEFAULT_VOL_THRESHOLD;
  private channels: Channel[] = ["ai-paper"];
  /** Trade ids we've already attempted an exit on; prevents retry storms. */
  private exitAttempted = new Set<string>();

  start(opts: RcaMonitorOptions = {}): void {
    if (this.running) return;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.staleTickMs = opts.staleTickMs ?? DEFAULT_STALE_TICK_MS;
    this.volThreshold = opts.volThreshold ?? DEFAULT_VOL_THRESHOLD;
    this.channels = opts.channels ?? ["ai-paper"];
    this.running = true;
    this.tickHandle = setInterval(
      () => this.tick().catch((err) => log.error(`tick: ${err?.message ?? err}`)),
      TICK_INTERVAL_MS,
    );
    log.info(
      `Started — age=${this.maxAgeMs}ms stale=${this.staleTickMs}ms vol>${this.volThreshold} channels=[${this.channels.join(",")}]`,
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

  /** One supervisory pass per channel: evaluate each open position. */
  private async tick(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();

    // Hot-reload thresholds from executor_settings (cached 30 s).
    // Lets the TEA Settings page tune RCA without a server restart.
    try {
      const s = await getExecutorSettings();
      this.maxAgeMs = s.rcaMaxAgeMs;
      this.staleTickMs = s.rcaStaleTickMs;
      this.volThreshold = s.rcaVolThreshold;
    } catch {
      // Defaults already in place; carry on.
    }

    // Build a lookup of latest filtered signal per instrument so the
    // momentum-flip check is a constant-time lookup per trade. Cheaper
    // than re-reading the log per position.
    const latestSignal = this.buildLatestSignalIndex();

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
          await this.exit(channel, trade, "AGE", {
            reason: "AGE_EXIT",
            detail: `Age ${Math.round(ageMs / 60_000)} min ≥ ${this.maxAgeMs / 60_000} min`,
          });
          continue;
        }

        // Stale-price: requires a tick to have arrived once. If
        // lastTickAt is undefined the trade is fresh; only flag once
        // we've seen at least one tick AND it's gone stale.
        if (trade.lastTickAt && now - trade.lastTickAt >= this.staleTickMs) {
          const stillness = now - trade.lastTickAt;
          await this.exit(channel, trade, "STALE_PRICE", {
            reason: "STALE_PRICE_EXIT",
            detail: `No tick for ${Math.round(stillness / 60_000)} min ≥ ${this.staleTickMs / 60_000} min`,
          });
          continue;
        }

        const volSignal = this.lookupSignal(trade, latestSignal);
        if (volSignal && (volSignal.max_drawdown_pred_30s ?? 0) >= this.volThreshold) {
          await this.exit(channel, trade, "VOLATILITY", {
            reason: "VOLATILITY_EXIT",
            detail: `Predicted max-drawdown ${volSignal.max_drawdown_pred_30s?.toFixed(2)} ≥ ${this.volThreshold}`,
          });
          continue;
        }

        if (volSignal && this.isFlippedAgainst(trade, volSignal)) {
          await this.exit(channel, trade, "MOMENTUM_FLIP", {
            reason: "MOMENTUM_EXIT",
            detail: "Latest filtered SEA signal flipped opposite to position",
          });
        }
      }
    }
  }

  /** Map trade.instrument → SEA key, return the latest filtered signal for it. */
  private lookupSignal(trade: TradeRecord, latest: Map<string, SEASignal>): SEASignal | undefined {
    const norm = trade.instrument.toUpperCase().replace(/\s+/g, "");
    const seaKey =
      norm === "NIFTY50" || norm === "NIFTY" ? "NIFTY"
      : norm === "BANKNIFTY" ? "BANKNIFTY"
      : norm === "CRUDEOIL" ? "CRUDEOIL"
      : norm === "NATURALGAS" ? "NATURALGAS"
      : norm;
    return latest.get(seaKey) ?? latest.get(seaKey + "50");
  }

  /**
   * For each instrument we care about, find the most recent filtered
   * SEA signal. Used by the momentum-flip detector.
   */
  private buildLatestSignalIndex(): Map<string, SEASignal> {
    const idx = new Map<string, SEASignal>();
    let signals: SEASignal[] = [];
    try {
      signals = getSEASignals(20, undefined, "filtered");
    } catch {
      return idx;
    }
    // getSEASignals returns newest-first.
    for (const s of signals) {
      const key = s.instrument.toUpperCase();
      if (!idx.has(key)) idx.set(key, s);
    }
    return idx;
  }

  /**
   * True when the latest filtered signal for the trade's instrument
   * points opposite to the position. Handles all four trade types:
   *
   *   CALL_BUY / CALL_SELL → bullish on the underlying
   *   PUT_BUY  / PUT_SELL  → bearish on the underlying
   *
   * Wait — that's wrong. Selling options is more nuanced:
   *
   *   CALL_BUY  : long volatility, bullish underlying  — flip if PUT signal
   *   CALL_SELL : long volatility decay, bearish CE premium — flip if CE premium expected to RISE (i.e., bullish underlying signal)
   *   PUT_BUY   : long volatility, bearish underlying — flip if CALL signal
   *   PUT_SELL  : long volatility decay, bullish PE — flip if PE premium expected to RISE (bearish underlying)
   *
   * Net: a LONG position flips if the signal goes the opposite direction
   * on the underlying. A SHORT (option-write) position flips if the
   * signal goes the SAME direction on the underlying — because the
   * writer wins from premium decay, and a strong directional move
   * against the strike turns the write into a loss.
   */
  private isFlippedAgainst(trade: TradeRecord, sig: SEASignal): boolean {
    const sigAction = sig.action ?? "";
    const sigDirection = sig.direction ?? "";
    const sigBullish = sigAction === "LONG_CE" || sigAction === "SHORT_PE" || sigDirection === "GO_CALL";
    const sigBearish = sigAction === "LONG_PE" || sigAction === "SHORT_CE" || sigDirection === "GO_PUT";

    switch (trade.type) {
      case "CALL_BUY":  return sigBearish;
      case "PUT_BUY":   return sigBullish;
      case "CALL_SELL": return sigBullish; // CE writer flips if model turns bullish
      case "PUT_SELL":  return sigBearish; // PE writer flips if model turns bearish
      default:          return false;
    }
  }

  private async exit(
    channel: Channel,
    trade: TradeRecord,
    kind: RcaExitKind,
    opts: { reason: ExitTradeReason; detail: string },
  ): Promise<void> {
    const positionId = `POS-${trade.id.replace(/^T/, "")}`;
    log.info(`exit ${kind} trade=${trade.id} channel=${channel} — ${opts.detail}`);
    this.exitAttempted.add(trade.id);
    const resp = await tradeExecutor.exitTrade({
      executionId: `RCA-${kind}-${trade.id}-${Date.now()}`,
      positionId,
      channel,
      exitType: "MARKET",
      reason: opts.reason,
      triggeredBy: "RCA",
      detail: opts.detail,
      timestamp: Date.now(),
    });
    if (resp.success) {
      log.info(
        `exit ok kind=${kind} trade=${trade.id} channel=${channel} pnl=${resp.realizedPnl} pct=${resp.realizedPnlPct.toFixed(2)}%`,
      );
    } else {
      log.warn(`exit failed kind=${kind} trade=${trade.id}: ${resp.error}`);
      // Allow retry next tick — transient errors shouldn't permanently
      // block the exit.
      this.exitAttempted.delete(trade.id);
    }
  }
}

export const rcaMonitor = new RcaMonitor();
