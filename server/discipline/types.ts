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

export interface DisciplineEngineSettings {
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

  // Change history
  history: Array<{ changedAt: Date; field: string; oldValue: unknown; newValue: unknown }>;
}

// ─── Default Settings ──────────────────────────────────────────

export const DEFAULT_DISCIPLINE_ENGINE_SETTINGS: Omit<DisciplineEngineSettings, "userId" | "updatedAt" | "history"> = {
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
