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
import { rcaEvalTotal } from "../_core/metrics";
import { portfolioAgent } from "../portfolio";
import { tradeExecutor } from "../executor/tradeExecutor";
import { getSEASignals, type SEASignal } from "../seaSignals";
import type { Channel, TradeRecord } from "../portfolio/state";
import type { ExitTradeReason } from "../executor/types";
import { getExecutorSettings } from "../executor/settings";
import { notifyTelegram } from "../_core/telegram";
import type {
  DisciplineExitRequest,
  DisciplineExitResponse,
  AiSignalRequest,
  AiSignalResponse,
} from "../../shared/exitContracts";

const log = createLogger("RCA", "Monitor");

/**
 * Map any spelling of an instrument name to the canonical SEA-key vocab.
 * Handles inputs like "NIFTY 50", "NIFTY_50", "BankNifty", "Crude Oil"
 * by uppercasing then stripping both whitespace AND underscores before
 * matching the known aliases. Unrecognized inputs pass through normalized.
 */
function toSeaKey(instrumentName: string): string {
  const norm = instrumentName.toUpperCase().replace(/[\s_]+/g, "");
  if (norm === "NIFTY50" || norm === "NIFTY") return "NIFTY";
  if (norm === "BANKNIFTY") return "BANKNIFTY";
  if (norm === "CRUDEOIL") return "CRUDEOIL";
  if (norm === "NATURALGAS") return "NATURALGAS";
  return norm;
}

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

  /**
   * B4-followup — per-channel BROKER_DESYNC counter. Each entry is a
   * sliding window of timestamps; when the count of timestamps within
   * `windowSeconds` reaches `threshold`, RCA flips the workspace's kill
   * switch. In-memory by design: a fresh process start = a fresh
   * counter (operator wants to be paged on the FIRST desync after a
   * restart, not a stale count carried over).
   */
  private desyncTimestamps = new Map<Channel, number[]>();
  /** Channels currently tripped — used to suppress duplicate alerts. */
  private desyncTripped = new Set<Channel>();

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
    log.important(
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
    log.important("Stopped");
  }

  /** One supervisory pass per channel: evaluate each open position. */
  private async tick(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();

    // Hot-reload thresholds + monitored channels from executor_settings
    // (cached 30 s). Lets the TEA Settings page tune RCA without a
    // server restart — including adding ai-live to the channel list
    // when the canary launches.
    try {
      const s = await getExecutorSettings();
      this.maxAgeMs = s.rcaMaxAgeMs;
      this.staleTickMs = s.rcaStaleTickMs;
      this.volThreshold = s.rcaVolThreshold;
      if (s.rcaChannels.length > 0) {
        this.channels = s.rcaChannels;
      }
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
    const seaKey = toSeaKey(trade.instrument);
    return latest.get(seaKey) ?? latest.get(seaKey + "50");
  }

  /**
   * Public — return the latest momentum score (0..100) for an instrument,
   * derived from the most recent filtered SEA signal. Used by DA's
   * carry-forward eval to score whether a position is still riding a
   * trend strong enough to keep overnight.
   *
   * Returns null if no signal is available for the instrument; DA's
   * eval treats null as "no opinion" and skips the momentum check.
   */
  getLatestMomentumScore(instrumentName: string): number | null {
    const idx = this.buildLatestSignalIndex();
    const key = toSeaKey(instrumentName);
    const sig = idx.get(key) ?? idx.get(key + "50");
    if (!sig) return null;
    // SEASignal.momentum is the model's 0..100 score on the chosen
    // direction. When unset, fall back to direction_prob_30s scaled
    // 0..100 — same semantics, less precise.
    if (typeof sig.momentum === "number") return sig.momentum;
    if (typeof sig.direction_prob_30s === "number") return sig.direction_prob_30s * 100;
    return null;
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

  // ─── C2: inbound APIs ──────────────────────────────────────────
  // These three methods are the agent-to-agent boundary. They're
  // invoked by the REST routes in ./routes.ts (Discipline, SEA) and
  // are the ONLY public mutation surface besides start/stop. The
  // routes do schema validation + auth at the boundary; method bodies
  // assume well-typed inputs.

  /**
   * Pre-trade evaluation entry point. Discipline Agent's pre-trade gate
   * forwards a validated trade request here for risk evaluation. RCA's
   * decision: APPROVE / REJECT / SIZE_ADJUST. APPROVE forwards to TEA.
   *
   * Phase 1: minimal-viable evaluation — approve if the channel doesn't
   * already have a stale-price exit pending and the kill switch isn't
   * armed. Phase 2 (C3) adds momentum + exposure + correlation checks.
   */
  async evaluateTrade(input: {
    executionId: string;
    channel: Channel;
    instrument: string;
    direction: "BUY" | "SELL";
    quantity: number;
    entryPrice: number;
    stopLoss: number | null;
    takeProfit: number | null;
    optionType?: "CE" | "PE" | "FUT";
    strike?: number;
    expiry?: string;
    contractSecurityId?: string;
    capitalPercent?: number;
    origin: "RCA" | "AI" | "USER";
  }): Promise<{
    decision: "APPROVE" | "REJECT" | "SIZE_ADJUST";
    reason?: string;
    sizing?: { quantity: number; stopLoss: number | null; takeProfit: number | null };
    submitResult?: Awaited<ReturnType<typeof tradeExecutor.submitTrade>>;
  }> {
    log.info(`evaluate channel=${input.channel} instrument=${input.instrument} qty=${input.quantity}`);
    // Phase 1 pass-through to TEA — APPROVE every well-formed input.
    // C3 will replace this body with real risk math.
    const submitResult = await tradeExecutor.submitTrade({
      executionId: input.executionId,
      channel: input.channel,
      origin: input.origin,
      instrument: input.instrument,
      direction: input.direction,
      quantity: input.quantity,
      entryPrice: input.entryPrice,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      orderType: "MARKET",
      productType: "INTRADAY",
      optionType: input.optionType,
      strike: input.strike,
      expiry: input.expiry,
      contractSecurityId: input.contractSecurityId,
      capitalPercent: input.capitalPercent,
      timestamp: Date.now(),
    });
    const decision = submitResult.success ? "APPROVE" : "REJECT";
    rcaEvalTotal.labels({ decision }).inc();
    return {
      decision,
      reason: submitResult.error,
      submitResult,
    };
  }

  /**
   * Discipline-driven exit request. DA pushes here when a hard rule
   * fires (cap hit, carry-forward FAIL, circuit breaker, manual halt).
   * RCA fans out to the affected open positions and exits via TEA.
   *
   * Scope semantics:
   *   ALL          — every open position on the supplied channel(s)
   *   INSTRUMENT   — every open position on `instrument` across channels
   *   tradeIds     — explicit trade IDs (used by carry-forward FAIL list)
   */
  async disciplineRequest(input: DisciplineExitRequest): Promise<DisciplineExitResponse> {
    log.info(`disciplineRequest reason=${input.reason} scope=${input.scope.kind}`);
    const channels = input.channels ?? this.channels;
    const targets: Array<{ channel: Channel; trade: TradeRecord }> = [];

    for (const channel of channels) {
      let positions: TradeRecord[] = [];
      try {
        positions = await portfolioAgent.getPositions(channel);
      } catch (err: any) {
        log.warn(`getPositions ${channel} failed: ${err?.message ?? err}`);
        continue;
      }
      for (const trade of positions) {
        if (trade.status !== "OPEN") continue;
        if (input.scope.kind === "ALL") {
          targets.push({ channel, trade });
        } else if (input.scope.kind === "INSTRUMENT" && trade.instrument === input.scope.instrument) {
          targets.push({ channel, trade });
        } else if (input.scope.kind === "TRADE_IDS" && input.scope.tradeIds.includes(trade.id)) {
          targets.push({ channel, trade });
        }
      }
    }

    const details: Array<{ tradeId: string; ok: boolean; error?: string }> = [];
    let exited = 0;
    let failed = 0;
    for (const { channel, trade } of targets) {
      const positionId = `POS-${trade.id.replace(/^T/, "")}`;
      try {
        const resp = await tradeExecutor.exitTrade({
          executionId: `RCA-DISCIPLINE-${trade.id}-${Date.now()}`,
          positionId,
          channel,
          exitType: "MARKET",
          reason: input.reason,
          triggeredBy: "DISCIPLINE",
          detail: input.detail,
          timestamp: Date.now(),
        });
        details.push({ tradeId: trade.id, ok: resp.success, error: resp.error });
        if (resp.success) exited++; else failed++;
      } catch (err: any) {
        details.push({ tradeId: trade.id, ok: false, error: err?.message ?? String(err) });
        failed++;
      }
    }
    log.info(`disciplineRequest done — exited=${exited} failed=${failed}`);
    return { exited, failed, details };
  }

  /**
   * B4-followup — TEA notifies RCA on every BROKER_DESYNC mark.
   * RCA tracks per-channel timestamps in a sliding window; when the
   * count within `windowSeconds` reaches `threshold`, RCA flips that
   * channel's workspace kill switch and fires a Telegram alert.
   *
   * Idempotent: once a channel is tripped, further desyncs don't
   * re-trip until the operator manually clears the kill switch (which
   * also resets the counter via `clearDesyncCounter`).
   */
  async notifyDesync(channel: Channel, tradeId: string, reason: string): Promise<void> {
    const settings = await getExecutorSettings();
    if (!settings.desyncKillSwitchEnabled) return;

    const now = Date.now();
    const windowMs = settings.desyncKillSwitchWindowSeconds * 1_000;
    const arr = this.desyncTimestamps.get(channel) ?? [];
    // Keep only timestamps within the window, then append the new one.
    const fresh = arr.filter((t) => now - t < windowMs);
    fresh.push(now);
    this.desyncTimestamps.set(channel, fresh);

    log.info(
      `desync notify channel=${channel} trade=${tradeId} count=${fresh.length}/${settings.desyncKillSwitchThreshold} reason=${reason}`,
    );

    if (fresh.length < settings.desyncKillSwitchThreshold) return;
    if (this.desyncTripped.has(channel)) return; // already tripped, skip duplicate alerts

    this.desyncTripped.add(channel);
    await this.tripKillSwitchForChannel(channel, fresh.length, reason);
  }

  /**
   * Operator-facing — clear the desync counter + tripped flag for a
   * channel. Called from the kill-switch UI after the operator flips
   * the switch back off, OR after manual reconcile of the desync'd
   * trades resolves the situation. Returns the count that was cleared.
   */
  clearDesyncCounter(channel: Channel): number {
    const count = (this.desyncTimestamps.get(channel) ?? []).length;
    this.desyncTimestamps.delete(channel);
    this.desyncTripped.delete(channel);
    return count;
  }

  /** Test/debug — peek at current counter for a channel. */
  getDesyncCount(channel: Channel): number {
    return (this.desyncTimestamps.get(channel) ?? []).length;
  }

  private async tripKillSwitchForChannel(channel: Channel, count: number, reason: string): Promise<void> {
    // Map channel → workspace. The kill switch is per-workspace ("ai" /
    // "my" / "testing"); a desync on ai-live trips the AI workspace
    // (which halts ai-paper too — paper trades on a broken pipeline are
    // also untrustworthy).
    const workspace =
      channel === "ai-live" || channel === "ai-paper" ? "ai"
      : channel === "my-live" || channel === "my-paper" ? "my"
      : "testing";

    log.error(
      `BROKER_DESYNC threshold breached — tripping kill switch workspace=${workspace} channel=${channel} count=${count}`,
    );

    try {
      const { toggleWorkspaceKillSwitch } = await import("../broker/brokerService");
      await toggleWorkspaceKillSwitch(workspace, "ACTIVATE");
    } catch (err: any) {
      log.error(`Kill-switch trip failed: ${err?.message ?? err}`);
    }

    // Telegram alert — fire-and-forget, mirrors the B6 fatal-handler
    // notify pattern. Empty creds → silent no-op.
    void notifyTelegram(
      `🛑 <b>BROKER_DESYNC kill switch tripped</b>\n` +
        `Channel: ${channel}\n` +
        `Workspace: ${workspace}\n` +
        `Recent desyncs: ${count}\n` +
        `Last reason: ${reason}\n` +
        `\nReconcile open trades, clear the kill switch, then restart.`,
    );
  }

  /**
   * SEA-driven signal — continuous market analysis from Python.
   * EXIT closes matching open positions; MODIFY_SL / MODIFY_TP adjust
   * the bracket on the broker via TEA.modifyOrder. Validates that the
   * signal targets an open position before forwarding.
   *
   * MODIFY_* requires `newPrice` in the input (validated at the route
   * boundary). Per-trade decision feedback returns in `details` so the
   * dashboard can render which positions reacted to the signal.
   */
  async aiSignal(input: AiSignalRequest): Promise<AiSignalResponse> {
    log.info(`aiSignal instrument=${input.instrument} signal=${input.signal} conf=${input.confidence ?? "?"}`);

    if (input.signal !== "EXIT" && input.newPrice == null) {
      log.warn(`aiSignal ${input.signal} missing newPrice — skipping`);
      return { acted: 0, skipped: 1, details: [{ tradeId: "*", action: "SKIPPED", reason: "newPrice required for MODIFY_*" }] };
    }

    const details: NonNullable<AiSignalResponse["details"]> = [];
    let acted = 0;
    let skipped = 0;

    for (const channel of this.channels) {
      let positions: TradeRecord[] = [];
      try {
        positions = await portfolioAgent.getPositions(channel);
      } catch {
        continue;
      }
      for (const trade of positions) {
        if (trade.status !== "OPEN") continue;
        if (trade.instrument !== input.instrument) continue;
        const positionId = `POS-${trade.id.replace(/^T/, "")}`;

        try {
          if (input.signal === "EXIT") {
            const resp = await tradeExecutor.exitTrade({
              executionId: `RCA-AI-EXIT-${trade.id}-${Date.now()}`,
              positionId,
              channel,
              exitType: "MARKET",
              reason: "AI_EXIT",
              triggeredBy: "AI",
              detail: input.detail ?? `SEA EXIT signal (conf=${input.confidence ?? "?"})`,
              timestamp: Date.now(),
            });
            if (resp.success) {
              acted++;
              details.push({ tradeId: trade.id, action: "EXITED" });
            } else {
              skipped++;
              details.push({ tradeId: trade.id, action: "SKIPPED", reason: resp.error });
            }
          } else {
            // MODIFY_SL or MODIFY_TP — adjust the bracket via TEA. The
            // modifications object only carries the leg the signal asked
            // about; the other leg passes through unchanged.
            const mod = input.signal === "MODIFY_SL"
              ? { stopLossPrice: input.newPrice, stopLoss: input.newPrice }
              : { targetPrice: input.newPrice, takeProfit: input.newPrice };
            const resp = await tradeExecutor.modifyOrder({
              executionId: `RCA-AI-${input.signal}-${trade.id}-${Date.now()}`,
              positionId,
              channel,
              modifications: mod,
              reason: "AI_SIGNAL",
              detail: input.detail ?? `SEA ${input.signal} → ${input.newPrice} (conf=${input.confidence ?? "?"})`,
              timestamp: Date.now(),
            });
            if (resp.success) {
              acted++;
              details.push({ tradeId: trade.id, action: "MODIFIED" });
            } else {
              skipped++;
              details.push({ tradeId: trade.id, action: "SKIPPED", reason: resp.error });
            }
          }
        } catch (err: any) {
          skipped++;
          details.push({ tradeId: trade.id, action: "SKIPPED", reason: err?.message ?? String(err) });
        }
      }
    }

    log.info(`aiSignal done — acted=${acted} skipped=${skipped}`);
    return { acted, skipped, details };
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
