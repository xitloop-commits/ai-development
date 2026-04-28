/**
 * Discipline Agent — MongoDB Models
 *
 * Collections:
 *   - discipline_settings: Per-user rich discipline configuration (per-rule enabled + params)
 *   - discipline_state: Intraday state (counters, cooldowns, violations) — one per user per day
 *   - discipline_daily_scores: End-of-day score snapshots for historical tracking
 */

import mongoose, { Schema, type Document } from "mongoose";
import {
  type DisciplineAgentSettings,
  type DisciplineState,
  type DisciplineDailyScore,
  DEFAULT_DISCIPLINE_AGENT_SETTINGS,
  createDefaultState,
  getISTDateString,
} from "./types";

// ─── Discipline Settings Schema ────────────────────────────────

const enabledNumberSchema = new Schema(
  { enabled: { type: Boolean, default: true }, thresholdPercent: Number, maxLosses: Number, cooldownMinutes: Number, limit: Number, nseMinutes: Number, mcxMinutes: Number, durationMinutes: Number, requireAcknowledgment: Boolean, percentOfCapital: Number, maxUnjournaled: Number, disciplineScoreWarning: Number, redWeekReduction: Number, triggerAfterDays: Number, reduceByPercent: Number, ratio: Number, startTime: String, endTime: String, blockStates: [String] },
  { _id: false, strict: false }
);

const historyEntrySchema = new Schema(
  { changedAt: { type: Date, default: Date.now }, field: String, oldValue: Schema.Types.Mixed, newValue: Schema.Types.Mixed },
  { _id: false }
);

const disciplineSettingsSchema = new Schema<DisciplineAgentSettings & Document>(
  {
    userId: { type: String, required: true, unique: true, index: true },
    updatedAt: { type: Date, default: Date.now },
    dailyLossLimit: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.dailyLossLimit }) },
    maxConsecutiveLosses: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.maxConsecutiveLosses }) },
    maxTradesPerDay: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.maxTradesPerDay }) },
    maxOpenPositions: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.maxOpenPositions }) },
    revengeCooldown: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.revengeCooldown }) },
    noTradingAfterOpen: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.noTradingAfterOpen }) },
    noTradingBeforeClose: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.noTradingBeforeClose }) },
    lunchBreakPause: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.lunchBreakPause }) },
    preTradeGate: {
      type: new Schema({
        enabled: { type: Boolean, default: true },
        minRiskReward: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.preTradeGate.minRiskReward }) },
        emotionalStateCheck: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.preTradeGate.emotionalStateCheck }) },
      }, { _id: false }),
      default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.preTradeGate }),
    },
    maxPositionSize: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.maxPositionSize }) },
    maxTotalExposure: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.maxTotalExposure }) },
    journalEnforcement: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.journalEnforcement }) },
    weeklyReview: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.weeklyReview }) },
    winningStreakReminder: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.winningStreakReminder }) },
    losingStreakAutoReduce: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.losingStreakAutoReduce }) },
    // Module 8 — Capital Protection. Persisted as an open sub-document
    // (strict: false on the parent) — operator-tunable per environment.
    capitalProtection: {
      type: new Schema({
        profitCap: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection.profitCap }) },
        lossCap: { type: enabledNumberSchema, default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection.lossCap }) },
        gracePeriodSeconds: { type: Number, default: DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection.gracePeriodSeconds },
        carryForward: {
          type: new Schema({
            enabled: { type: Boolean, default: DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection.carryForward.enabled },
            nseEvalTime: { type: String, default: DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection.carryForward.nseEvalTime },
            mcxEvalTime: { type: String, default: DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection.carryForward.mcxEvalTime },
            autoExit: { type: Boolean, default: DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection.carryForward.autoExit },
            exitDelayMinutes: { type: Number, default: DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection.carryForward.exitDelayMinutes },
            minProfitPercent: { type: Number, default: DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection.carryForward.minProfitPercent },
            minMomentumScore: { type: Number, default: DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection.carryForward.minMomentumScore },
            minDte: { type: Number, default: DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection.carryForward.minDte },
            ivCondition: { type: String, enum: ["fair", "cheap", "any"], default: DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection.carryForward.ivCondition },
          }, { _id: false }),
          default: () => ({ ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection.carryForward }),
        },
      }, { _id: false }),
      default: () => JSON.parse(JSON.stringify(DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection)),
    },
    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: false, collection: "discipline_settings", strict: false }
);

export const DisciplineSettingsModel = mongoose.model("DisciplineSettings", disciplineSettingsSchema);

// ─── Discipline State Schema ───────────────────────────────────

const cooldownSchema = new Schema(
  {
    type: { type: String, enum: ["revenge", "consecutive_loss"] },
    startedAt: Date,
    endsAt: Date,
    acknowledged: { type: Boolean, default: false },
    triggerTrade: String,
  },
  { _id: false }
);

