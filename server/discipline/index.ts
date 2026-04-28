/**
 * Discipline Agent — Orchestrator
 *
 * Singleton that coordinates all discipline modules into a single validation pipeline.
 * Called before every trade placement to check all rules.
 * Also provides methods for post-trade updates (P&L tracking, cooldowns, journal).
 */

import type {
  TradeValidationRequest,
  TradeValidationResult,
  DisciplineState,
  DisciplineAgentSettings,
  Exchange,
} from "./types";
import { getISTDateString } from "./types";
import {
  getDisciplineSettings,
  getDisciplineState,
  updateDisciplineState,
  addViolation,
  saveDailyScore,
} from "./disciplineModel";
import { checkDailyLossLimit, checkConsecutiveLosses } from "./circuitBreaker";
import { checkMaxTrades, checkMaxPositions } from "./tradeLimits";
import { checkCooldown, createRevengeCooldown, createConsecutiveLossCooldown, acknowledgeLoss, resolveOverlappingCooldowns } from "./cooldowns";
import { checkTimeWindow } from "./timeWindows";
import { checkPositionSize, checkExposure } from "./positionSizing";
import { evaluatePreTradeGate } from "./preTrade";
import { checkJournalCompliance, checkWeeklyReview } from "./journalCheck";
import { getStreakStatus, calculateStreakAdjustments, updateStreak } from "./streaks";
import { calculateScore } from "./score";
import {
  evaluateCapitalProtection,
  applyVerdict,
  applySessionHalt,
  getSessionHaltFor,
  runCarryForwardEvaluation,
} from "./capitalProtection";
import {
  startCarryForwardScheduler,
  stopCarryForwardScheduler,
} from "./capitalProtectionScheduler";
import { createLogger } from "../broker/logger";

const log = createLogger("DA", "Agent");

/**
 * Days from today to the given ISO/YYYY-MM-DD expiry date. Local helper
 * for the carry-forward eval (which gets the four-condition `dte` from
 * here). Negative values clamped to 0 — an already-expired contract has
 * 0 days to expiry, not "minus N".
 */
