/**
 * Discipline Agent — Module 8: Capital Protection & Session Management.
 *
 * Spec: DisciplineAgent_Spec_v1.4 §11. Three responsibilities:
 *
 *   1. Daily profit cap — combined NSE+MCX realized P&L vs the
 *      operator-tunable percent. When breached, fires both NSE and MCX
 *      session halts and starts a grace timer for an operator decision.
 *
 *   2. Daily loss cap — same shape, opposite sign.
 *
 *   3. Carry-forward evaluation — per-exchange cron at the
 *      operator-tunable nseEvalTime / mcxEvalTime. Each open position is
 *      checked against four configurable conditions (profit %, momentum
 *      score, DTE, IV label). PASS → keep overnight; FAIL → request exit
 *      (subject to autoExit + exitDelayMinutes).
 *
 * Design choice — every threshold (cap %, eval times, the four
 * carry-forward conditions, grace seconds, exit delay) is read from the
 * settings parameter. There are NO numeric or time literals in this
 * file's runtime logic; the spec recommendations live in
 * DEFAULT_DISCIPLINE_AGENT_SETTINGS at types.ts.
 */

import type {
  CapGracePeriod,
  CarryForwardEval,
  DisciplineAgentSettings,
  DisciplineState,
  Exchange,
  SessionHalt,
} from "./types";

// ─── Public types ────────────────────────────────────────────────

export type CapitalProtectionStatus =
  | "OK"
  | "PROFIT_CAP_HIT"
  | "LOSS_CAP_HIT"
  | "SESSION_HALTED";

export interface CapitalProtectionVerdict {
  status: CapitalProtectionStatus;
  /** Set when the verdict introduces a halt that wasn't already in state. */
  halts?: { nse?: SessionHalt; mcx?: SessionHalt };
  /** Set when the verdict opens a grace period. */
  grace?: CapGracePeriod;
  /** Set when the verdict fires a hard EXIT_ALL (only after grace expires). */
  signal?: "EXIT_ALL" | "BLOCK_NEW_ENTRIES";
  /** Operator-facing message. */
  reason?: string;
}

// ─── Cap evaluation ──────────────────────────────────────────────

/**
 * Pure: given current state + settings + combined daily P&L percent,
 * decide whether a cap fires now.
 *
 * Inputs from caller:
 * - `combinedPnlPercent`: signed percent of opening capital (+5 = +5%).
 *   Caller computes this from PortfolioAgent's daily P&L numbers.
 * - `now`: pinned for testability.
 *
 * Returns the verdict only; the caller persists state changes via
 * `applyVerdict` (kept separate so the evaluator stays pure).
 */
