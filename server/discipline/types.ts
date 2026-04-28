/**
 * Discipline Agent — Type Definitions
 *
 * All types for the discipline pipeline: validation requests/results,
 * intraday state, daily scores, settings, violations, and streaks.
 */

// ─── Exchange & Instrument Mapping ─────────────────────────────

export type Exchange = "NSE" | "MCX";

export type EmotionalState = "calm" | "anxious" | "revenge" | "fomo" | "greedy" | "neutral";

export const INSTRUMENT_EXCHANGE_MAP: Record<string, Exchange> = {
  NIFTY_50: "NSE",
  BANKNIFTY: "NSE",
  CRUDEOIL: "MCX",
  NATURALGAS: "MCX",
};

export const MARKET_HOURS: Record<Exchange, { openHour: number; openMin: number; closeHour: number; closeMin: number }> = {
  NSE: { openHour: 9, openMin: 15, closeHour: 15, closeMin: 30 },
  MCX: { openHour: 9, openMin: 0, closeHour: 23, closeMin: 30 },
};

// ─── Trade Validation Request ──────────────────────────────────

export interface TradeValidationRequest {
  instrument: string;
  exchange: Exchange;
  transactionType: "BUY" | "SELL";
  optionType: "CE" | "PE";
  strike: number;
  entryPrice: number;
  quantity: number;
  estimatedValue: number;          // entryPrice × quantity
  aiConfidence?: number;
  aiRiskReward?: number;
  emotionalState?: EmotionalState;
  planAligned?: boolean;
  checklistDone?: boolean;
  stopLoss?: number;
  target?: number;
}

// ─── Trade Validation Result ───────────────────────────────────

export interface ModuleCheckResult {
  passed: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface TradeValidationResult {
  allowed: boolean;
  blockedBy: string[];
  warnings: string[];
  adjustments: string[];
  details: {
    circuitBreaker: ModuleCheckResult & { dailyLoss?: number; dailyLossPercent?: number };
    tradeLimits: ModuleCheckResult & { tradesUsed?: number; positionsOpen?: number };
    cooldown: ModuleCheckResult & { remainingSeconds?: number; cooldownType?: string };
    timeWindow: ModuleCheckResult & { blockedUntil?: string; exchange?: string };
    positionSize: ModuleCheckResult & { positionPercent?: number; exposurePercent?: number };
    journal: ModuleCheckResult & { unjournaledCount?: number };
    preTrade: ModuleCheckResult & { failedChecks?: string[] };
    streaks: { active: boolean; type?: "winning" | "losing"; length?: number; adjustments?: string[] };
  };
}

// ─── Discipline State (Intraday, per-user, per-day) ────────────

export interface CooldownState {
  type: "revenge" | "consecutive_loss";
  startedAt: Date;
  endsAt: Date;
  acknowledged: boolean;
  triggerTrade?: string;
}

export interface Violation {
  ruleId: string;
  ruleName: string;
  severity: "hard" | "soft";
  description: string;
  timestamp: Date;
  overridden: boolean;
}

export interface ActiveAdjustment {
  rule: string;
  description: string;
  originalValue: number;
  adjustedValue: number;
  appliedAt: Date;
}

export interface StreakState {
  type: "winning" | "losing" | "none";
  length: number;
  startDate: string;
}

export interface DisciplineState {
  userId: string;
  /** Per-channel partition key (e.g. "ai-paper", "my-live"). Defaults
   *  to "my-live" for legacy callers; storage layer enforces uniqueness
   *  on (userId, channel, date). */
  channel?: string;
  date: string;                     // "2026-04-01" IST
  updatedAt: Date;

  // Circuit breaker
  dailyRealizedPnl: number;
  dailyLossPercent: number;
  circuitBreakerTriggered: boolean;
  circuitBreakerTriggeredAt?: Date;

  // Trade counters
  tradesToday: number;
  openPositions: number;
  consecutiveLosses: number;

  // Cooldown
  activeCooldown?: CooldownState;

  // Journal
  unjournaledTrades: string[];

  // Streaks (carried across days)
  currentStreak: StreakState;

  // Auto-adjustments
  activeAdjustments: ActiveAdjustment[];

  // Weekly review
  weeklyReviewCompleted: boolean;
  weeklyReviewDueAt?: Date;

  // Violations
  violations: Violation[];

  // Module 8: Capital Protection & Session Management
  // Daily P&L tracking — combined NSE + MCX. The cap evaluator reads
  // dailyRealizedPnl above (already tracked) and re-derives the percent.
  dailyPnlPercent: number;