const violationSchema = new Schema(
  {
    ruleId: String,
    ruleName: String,
    severity: { type: String, enum: ["hard", "soft"] },
    description: String,
    timestamp: { type: Date, default: Date.now },
    overridden: { type: Boolean, default: false },
  },
  { _id: false }
);

const adjustmentSchema = new Schema(
  {
    rule: String,
    description: String,
    originalValue: Number,
    adjustedValue: Number,
    appliedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const streakSchema = new Schema(
  {
    type: { type: String, enum: ["winning", "losing", "none"], default: "none" },
    length: { type: Number, default: 0 },
    startDate: String,
  },
  { _id: false }
);

const disciplineStateSchema = new Schema<DisciplineState & Document>(
  {
    userId: { type: String, required: true, index: true },
    /** Per-channel partitioning (PA Phase 4 follow-up). Default "my-live"
     *  preserves single-channel callers' behaviour. */
    channel: { type: String, required: true, default: "my-live", index: true },
    date: { type: String, required: true, index: true },
    updatedAt: { type: Date, default: Date.now },

    dailyRealizedPnl: { type: Number, default: 0 },
    dailyLossPercent: { type: Number, default: 0 },
    circuitBreakerTriggered: { type: Boolean, default: false },
    circuitBreakerTriggeredAt: Date,

    tradesToday: { type: Number, default: 0 },
    openPositions: { type: Number, default: 0 },
    consecutiveLosses: { type: Number, default: 0 },

    activeCooldown: { type: cooldownSchema, default: undefined },

    unjournaledTrades: { type: [String], default: [] },

    currentStreak: { type: streakSchema, default: () => ({ type: "none", length: 0, startDate: getISTDateString() }) },

    activeAdjustments: { type: [adjustmentSchema], default: [] },

    weeklyReviewCompleted: { type: Boolean, default: false },
    weeklyReviewDueAt: Date,

    violations: { type: [violationSchema], default: [] },

    // Module 8 — Capital Protection runtime state. Open sub-documents;
    // the parent uses default mongoose strictness so unknown sub-fields
    // are dropped on save.
    dailyPnlPercent: { type: Number, default: 0 },
    sessionHalts: {
      type: new Schema({
        nse: {
          type: new Schema({
            triggered: { type: Boolean, default: false },
            triggeredAt: Date,
            reason: String,
            source: { type: String, enum: ["PROFIT_CAP", "LOSS_CAP", "MANUAL", "CARRY_FORWARD_FAIL"] },
          }, { _id: false }),
          default: () => ({ triggered: false }),
        },
        mcx: {
          type: new Schema({
            triggered: { type: Boolean, default: false },
            triggeredAt: Date,
            reason: String,
            source: { type: String, enum: ["PROFIT_CAP", "LOSS_CAP", "MANUAL", "CARRY_FORWARD_FAIL"] },
          }, { _id: false }),
          default: () => ({ triggered: false }),
        },
      }, { _id: false }),
      default: () => ({ nse: { triggered: false }, mcx: { triggered: false } }),
    },
    carryForwardEvals: { type: Schema.Types.Mixed, default: () => ({}) },
    capGrace: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: false, collection: "discipline_state" }
);

// Compound unique index — partitioned per channel.
disciplineStateSchema.index({ userId: 1, channel: 1, date: -1 }, { unique: true });

export const DisciplineStateModel = mongoose.model("DisciplineState", disciplineStateSchema);

/**
 * Drop the legacy unique index `userId_1_date_-1` if it still exists.
 *
 * Pre-channel-partitioning the unique key was just `(userId, date)`; that
 * index has been replaced by `(userId, channel, date)` but Mongo doesn't
 * remove the old one automatically. Leaving it in place blocks inserting
 * a second discipline_state doc for the same user+date on a different
 * channel — which is exactly the multi-channel use case.
 *
 * Idempotent: if the legacy index is gone, this is a no-op.
 */
export async function migrateDisciplineStateIndexes(): Promise<void> {
  const coll = DisciplineStateModel.collection;
  const indexes = await coll.indexes();
  const legacy = indexes.find((idx) => idx.name === "userId_1_date_-1");
  if (legacy) {
    await coll.dropIndex("userId_1_date_-1");
  }
}

// ─── Discipline Daily Score Schema ─────────────────────────────

const scoreBreakdownSchema = new Schema(
  {
    circuitBreaker: { type: Number, default: 0 },
    tradeLimits: { type: Number, default: 0 },
    cooldowns: { type: Number, default: 0 },
    timeWindows: { type: Number, default: 0 },
    positionSizing: { type: Number, default: 0 },
    journal: { type: Number, default: 0 },
    preTradeGate: { type: Number, default: 0 },
  },
  { _id: false }
);

const dailyScoreSchema = new Schema<DisciplineDailyScore & Document>(
  {
    userId: { type: String, required: true, index: true },
    date: { type: String, required: true },
    score: { type: Number, default: 100 },
    breakdown: { type: scoreBreakdownSchema, default: () => ({}) },
    violationCount: { type: Number, default: 0 },
    tradesToday: { type: Number, default: 0 },
    dailyPnl: { type: Number, default: 0 },
    dailyPnlPercent: { type: Number, default: 0 },
    streakType: { type: String, enum: ["winning", "losing", "none"], default: "none" },
    streakLength: { type: Number, default: 0 },
  },
  { timestamps: false, collection: "discipline_daily_scores" }
);

dailyScoreSchema.index({ userId: 1, date: -1 }, { unique: true });

export const DisciplineDailyScoreModel = mongoose.model("DisciplineDailyScore", dailyScoreSchema);

// ─── CRUD Helpers ──────────────────────────────────────────────

/** Get or create discipline settings for a user */
export async function getDisciplineSettings(userId: string): Promise<DisciplineAgentSettings> {
  let doc = await DisciplineSettingsModel.findOne({ userId }).lean();
  if (!doc) {
    doc = await DisciplineSettingsModel.create({ userId, updatedAt: new Date(), history: [] });
    doc = doc.toObject();
  }
  return doc as unknown as DisciplineAgentSettings;
}

/** Update discipline settings with history logging */
export async function updateDisciplineSettings(
  userId: string,
  updates: Record<string, unknown>
): Promise<DisciplineAgentSettings> {
  const current = await getDisciplineSettings(userId);
  const historyEntries: Array<{ changedAt: Date; field: string; oldValue: unknown; newValue: unknown }> = [];

  const setFields: Record<string, unknown> = { updatedAt: new Date() };

  for (const [key, value] of Object.entries(updates)) {
    const oldValue = (current as unknown as Record<string, unknown>)[key];
    setFields[key] = value;
    historyEntries.push({ changedAt: new Date(), field: key, oldValue, newValue: value });
  }

  const doc = await DisciplineSettingsModel.findOneAndUpdate(
    { userId },
    { $set: setFields, $push: { history: { $each: historyEntries } } },
    { upsert: true, returnDocument: "after", lean: true }
  );
  return doc as unknown as DisciplineAgentSettings;
}

const DEFAULT_CHANNEL = "my-live";

/** Get or create today's discipline state for (userId, channel). */
export async function getDisciplineState(
  userId: string,
  date?: string,
  channel: string = DEFAULT_CHANNEL,
): Promise<DisciplineState> {
  const d = date ?? getISTDateString();

  const existing = await DisciplineStateModel.findOne({ userId, channel, date: d }).lean();
  if (existing) return existing as unknown as DisciplineState;

  // Carry streak / consecutive-loss counters over from the most recent
  // previous day for this same (userId, channel).
  const prevDoc = await DisciplineStateModel
    .findOne({ userId, channel, date: { $lt: d } })
    .sort({ date: -1 })
    .lean();
  const defaultState = createDefaultState(userId, d);
  (defaultState as any).channel = channel;
  if (prevDoc) {
    defaultState.currentStreak = (prevDoc as unknown as DisciplineState).currentStreak;
    defaultState.consecutiveLosses = (prevDoc as unknown as DisciplineState).consecutiveLosses;
  }

  // Atomic upsert: if a parallel call already inserted the doc, $setOnInsert
  // is a no-op and we fetch the winning row. Eliminates the create-race that
  // caused E11000 on concurrent disciplinePreCheck calls.
  const doc = await DisciplineStateModel.findOneAndUpdate(
    { userId, channel, date: d },
    { $setOnInsert: defaultState },
    { upsert: true, returnDocument: "after", lean: true }
  );
  return doc as unknown as DisciplineState;
}

/** Update discipline state fields for (userId, channel, date). */
export async function updateDisciplineState(
  userId: string,
  date: string,
  updates: Partial<DisciplineState>,
  channel: string = DEFAULT_CHANNEL,
): Promise<DisciplineState> {
  const setFields: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(updates)) {
    if (key !== "userId" && key !== "date" && key !== "channel") {
      setFields[key] = value;
    }
  }
  const doc = await DisciplineStateModel.findOneAndUpdate(
    { userId, channel, date },
    { $set: setFields },
    { returnDocument: "after", lean: true }
  );
  return doc as unknown as DisciplineState;
}

/** Add a violation to today's state for (userId, channel). */
export async function addViolation(
  userId: string,
  date: string,
  violation: DisciplineState["violations"][0],
  channel: string = DEFAULT_CHANNEL,
): Promise<void> {
  await DisciplineStateModel.updateOne(
    { userId, channel, date },
    { $push: { violations: violation }, $set: { updatedAt: new Date() } }
  );
}

/** Save or update daily score */
export async function saveDailyScore(score: DisciplineDailyScore): Promise<void> {
  await DisciplineDailyScoreModel.updateOne(
    { userId: score.userId, date: score.date },
    { $set: score },
    { upsert: true }
  );
}

/** Get score history for charting */
export async function getScoreHistory(userId: string, days: number = 30): Promise<DisciplineDailyScore[]> {
  const docs = await DisciplineDailyScoreModel.find({ userId })
    .sort({ date: -1 })
    .limit(days)
    .lean();
  return docs as unknown as DisciplineDailyScore[];
}