export function evaluateCapitalProtection(
  state: DisciplineState,
  settings: DisciplineAgentSettings,
  combinedPnlPercent: number,
  now: Date = new Date(),
): CapitalProtectionVerdict {
  const cp = settings.capitalProtection;

  // If session is already halted on either side and there's an active
  // grace period that hasn't been resolved, surface the halt without
  // re-firing the trigger logic.
  const anyHaltActive = state.sessionHalts.nse.triggered || state.sessionHalts.mcx.triggered;
  if (anyHaltActive && state.capGrace && !state.capGrace.acknowledged) {
    if (now >= state.capGrace.deadline) {
      // Grace expired → fire the auto MUST_EXIT.
      return {
        status: "SESSION_HALTED",
        signal: "EXIT_ALL",
        reason: `${state.capGrace.source} grace expired (${cp.gracePeriodSeconds}s) — auto-exiting open positions`,
      };
    }
    // Grace still ticking — block new entries; existing positions stay.
    return {
      status: "SESSION_HALTED",
      signal: "BLOCK_NEW_ENTRIES",
      reason: `${state.capGrace.source} grace active until ${state.capGrace.deadline.toISOString()}`,
    };
  }
  if (anyHaltActive) {
    // Halted but no grace pending (manually halted, or post-grace).
    return {
      status: "SESSION_HALTED",
      signal: "BLOCK_NEW_ENTRIES",
      reason: state.sessionHalts.nse.reason ?? state.sessionHalts.mcx.reason ?? "session halted",
    };
  }

  // Profit cap.
  if (cp.profitCap.enabled && combinedPnlPercent >= cp.profitCap.percent) {
    const halt: SessionHalt = {
      triggered: true,
      triggeredAt: now,
      reason: `Daily profit cap reached: +${combinedPnlPercent.toFixed(2)}% ≥ ${cp.profitCap.percent}%`,
      source: "PROFIT_CAP",
    };
    const grace: CapGracePeriod = {
      startedAt: now,
      deadline: new Date(now.getTime() + cp.gracePeriodSeconds * 1000),
      source: "PROFIT_CAP",
      acknowledged: false,
      userAction: null,
    };
    return {
      status: "PROFIT_CAP_HIT",
      halts: { nse: halt, mcx: halt },
      grace,
      signal: "BLOCK_NEW_ENTRIES",
      reason: halt.reason,
    };
  }

  // Loss cap (loss cap percent is a positive number; combinedPnlPercent
  // is negative when we're losing).
  if (cp.lossCap.enabled && combinedPnlPercent <= -cp.lossCap.percent) {
    const halt: SessionHalt = {
      triggered: true,
      triggeredAt: now,
      reason: `Daily loss cap reached: ${combinedPnlPercent.toFixed(2)}% ≤ -${cp.lossCap.percent}%`,
      source: "LOSS_CAP",
    };
    const grace: CapGracePeriod = {
      startedAt: now,
      deadline: new Date(now.getTime() + cp.gracePeriodSeconds * 1000),
      source: "LOSS_CAP",
      acknowledged: false,
      userAction: null,
    };
    return {
      status: "LOSS_CAP_HIT",
      halts: { nse: halt, mcx: halt },
      grace,
      signal: "BLOCK_NEW_ENTRIES",
      reason: halt.reason,
    };
  }

  return { status: "OK" };
}

/**
 * Mutates the in-memory `state` to apply a verdict. Caller is responsible
 * for persisting the result. Idempotent: applying the same verdict twice
 * leaves state unchanged after the first call.
 */
export function applyVerdict(state: DisciplineState, verdict: CapitalProtectionVerdict): void {
  if (verdict.halts?.nse) state.sessionHalts.nse = verdict.halts.nse;
  if (verdict.halts?.mcx) state.sessionHalts.mcx = verdict.halts.mcx;
  if (verdict.grace) state.capGrace = verdict.grace;
}

// ─── Manual session halt control ────────────────────────────────

/**
 * Operator-driven halt. Used by the future Settings UI override + by
 * the carry-forward evaluator when a position fails its conditions.
 */
export function applySessionHalt(
  state: DisciplineState,
  exchange: Exchange,
  reason: string,
  source: SessionHalt["source"] = "MANUAL",
  now: Date = new Date(),
): void {
  const halt: SessionHalt = { triggered: true, triggeredAt: now, reason, source };
  if (exchange === "NSE") state.sessionHalts.nse = halt;
  if (exchange === "MCX") state.sessionHalts.mcx = halt;
}

/**
 * Operator-driven force-clear. Mirrors the BROKER_DESYNC reconcile
 * pattern from B4: when the operator believes the halt is no longer
 * warranted (e.g. after manual review at end of day), they clear it.
 */
export function clearSessionHalt(state: DisciplineState, exchange: Exchange): void {
  if (exchange === "NSE") state.sessionHalts.nse = { triggered: false };
  if (exchange === "MCX") state.sessionHalts.mcx = { triggered: false };
}

// ─── Per-exchange session-halt gate (consumed by validateTrade) ──

/**
 * Returns the halt object for the relevant exchange, or null if not
 * halted. validateTrade calls this at gate-1 to decide whether to block.
 */
