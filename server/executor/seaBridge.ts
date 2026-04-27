/**
 * SEA → TEA Bridge.
 *
 * The Signal Engine Agent (SEA, Python) writes filtered trade
 * recommendations to NDJSON logs at
 *   logs/signals/{instrument}/YYYY-MM-DD_filtered_signals.log
 *
 * This bridge polls the recent slice of those logs, maps each new
 * filtered signal to an executor.submitTrade request, and submits it
 * on the configured AI channel (default `ai-paper`). TEA's idempotency
 * store (keyed on `SEA-{signal.id}`) makes replay safe — if the bridge
 * restarts mid-day it can re-scan recent signals without double-placing.
 *
 * Phase 2 scope:
 *   - All four actions: LONG_CE / LONG_PE (buying) + SHORT_CE / SHORT_PE
 *     (selling). Direction = BUY for LONG, SELL for SHORT.
 *   - One contract = one lot (resolved via tradeResolution.resolveLotSize).
 *   - Channel: ai-paper by default. AI Live activation requires the
 *     1-lot cap + wife-funded canary capital + 30-day comparison gate
 *     (separate todos). The 1-lot cap on ai-live applies equally to
 *     short option writes — selling 2 lots is still a cap violation.
 *   - Confidence: any signal with `filtered: true` (SEA already filtered
 *     them; the score / confidence threshold is enforced upstream).
 *   - Margin: TEA / broker handle margin sizing for SHORT writes; the
 *     bridge stays naive about it. Failure modes (insufficient margin)
 *     surface as broker REJECTED → portfolio_events TRADE_REJECTED.
 *
 * Lifecycle: tradeExecutor.start() boots the bridge; stop() halts it.
 * Safe to leave running off-market — getSEASignals returns [] when no
 * log file exists for today.
 */

import { createLogger } from "../broker/logger";
import { getSEASignals, type SEASignal } from "../seaSignals";
import { resolveLotSize } from "./tradeResolution";
import { tradeExecutor } from "./tradeExecutor";
import { getExecutorSettings } from "./settings";
import type { Channel } from "../portfolio/state";

const log = createLogger("TEA", "SeaBridge");

/** Default poll cadence; live value comes from executor_settings. */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Map SEA's instrument vocabulary (uppercase, no spaces) to the
 * canonical instrument names TEA + the resolution helpers expect.
 */
function normalizeInstrument(seaInstrument: string): string {
  switch (seaInstrument.toUpperCase()) {
    case "NIFTY50":
    case "NIFTY":
      return "NIFTY 50";
    case "BANKNIFTY":
      return "BANK NIFTY";
    case "CRUDEOIL":
      return "CRUDE OIL";
    case "NATURALGAS":
      return "NATURAL GAS";
    default:
      return seaInstrument;
  }
}

class SeaBridge {
  private running = false;
  private pollHandle: NodeJS.Timeout | null = null;
  /** Active channel — re-read each poll from executor_settings. */
  private channel: Channel = "ai-paper";
  /** Active poll interval — re-applied when settings change. */
  private intervalMs: number = DEFAULT_POLL_INTERVAL_MS;

  /** Per-instrument timestamp of the most recently processed signal. */
  private highWaterMark = new Map<string, number>();
  /** Direction filter resolved on the latest poll; read by processSignal. */
  private activeDirectionFilter: "LONG_ONLY" | "ALL" = "LONG_ONLY";

  /**
   * Lifecycle — invoked from tradeExecutor.start(). Idempotent.
   * The optional `channel` arg is the BOOT default; on each poll
   * the bridge re-reads channel + cadence + enabled flag + direction
   * filter from executor_settings, so the canary launch can flip
   * `seaBridgeChannel` to "ai-live" without a server restart.
   */
  start(channel: Channel = "ai-paper"): void {
    if (this.running) return;
    this.channel = channel;
    this.running = true;
    // First poll fires immediately so we don't wait 5s for ingest after restart.
    this.poll().catch((err) => log.error(`first poll: ${err?.message ?? err}`));
    this.scheduleNextPoll();
    log.important(`Started — channel=${channel} (poll cadence reads from executor_settings)`);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.highWaterMark.clear();
    log.important("Stopped");
  }

  /**
   * Set up the polling timer using the current `intervalMs`. Called
   * after each settings refresh that changed the cadence.
   */
  private scheduleNextPoll(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = setInterval(
      () => this.poll().catch((err) => log.error(`poll: ${err?.message ?? err}`)),
      this.intervalMs,
    );
  }