function daysToExpiry(expiry: string): number {
  const target = new Date(expiry);
  if (isNaN(target.getTime())) return 0;
  const ms = target.getTime() - Date.now();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

// ─── Discipline Agent Class ───────────────────────────────────

class DisciplineAgent {
  private static instance: DisciplineAgent;
  private started = false;

  private constructor() {}

  static getInstance(): DisciplineAgent {
    if (!DisciplineAgent.instance) {
      DisciplineAgent.instance = new DisciplineAgent();
    }
    return DisciplineAgent.instance;
  }

  /**
   * Start lifecycle. Currently boots the per-exchange carry-forward
   * scheduler. Idempotent — safe to call from multiple places at boot.
   */
  async start(userId: string = "1"): Promise<void> {
    if (this.started) return;
    this.started = true;
    await startCarryForwardScheduler(userId, async (exchange) => {
      await this.runCarryForwardForExchange(userId, exchange);
    });
    log.important("Started — Discipline Agent (Module 8 carry-forward scheduler online)");
  }

  stop(userId: string = "1"): void {
    if (!this.started) return;
    this.started = false;
    stopCarryForwardScheduler(userId);
    log.important("Stopped");
  }

  /**
   * Per-exchange carry-forward evaluation handler. Called by the
   * scheduler at the configured eval time. Resolves PA's open positions
   * for the exchange, runs the evaluator, applies the verdict, and (TODO
   * C3) fires MUST_EXIT to RCA when carry-forward FAILs.
   *
   * Position resolution is best-effort: if PA is not initialised (unit
   * tests), we log and return — the eval simply doesn't fire. The
   * scheduler reschedules tomorrow regardless.
   */
  private async runCarryForwardForExchange(userId: string, exchange: Exchange): Promise<void> {
    const settings = await getDisciplineSettings(userId);
    const date = getISTDateString();

    // Walk PA's open positions and filter by exchange. PA returns
    // TradeRecord[] per channel; we aggregate across channels and map
    // into CarryForwardPositionInput[]. Position-level momentum + IV +
    // DTE come from RCA / SEA enrichment in C3+; for now we use safe
    // defaults so the eval treats every position as PASS-eligible
    // unless its own profitPercent / DTE fail.
    let positions: import("./capitalProtection").CarryForwardPositionInput[] = [];
    let openTrades: Array<{ tradeId: string; channel: string }> = [];
    try {
      const { portfolioAgent } = await import("../portfolio");
      // Channels we monitor for carry-forward — same as RCA's set.
      const channels = ["my-live", "ai-live", "ai-paper"] as const;
      for (const channel of channels) {
        let trades: Awaited<ReturnType<typeof portfolioAgent.getPositions>> = [];
        try {
          trades = await portfolioAgent.getPositions(channel);
        } catch {
          continue;
        }
        for (const t of trades) {
          if (t.status !== "OPEN") continue;
          const isMcx = t.instrument.includes("CRUDE") || t.instrument.includes("NATURAL");
          const tradeExchange: Exchange = isMcx ? "MCX" : "NSE";
          if (tradeExchange !== exchange) continue;
          const grossEntryValue = t.entryPrice * t.qty;
          const profitPercent = grossEntryValue > 0 ? (t.unrealizedPnl / grossEntryValue) * 100 : 0;
          const dte = t.expiry ? daysToExpiry(t.expiry) : 0;
          positions.push({
            tradeId: t.id,
            profitPercent,
            momentumScore: 100,    // TODO(C3): pull from RCA / SEA latest signal
            dte,
            ivLabel: "fair",        // TODO(C3): pull from option-chain IV classification
          });
          openTrades.push({ tradeId: t.id, channel });
        }
      }
    } catch {
      log.warn(`Carry-forward eval skipped for ${exchange} — PA not initialised`);
      return;
    }

    const result = runCarryForwardEvaluation(positions, settings);

    // Persist the eval record on the (userId, channel="my-live", date)
    // discipline_state doc — separate records per channel are a Phase D
    // concern (single per-user dashboard view today).
    const stateChannel = "my-live";
    const state = await getDisciplineState(userId, date, stateChannel);
    state.carryForwardEvals = state.carryForwardEvals ?? {};
    if (exchange === "NSE") state.carryForwardEvals.nse = result.evalRecord;
    if (exchange === "MCX") state.carryForwardEvals.mcx = result.evalRecord;

    if (result.outcome === "FAIL") {
      applySessionHalt(state, exchange, `Carry-forward eval failed: ${result.tradesToExit.length} position(s) failed conditions`, "CARRY_FORWARD_FAIL");
    }

    await updateDisciplineState(userId, date, {
      carryForwardEvals: state.carryForwardEvals,
      sessionHalts: state.sessionHalts,
    }, stateChannel);

    // C3 wiring: when carry-forward FAILs, push MUST_EXIT to RCA
    // (in-process call — RCA is in the same Node runtime). RCA fans
    // out to the affected trades and exits via TEA with
    // triggeredBy=DISCIPLINE so PA tags the audit trail correctly.
    if (result.outcome === "FAIL" && result.tradesToExit.length > 0 && settings.capitalProtection.carryForward.autoExit) {
      try {
        const { rcaMonitor } = await import("../risk-control");
        const exitRes = await rcaMonitor.disciplineRequest({
          reason: "DISCIPLINE_EXIT",
          detail: `Carry-forward FAIL on ${exchange} — ${result.tradesToExit.length} positions`,
          scope: { kind: "TRADE_IDS", tradeIds: result.tradesToExit },
        });
        log.important(`Carry-forward FAIL → RCA exited ${exitRes.exited}/${result.tradesToExit.length}`);
      } catch (err: any) {
        log.error(`Carry-forward → RCA push failed: ${err?.message ?? err}`);
      }
    }

    log.info(`${exchange} carry-forward eval: ${result.outcome} (${result.tradesToExit.length} exits)`);
  }

  // ─── Pre-Trade Validation Pipeline ─────────────────────────

  /**
   * Run all discipline checks before a trade is placed.
   * Returns a comprehensive result with pass/fail for each module.
   */
  async validateTrade(
    userId: string,
    request: TradeValidationRequest,
    currentCapital: number,
    currentExposure: number,
    channel: string = "my-live",
  ): Promise<TradeValidationResult> {
    const date = getISTDateString();
    const settings = await getDisciplineSettings(userId);
    const state = await getDisciplineState(userId, date, channel);

    // Apply streak adjustments before validation
    const streakAdjustments = calculateStreakAdjustments(state, settings);
    if (streakAdjustments.length > 0) {
      state.activeAdjustments = streakAdjustments;
      await updateDisciplineState(userId, date, { activeAdjustments: streakAdjustments }, channel);
    }

    const blockedBy: string[] = [];
    const warnings: string[] = [];
    const adjustments: string[] = [];

    // 0. B4 — BROKER_DESYNC gate. If ANY trade on this channel is in
    //    desync state, block new entries until the operator reconciles.
    //    Without this, the operator can stack trades on top of an unknown
    //    broker-side exposure.
    try {
      const { portfolioAgent } = await import("../portfolio");
      const desync = await portfolioAgent.hasUnresolvedDesync(channel as never);
      if (desync) blockedBy.push("brokerDesync");
    } catch {
      // PA not initialised in this context (e.g., unit test) — skip gate.
    }

    // 0a. Module 8 — Capital Protection session halt (per-exchange).
    //     Blocks new entries on the side (NSE/MCX) that's halted. Cap-
    //     triggered halts happen in onTradeClosed when daily P&L crosses
    //     a threshold; manual halts via Settings. Halt latches until the
    //     next trading day or operator force-clear.
    const halt = getSessionHaltFor(state, request.exchange);
    if (halt) blockedBy.push("sessionHalted");

    // 1. Circuit Breaker
    const cbResult = checkDailyLossLimit(state, settings, currentCapital);
    if (!cbResult.passed) blockedBy.push("circuitBreaker");

    // 2. Consecutive Losses
    const clResult = checkConsecutiveLosses(state, settings);
    if (!clResult.passed) blockedBy.push("consecutiveLosses");

    // 3. Trade Limits
    const tlResult = checkMaxTrades(state, settings);
    if (!tlResult.passed) blockedBy.push("tradeLimits");

    // 4. Max Positions
    const mpResult = checkMaxPositions(state, settings);
    if (!mpResult.passed) blockedBy.push("maxPositions");

    // 5. Cooldown
    const cdResult = checkCooldown(state, settings);
    if (!cdResult.passed) blockedBy.push("cooldown");

    // 6. Time Window
    const twResult = checkTimeWindow(request.exchange, settings);
    if (!twResult.passed) blockedBy.push("timeWindow");

    // 7. Position Size
    const psResult = checkPositionSize(request.estimatedValue, currentCapital, state, settings);
    if (!psResult.passed) blockedBy.push("positionSize");

    // 8. Exposure
    const exResult = checkExposure(request.estimatedValue, currentExposure, currentCapital, state, settings);
    if (!exResult.passed) blockedBy.push("exposure");

    // 9. Journal
    const jResult = checkJournalCompliance(state, settings);
    if (!jResult.passed) blockedBy.push("journal");

    // 10. Weekly Review
    const wrResult = checkWeeklyReview(state, settings);
    if (!wrResult.passed) blockedBy.push("weeklyReview");

    // 11. Pre-Trade Gate
    const ptResult = evaluatePreTradeGate(request, settings);
    if (!ptResult.passed) blockedBy.push("preTrade");
    if (ptResult.softWarnings) warnings.push(...ptResult.softWarnings);

    // 12. Streak notifications
    const streakInfo = getStreakStatus(state, settings);
    if (streakInfo.notifications.length > 0) warnings.push(...streakInfo.notifications);
    if (streakInfo.adjustments.length > 0) adjustments.push(...streakInfo.adjustments);

    // Record violations for any blocks
    if (blockedBy.length > 0) {
      for (const rule of blockedBy) {
        await addViolation(userId, date, {
          ruleId: rule,
          ruleName: rule,
          severity: "hard",
          description: this.getBlockReason(rule, { cbResult, clResult, tlResult, mpResult, cdResult, twResult, psResult, exResult, jResult, ptResult, haltReason: halt?.reason }),
          timestamp: new Date(),
          overridden: false,
        }, channel);
      }
    }

    return {
      allowed: blockedBy.length === 0,
      blockedBy,
      warnings,
      adjustments,
      details: {
        circuitBreaker: { ...cbResult },
        tradeLimits: { ...tlResult, positionsOpen: mpResult.positionsOpen },
        cooldown: { ...cdResult },
        timeWindow: { ...twResult },
        positionSize: { ...psResult, exposurePercent: exResult.exposurePercent },
        journal: { ...jResult },
        preTrade: { ...ptResult },
        streaks: {
          active: streakInfo.active,
          type: streakInfo.type === "none" ? undefined : streakInfo.type,
          length: streakInfo.length,
          adjustments: streakInfo.adjustments,
        },
      },
    };
  }

  // ─── Post-Trade Updates ────────────────────────────────────

  /**
   * Called when a new trade is placed (after validation passes).
   * Increments counters for the (userId, channel).
   */
  async onTradePlaced(userId: string, channel: string = "my-live"): Promise<void> {
    const date = getISTDateString();
    const state = await getDisciplineState(userId, date, channel);
    await updateDisciplineState(userId, date, {
      tradesToday: state.tradesToday + 1,
      openPositions: state.openPositions + 1,
      unjournaledTrades: [...state.unjournaledTrades, `trade_${Date.now()}`],
    }, channel);
  }

  /**
   * Called when a trade is closed. Updates P&L, cooldowns, streaks for
   * the (userId, channel) bucket.
   */
  async onTradeClosed(
    userId: string,
    pnl: number,
    openCapital: number,
    tradeId?: string,
    channel: string = "my-live",
  ): Promise<{ cooldownStarted: boolean; circuitBreakerTriggered: boolean }> {
    const date = getISTDateString();
    const settings = await getDisciplineSettings(userId);
    const state = await getDisciplineState(userId, date, channel);

    const newPnl = state.dailyRealizedPnl + pnl;
    const newLossPercent = openCapital > 0 ? (Math.abs(Math.min(newPnl, 0)) / openCapital) * 100 : 0;
    // Module 8 — combined daily P&L percent (signed). Cap evaluator
    // uses this to decide if a profit or loss cap fires.
    const newDailyPnlPercent = openCapital > 0 ? (newPnl / openCapital) * 100 : 0;

    const updates: Partial<DisciplineState> = {
      dailyRealizedPnl: newPnl,
      dailyLossPercent: newLossPercent,
      dailyPnlPercent: newDailyPnlPercent,
      openPositions: Math.max(0, state.openPositions - 1),
    };

    let cooldownStarted = false;
    let circuitBreakerTriggered = false;

    if (pnl < 0) {
      // Loss — update consecutive losses and check for cooldowns
      updates.consecutiveLosses = state.consecutiveLosses + 1;

      // Revenge cooldown
      const revengeCooldown = createRevengeCooldown(settings, tradeId);
      if (revengeCooldown) {
        updates.activeCooldown = resolveOverlappingCooldowns(state.activeCooldown, revengeCooldown);
        cooldownStarted = true;
      }

      // Consecutive loss cooldown
      if (
        settings.maxConsecutiveLosses.enabled &&
        (updates.consecutiveLosses ?? 0) >= settings.maxConsecutiveLosses.maxLosses
      ) {
        const clCooldown = createConsecutiveLossCooldown(settings);
        if (clCooldown) {
          updates.activeCooldown = resolveOverlappingCooldowns(updates.activeCooldown, clCooldown);
          cooldownStarted = true;
        }
      }

      // Circuit breaker check
      if (
        settings.dailyLossLimit.enabled &&
        newLossPercent >= settings.dailyLossLimit.thresholdPercent
      ) {
        updates.circuitBreakerTriggered = true;
        updates.circuitBreakerTriggeredAt = new Date();
        circuitBreakerTriggered = true;
      }
    } else if (pnl > 0) {
      // Win — reset consecutive losses
      updates.consecutiveLosses = 0;
    }

    // Module 8 — re-evaluate capital protection on every close. Either
    // direction (profit cap, loss cap) can fire. Verdict updates
    // sessionHalts + capGrace in `updates` if a cap triggers; the
    // halt latches until next-day reset or operator force-clear.
    const projectedState = { ...state, ...updates } as DisciplineState;
    const verdict = evaluateCapitalProtection(projectedState, settings, newDailyPnlPercent);
    if (verdict.halts) {
      updates.sessionHalts = {
        nse: verdict.halts.nse ?? state.sessionHalts.nse,
        mcx: verdict.halts.mcx ?? state.sessionHalts.mcx,
      };
    }
    if (verdict.grace) {
      updates.capGrace = verdict.grace;
      // Schedule the auto-EXIT_ALL ticker. When grace expires the
      // operator never acted; we push MUST_EXIT to RCA which fans out
      // exits via TEA. Single setTimeout per cap-fire — duplicates are
      // harmless because the second fire sees acknowledged === true.
      this.scheduleCapGraceDeadline(userId, channel, verdict.grace);
    }

    await updateDisciplineState(userId, date, updates, channel);

    return { cooldownStarted, circuitBreakerTriggered };
  }

  /**
   * Wake at the cap-grace deadline. If the operator never acknowledged,
   * fire MUST_EXIT to RCA which exits all open positions on the channel.
   * Multiple cap fires schedule multiple timers — that's fine, they
   * all check `acknowledged` before acting.
   */
  private scheduleCapGraceDeadline(
    userId: string,
    channel: string,
    grace: import("./types").CapGracePeriod,
  ): void {
    const ms = Math.max(0, grace.deadline.getTime() - Date.now());
    const t = setTimeout(async () => {
      try {
        const date = getISTDateString();
        const state = await getDisciplineState(userId, date, channel);
        if (!state.capGrace || state.capGrace.acknowledged) return;
        if (state.capGrace.deadline.getTime() !== grace.deadline.getTime()) return; // a new grace replaced ours
        log.important(`Cap-grace expired (${grace.source}) — pushing EXIT_ALL to RCA`);
        const { rcaMonitor } = await import("../risk-control");
        await rcaMonitor.disciplineRequest({
          reason: "DISCIPLINE_EXIT",
          detail: `${grace.source} grace expired without operator action`,
          channels: [channel as any],
          scope: { kind: "ALL" },
        });
      } catch (err: any) {
        log.error(`Cap-grace auto-exit failed: ${err?.message ?? err}`);
      }
    }, ms);
    if (typeof t.unref === "function") t.unref();
  }

  /**
   * PA spec §5.2 — receive trade-outcome push from Portfolio Agent.
   *
   * Phase 3: cap-check activation. The exit metadata
   * (`exitReason` / `exitTriggeredBy`) now drives whether the close
   * contributes to streak / cooldown / circuit-breaker counters:
   *
   *   - exitTriggeredBy === "DISCIPLINE" → SKIP. A discipline-driven
   *     exit was forced by the rule engine itself; counting it as a
   *     "loss" would punish the rules for working and double-tax the
   *     same emotional state.
   *   - All other triggers (USER, AI, RCA, BROKER, PA) → record via
   *     the existing onTradeClosed pipeline.
   *
   * Per-channel partitioning is still pending — single-user `userId="1"`
   * for now.
   */
  async recordTradeOutcome(req: {
    channel: string;
    tradeId: string;
    realizedPnl: number;
    openingCapital: number;
    exitReason?: string;
    exitTriggeredBy?: string;
    signalSource?: string;
  }): Promise<void> {
    if (req.exitTriggeredBy === "DISCIPLINE") {
      // Cap-check-driven exit. Don't feed it back into the cap-check
      // counters; the system already accounted for the loss when it
      // armed the rule. Logged for audit / Head-to-Head reporting only.
      return;
    }
    await this.onTradeClosed("1", req.realizedPnl, req.openingCapital, req.tradeId, req.channel);
  }

  /**
   * Called when the user acknowledges a loss (clicks "I accept the loss").
   * Starts the actual cooldown timer.
   */
  async acknowledgeLoss(userId: string): Promise<{ cooldownEndsAt: Date | null }> {
    const date = getISTDateString();
    const settings = await getDisciplineSettings(userId);
    const state = await getDisciplineState(userId, date);

    if (!state.activeCooldown || state.activeCooldown.acknowledged) {
      return { cooldownEndsAt: null };
    }

    const updated = acknowledgeLoss(state.activeCooldown, settings);
    await updateDisciplineState(userId, date, { activeCooldown: updated });

    return { cooldownEndsAt: updated.endsAt };
  }

  /**
   * Mark a trade as journaled — removes from unjournaled list.
   */
  async journalTrade(userId: string, tradeId: string): Promise<void> {
    const date = getISTDateString();
    const state = await getDisciplineState(userId, date);
    const filtered = state.unjournaledTrades.filter((id) => id !== tradeId);
    await updateDisciplineState(userId, date, { unjournaledTrades: filtered });
  }

  /**
   * Complete the weekly review.
   */
  async completeWeeklyReview(userId: string): Promise<void> {
    const date = getISTDateString();
    await updateDisciplineState(userId, date, { weeklyReviewCompleted: true });
  }

  // ─── End-of-Day Processing ─────────────────────────────────

  /**
   * Called at end of day to finalize score and update streaks.
   */
  async endOfDay(userId: string, dailyPnl: number, openCapital: number): Promise<void> {
    const date = getISTDateString();
    const settings = await getDisciplineSettings(userId);
    const state = await getDisciplineState(userId, date);

    // Calculate final score
    const { score, breakdown } = calculateScore(state, settings);

    // Update streak
    const newStreak = updateStreak(state.currentStreak, dailyPnl, date);
    await updateDisciplineState(userId, date, { currentStreak: newStreak });

    // Save daily score
    await saveDailyScore({
      userId,
      date,
      score,
      breakdown,
      violationCount: state.violations.length,
      tradesToday: state.tradesToday,
      dailyPnl,
      dailyPnlPercent: openCapital > 0 ? (dailyPnl / openCapital) * 100 : 0,
      streakType: newStreak.type,
      streakLength: newStreak.length,
    });
  }

  // ─── Query Methods ─────────────────────────────────────────

  /**
   * Get the current discipline dashboard data.
   */
  async getDashboard(userId: string): Promise<{
    state: DisciplineState;
    settings: DisciplineAgentSettings;
    score: { score: number; breakdown: import("./types").ScoreBreakdown };
    streak: ReturnType<typeof getStreakStatus>;
  }> {
    const date = getISTDateString();
    const settings = await getDisciplineSettings(userId);
    const state = await getDisciplineState(userId, date);
    const { score, breakdown } = calculateScore(state, settings);
    const streak = getStreakStatus(state, settings);

    return { state, settings, score: { score, breakdown }, streak };
  }

  // ─── Private Helpers ───────────────────────────────────────

  private getBlockReason(
    rule: string,
    results: Record<string, any>
  ): string {
    const map: Record<string, string> = {
      brokerDesync: "Broker desync — reconcile open trades before new entries",
      sessionHalted: results.haltReason ?? "Session halted (cap or manual)",
      circuitBreaker: results.cbResult?.reason ?? "Circuit breaker triggered",
      consecutiveLosses: results.clResult?.reason ?? "Consecutive losses limit",
      tradeLimits: results.tlResult?.reason ?? "Trade limit reached",
      maxPositions: results.mpResult?.reason ?? "Max positions reached",
      cooldown: results.cdResult?.reason ?? "Cooldown active",
      timeWindow: results.twResult?.reason ?? "Time window blocked",
      positionSize: results.psResult?.reason ?? "Position size exceeded",
      exposure: results.exResult?.reason ?? "Exposure limit exceeded",
      journal: results.jResult?.reason ?? "Journal entries required",
      weeklyReview: "Weekly review required",
      preTrade: results.ptResult?.reason ?? "Pre-trade gate failed",
    };
    return map[rule] ?? rule;
  }
}

export const disciplineAgent = DisciplineAgent.getInstance();
export { DisciplineAgent };