export function getSessionHaltFor(state: DisciplineState, exchange: Exchange): SessionHalt | null {
  const halt = exchange === "NSE" ? state.sessionHalts.nse : state.sessionHalts.mcx;
  return halt.triggered ? halt : null;
}

// ─── Carry-forward evaluation ───────────────────────────────────

export interface CarryForwardPositionInput {
  tradeId: string;
  /** Realised + unrealised P&L as percent of entry value. */
  profitPercent: number;
  /** RCA / SEA score 0-100. */
  momentumScore: number;
  /** Days to expiry. */
  dte: number;
  /** "fair" / "cheap" / "expensive" / "unknown". */
  ivLabel: "fair" | "cheap" | "expensive" | "unknown";
}

export interface CarryForwardOutcome {
  outcome: "PASS" | "FAIL" | "NO_OPEN_POSITIONS";
  evalRecord: CarryForwardEval;
  /** Trades the evaluator wants exited (subject to autoExit / delay). */
  tradesToExit: string[];
}

/**
 * Pure: per-exchange evaluation. Caller filters its open positions to
 * the exchange before invoking. Each position is judged against the
 * four operator-tunable conditions; ALL must pass for CARRY.
 *
 * Returns the outcome + the per-position record for the dashboard.
 */
export function runCarryForwardEvaluation(
  positions: CarryForwardPositionInput[],
  settings: DisciplineAgentSettings,
  now: Date = new Date(),
): CarryForwardOutcome {
  const cf = settings.capitalProtection.carryForward;
  const evalRecord: CarryForwardEval = { ranAt: now, outcome: "NO_OPEN_POSITIONS", positions: [] };

  if (positions.length === 0) {
    return { outcome: "NO_OPEN_POSITIONS", evalRecord, tradesToExit: [] };
  }

  const tradesToExit: string[] = [];

  for (const p of positions) {
    const failed: string[] = [];

    if (p.profitPercent < cf.minProfitPercent) {
      failed.push(`profitPercent ${p.profitPercent.toFixed(2)} < ${cf.minProfitPercent}`);
    }
    if (p.momentumScore < cf.minMomentumScore) {
      failed.push(`momentumScore ${p.momentumScore} < ${cf.minMomentumScore}`);
    }
    if (p.dte < cf.minDte) {
      failed.push(`dte ${p.dte} < ${cf.minDte}`);
    }
    if (cf.ivCondition !== "any") {
      const matchesIv = p.ivLabel === cf.ivCondition;
      if (!matchesIv && p.ivLabel !== "unknown") {
        failed.push(`ivLabel ${p.ivLabel} ≠ ${cf.ivCondition}`);
      }
    }

    const decision: "CARRY" | "EXIT" = failed.length === 0 ? "CARRY" : "EXIT";
    if (decision === "EXIT") tradesToExit.push(p.tradeId);

    evalRecord.positions.push({
      tradeId: p.tradeId,
      profitPercent: p.profitPercent,
      momentumScore: p.momentumScore,
      dte: p.dte,
      ivLabel: p.ivLabel,
      decision,
      failedConditions: failed,
    });
  }

  evalRecord.outcome = tradesToExit.length === 0 ? "PASS" : "FAIL";
  return { outcome: evalRecord.outcome, evalRecord, tradesToExit };
}

/**
 * "HH:mm" → minutes since midnight. Used by the cron scheduler to
 * decide if `now` matches the configured eval time. Pure helper.
 */
export function parseHHmm(s: string): number {
  const m = /^([0-2]\d):([0-5]\d)$/.exec(s);
  if (!m) throw new Error(`Invalid HH:mm: ${s}`);
  return parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10);
}

/**
 * Returns the configured eval time for an exchange — caller uses it to
 * align its cron / scheduler with the operator's settings.
 */
export function getCarryForwardEvalTime(
  settings: DisciplineAgentSettings,
  exchange: Exchange,
): string {
  const cf = settings.capitalProtection.carryForward;
  return exchange === "NSE" ? cf.nseEvalTime : cf.mcxEvalTime;
}