  // Module 8: per-exchange session halt. NSE and MCX have different
  // session windows (NSE 9:15-15:30, MCX 9:00-23:30) so an operator
  // can halt one without the other. When a daily cap fires, BOTH are
  // halted simultaneously by the evaluator (the cap is combined-PnL).
  sessionHalts: {
    nse: SessionHalt;
    mcx: SessionHalt;
  };

  // Module 8: carry-forward eval status (per exchange, per day).
  carryForwardEvals: {
    nse?: CarryForwardEval;
    mcx?: CarryForwardEval;
  };

  // Module 8: cap-trigger grace period — when a cap fires, the operator
  // has gracePeriodSeconds to acknowledge. If they don't, MUST_EXIT
  // auto-fires. Null when no grace period is active.
  capGrace: CapGracePeriod | null;
}

// ─── Module 8 sub-types ─────────────────────────────────────────

export interface SessionHalt {
  triggered: boolean;
  triggeredAt?: Date;
  reason?: string;
  /** "PROFIT_CAP" / "LOSS_CAP" / "MANUAL" / "CARRY_FORWARD_FAIL". */
  source?: "PROFIT_CAP" | "LOSS_CAP" | "MANUAL" | "CARRY_FORWARD_FAIL";
}

export interface CarryForwardEval {
  ranAt: Date;
  /** What the eval found. PASS = all 4 conditions met → carry forward;
   *  FAIL = at least one failed → trigger exit (subject to autoExit + delay). */
  outcome: "PASS" | "FAIL" | "NO_OPEN_POSITIONS";
  /** Per-position diagnostic for the dashboard. */
  positions: Array<{
    tradeId: string;
    profitPercent: number;
    momentumScore: number;
    dte: number;
    ivLabel: "fair" | "cheap" | "expensive" | "unknown";
    decision: "CARRY" | "EXIT";
    failedConditions: string[];
  }>;
}

export interface CapGracePeriod {
  startedAt: Date;
  deadline: Date;
  source: "PROFIT_CAP" | "LOSS_CAP";
  acknowledged: boolean;
  /** Operator-chosen action; if null when deadline expires → MUST_EXIT auto. */
  userAction: "EXIT_ALL" | "EXIT_INSTRUMENT" | "REDUCE_EXPOSURE" | "HOLD" | null;
  userActionDetail?: string;
}

// ─── Discipline Daily Score ────────────────────────────────────

export interface ScoreBreakdown {
  circuitBreaker: number;
  tradeLimits: number;
  cooldowns: number;
  timeWindows: number;
  positionSizing: number;
  journal: number;
  preTradeGate: number;
}

export interface DisciplineDailyScore {
  userId: string;
  date: string;
  score: number;
  breakdown: ScoreBreakdown;
  violationCount: number;
  tradesToday: number;
  dailyPnl: number;
  dailyPnlPercent: number;
  streakType: "winning" | "losing" | "none";
  streakLength: number;
}

// ─── Discipline Settings (richer per-rule structure) ───────────

export interface DisciplineAgentSettings {
  userId: string;
  updatedAt: Date;

  // Module 1: Circuit Breaker
  dailyLossLimit: { enabled: boolean; thresholdPercent: number };
  maxConsecutiveLosses: { enabled: boolean; maxLosses: number; cooldownMinutes: number };

  // Module 2: Trade Limits
  maxTradesPerDay: { enabled: boolean; limit: number };
  maxOpenPositions: { enabled: boolean; limit: number };
  revengeCooldown: { enabled: boolean; durationMinutes: number; requireAcknowledgment: boolean };

  // Module 3: Time Windows (reads from userSettings)
  noTradingAfterOpen: { enabled: boolean; nseMinutes: number; mcxMinutes: number };
  noTradingBeforeClose: { enabled: boolean; nseMinutes: number; mcxMinutes: number };
  lunchBreakPause: { enabled: boolean; startTime: string; endTime: string };

  // Module 4: Pre-Trade Gate
  preTradeGate: {
    enabled: boolean;
    minRiskReward: { enabled: boolean; ratio: number };
    emotionalStateCheck: { enabled: boolean; blockStates: EmotionalState[] };
  };

  // Module 5: Position Sizing
  maxPositionSize: { enabled: boolean; percentOfCapital: number };
  maxTotalExposure: { enabled: boolean; percentOfCapital: number };

  // Module 6: Journal
  journalEnforcement: { enabled: boolean; maxUnjournaled: number };
  weeklyReview: { enabled: boolean; disciplineScoreWarning: number; redWeekReduction: number };

  // Module 7: Streaks
  winningStreakReminder: { enabled: boolean; triggerAfterDays: number };
  losingStreakAutoReduce: { enabled: boolean; triggerAfterDays: number; reduceByPercent: number };