  /**
   * Read recent filtered signals across all instruments and forward any
   * that haven't been seen before. Idempotent at the TEA layer via
   * executionId = `SEA-{signal.id}`, so even if our high-water-mark gets
   * lost across restarts, duplicates are caught.
   */
  private async poll(): Promise<void> {
    if (!this.running) return;

    // Hot-reload bridge config from executor_settings (cached 30 s).
    let enabled = true;
    let directionFilter: "LONG_ONLY" | "ALL" = "LONG_ONLY";
    try {
      const s = await getExecutorSettings();
      enabled = s.seaBridgeEnabled;
      directionFilter = s.seaBridgeDirectionFilter;
      // Channel switch (e.g. canary flips ai-paper → ai-live).
      if (s.seaBridgeChannel !== this.channel) {
        log.info(`Channel changed: ${this.channel} → ${s.seaBridgeChannel}`);
        this.channel = s.seaBridgeChannel;
        // Reset watermarks so the new channel processes recent signals.
        this.highWaterMark.clear();
      }
      // Cadence change.
      if (s.seaBridgePollIntervalMs !== this.intervalMs) {
        log.info(`Poll interval changed: ${this.intervalMs}ms → ${s.seaBridgePollIntervalMs}ms`);
        this.intervalMs = s.seaBridgePollIntervalMs;
        this.scheduleNextPoll();
      }
    } catch {
      // Defaults already applied; carry on.
    }
    if (!enabled) return;

    let signals: SEASignal[] = [];
    try {
      // Source "filtered" — only the filtered_signals.log files. SEA's raw
      // log is much noisier and not meant for execution.
      signals = getSEASignals(50, undefined, "filtered");
    } catch (err: any) {
      log.warn(`getSEASignals failed: ${err?.message ?? err}`);
      return;
    }
    if (signals.length === 0) return;
    // Stash the filter so processSignal can read it without re-querying.
    this.activeDirectionFilter = directionFilter;

    // SEA returns newest-first; iterate oldest-first so the high-water-mark
    // advances monotonically.
    for (const signal of [...signals].reverse()) {
      const lastTs = this.highWaterMark.get(signal.instrument) ?? 0;
      if (signal.timestamp <= lastTs) continue;

      try {
        await this.processSignal(signal);
      } catch (err: any) {
        log.warn(`signal ${signal.id} failed: ${err?.message ?? err}`);
      }
      // Advance the watermark even on processing failure — we don't want
      // a malformed signal to block all subsequent ones.
      this.highWaterMark.set(signal.instrument, signal.timestamp);
    }
  }

  private async processSignal(signal: SEASignal): Promise<void> {
    // Phase 1 gate — must be a filtered (high-conviction) signal with
    // explicit entry / tp / sl. Skip raw streamed signals.
    if (!signal.filtered) return;

    // Phase 2: all four actions. Direction is BUY for LONG_*, SELL for SHORT_*.
    const action = signal.action ?? "";
    const isLong = action === "LONG_CE" || action === "LONG_PE";
    const isShort = action === "SHORT_CE" || action === "SHORT_PE";
    if (!isLong && !isShort) return;
    // Direction filter from settings — canary launches LONG-only.
    if (this.activeDirectionFilter === "LONG_ONLY" && isShort) return;
    if (signal.entry == null || signal.sl == null || signal.tp == null) return;

    const isCe = action === "LONG_CE" || action === "SHORT_CE";
    const direction: "BUY" | "SELL" = isLong ? "BUY" : "SELL";
    const optLtp = isCe ? signal.atm_ce_ltp : signal.atm_pe_ltp;
    const secId = isCe ? signal.atm_ce_security_id : signal.atm_pe_security_id;
    if (!optLtp || optLtp <= 0) {
      log.warn(`signal ${signal.id} skipped: no valid LTP for ${isCe ? "CE" : "PE"}`);
      return;
    }

    const instrument = normalizeInstrument(signal.instrument);
    const lotSize = (await resolveLotSize(instrument)) ?? 1;
    if (lotSize <= 0) {
      log.warn(`signal ${signal.id} skipped: could not resolve lot size for ${instrument}`);
      return;
    }

    const resp = await tradeExecutor.submitTrade({
      executionId: `SEA-${signal.id}`,
      channel: this.channel,
      origin: "AI",
      instrument,
      direction,
      quantity: lotSize,
      entryPrice: signal.entry || optLtp,
      stopLoss: signal.sl,
      takeProfit: signal.tp,
      orderType: "MARKET",
      productType: "INTRADAY",
      optionType: isCe ? "CE" : "PE",
      strike: signal.atm_strike,
      contractSecurityId: secId ?? undefined,
      capitalPercent: undefined,
      timestamp: Date.now(),
    });

    if (resp.success) {
      log.info(
        `placed ${action} ${signal.instrument} entry=${signal.entry} sl=${signal.sl} tp=${signal.tp} ` +
          `signal=${signal.id} trade=${resp.tradeId}`,
      );
    } else if (resp.error?.toLowerCase().includes("duplicate executionid")) {
      // Bridge restarted — TEA already saw this signal. Quiet skip.
      log.debug(`signal ${signal.id} already submitted (idempotency replay)`);
    } else {
      log.warn(`signal ${signal.id} rejected: ${resp.error}`);
    }
  }
}

export const seaBridge = new SeaBridge();