  // Module 8: Capital Protection & Session Management
  // Every threshold below is operator-tunable — nothing in code should
  // assume specific defaults. The defaults at the bottom of this file
  // are the spec recommendations; operators override per environment.
  capitalProtection: {
    profitCap: { enabled: boolean; percent: number };
    lossCap: { enabled: boolean; percent: number };
    /** Seconds the operator has to choose an action before the system
     *  auto-fires MUST_EXIT. */
    gracePeriodSeconds: number;
    carryForward: {
      enabled: boolean;
      /** "HH:mm" IST. Carry-forward eval fires per-exchange because
       *  NSE (close 15:30) and MCX (close 23:30) run different windows. */
      nseEvalTime: string;
      mcxEvalTime: string;
      /** When carry-forward conditions fail, auto-fire EXIT_ALL after
       *  exitDelayMinutes (operator gets that window to override). */
      autoExit: boolean;
      exitDelayMinutes: number;
      /** Four conditions that ALL must pass for a position to carry
       *  forward overnight. Each is operator-tunable. */
      minProfitPercent: number;       // % gain on the position
      minMomentumScore: number;       // 0-100 score from RCA / SEA
      minDte: number;                 // days to expiry
      ivCondition: "fair" | "cheap" | "any";
    };
  };

  // Change history
  history: Array<{ changedAt: Date; field: string; oldValue: unknown; newValue: unknown }>;
}

// ─── Default Settings ──────────────────────────────────────────

export const DEFAULT_DISCIPLINE_AGENT_SETTINGS: Omit<DisciplineAgentSettings, "userId" | "updatedAt" | "history"> = {
  dailyLossLimit: { enabled: true, thresholdPercent: 3 },
  maxConsecutiveLosses: { enabled: true, maxLosses: 3, cooldownMinutes: 30 },
  maxTradesPerDay: { enabled: true, limit: 5 },
  maxOpenPositions: { enabled: true, limit: 3 },
  revengeCooldown: { enabled: true, durationMinutes: 15, requireAcknowledgment: true },
  noTradingAfterOpen: { enabled: true, nseMinutes: 15, mcxMinutes: 15 },
  noTradingBeforeClose: { enabled: true, nseMinutes: 15, mcxMinutes: 15 },
  lunchBreakPause: { enabled: false, startTime: "12:30", endTime: "13:30" },
  preTradeGate: {
    enabled: true,
    minRiskReward: { enabled: true, ratio: 1.5 },
    emotionalStateCheck: { enabled: true, blockStates: ["revenge", "fomo"] },
  },
  maxPositionSize: { enabled: true, percentOfCapital: 40 },
  maxTotalExposure: { enabled: true, percentOfCapital: 80 },
  journalEnforcement: { enabled: true, maxUnjournaled: 3 },
  weeklyReview: { enabled: true, disciplineScoreWarning: 70, redWeekReduction: 3 },
  winningStreakReminder: { enabled: true, triggerAfterDays: 5 },
  losingStreakAutoReduce: { enabled: true, triggerAfterDays: 3, reduceByPercent: 50 },
  // Module 8 — Capital Protection & Session Management.
  // Caps default DISABLED so the first deploy is observation-mode;
  // operator opts in via Settings UI. Spec-recommended values are
  // baked into `percent` so flipping `enabled` is a one-click action.
  capitalProtection: {
    profitCap: { enabled: false, percent: 5 },
    lossCap: { enabled: false, percent: 2 },
    gracePeriodSeconds: 60,
    carryForward: {
      enabled: false,
      nseEvalTime: "15:15",   // 15 min before NSE close (15:30)
      mcxEvalTime: "23:15",   // 15 min before MCX close (23:30)
      autoExit: true,
      exitDelayMinutes: 5,
      minProfitPercent: 15,
      minMomentumScore: 70,
      minDte: 2,
      ivCondition: "fair",
    },
  },
};

// ─── Default State ─────────────────────────────────────────────

export function createDefaultState(userId: string, date: string): DisciplineState {
  return {
    userId,
    date,
    updatedAt: new Date(),
    dailyRealizedPnl: 0,
    dailyLossPercent: 0,
    circuitBreakerTriggered: false,
    tradesToday: 0,
    openPositions: 0,
    consecutiveLosses: 0,
    unjournaledTrades: [],
    currentStreak: { type: "none", length: 0, startDate: date },
    activeAdjustments: [],
    weeklyReviewCompleted: false,
    violations: [],
    // Module 8 — Capital Protection & Session Management defaults
    dailyPnlPercent: 0,
    sessionHalts: {
      nse: { triggered: false },
      mcx: { triggered: false },
    },
    carryForwardEvals: {},
    capGrace: null,
  };
}

// ─── Helper: Get IST date string ───────────────────────────────

export function getISTDateString(d: Date = new Date()): string {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

export function getISTNow(): Date {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

export function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}
