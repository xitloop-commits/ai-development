/**
 * User Settings — MongoDB Model & CRUD Helpers
 *
 * Manages the `user_settings` collection. One document per user.
 * Stores settings for: Time Windows, Discipline, Expiry Controls, and Charges.
 * (Broker Config and Order Execution are stored in broker_configs collection.)
 */

import mongoose, { Schema, type Document } from "mongoose";

// ─── Type Definitions ──────────────────────────────────────────

export interface TimeWindowSettings {
  nse: {
    noTradeFirstMinutes: number;   // No trading first N minutes after open (default 15)
    noTradeLastMinutes: number;    // No trading last N minutes before close (default 15)
    lunchBreakPause: boolean;      // Pause trading during lunch (default false)
    lunchBreakStart: string;       // e.g. "12:30" (default "12:30")
    lunchBreakEnd: string;         // e.g. "13:30" (default "13:30")
  };
  mcx: {
    noTradeFirstMinutes: number;   // No trading first N minutes (default 15)
    noTradeLastMinutes: number;    // No trading last N minutes (default 30)
  };
}

export interface DisciplineSettings {
  maxTradesPerDay: number;         // Combined NSE + MCX (default 6)
  maxLossPerDay: number;           // Daily loss limit in ₹ (default 5000)
  maxLossPerDayPercent: number;    // Daily loss limit as % of capital (default 2)
  maxConsecutiveLosses: number;    // Stop after N consecutive losses (default 3)
  cooldownAfterLoss: number;       // Cooldown minutes after a loss (default 15)
  mandatoryChecklist: boolean;     // Require pre-entry checklist (default true)
  minChecklistScore: number;       // Minimum checklist score to trade (default 60)
  maxPositionSize: number;         // Max position size as % of capital (default 10)
  trailingStopEnabled: boolean;    // Enable trailing stop loss (default false)
  trailingStopPercent: number;     // Trailing SL % (default 1.5)
  noRevengeTrading: boolean;       // Block trades after hitting daily loss (default true)
  requireRationale: boolean;       // Require trade rationale (default false)
}

export interface ExpiryInstrumentRule {
  instrument: string;              // NIFTY_50, BANKNIFTY, CRUDEOIL, NATURALGAS
  blockOnExpiryDay: boolean;       // Block trading on expiry day (default false)
  blockDaysBefore: number;         // Block N days before expiry (default 0)
  reducePositionSize: boolean;     // Reduce position size near expiry (default false)
  reduceSizePercent: number;       // Reduce to this % of normal (default 50)
  warningBanner: boolean;          // Show warning banner near expiry (default true)
  autoExit: boolean;               // Auto-exit positions before expiry (default false)
  autoExitMinutes: number;         // Auto-exit N minutes before expiry close (default 30)
  noCarryToExpiry: boolean;        // Don't carry positions to expiry day (default true)
}

export interface ExpiryControlSettings {
  rules: ExpiryInstrumentRule[];
}

export interface ChargeRate {
  name: string;                    // e.g. "Brokerage", "STT", "Exchange Transaction"
  rate: number;                    // Rate value
  unit: string;                    // "flat_per_order" | "percent_sell" | "percent" | "percent_buy"
  description: string;
  enabled: boolean;                // Whether to include in calculations
}

export interface ChargesSettings {
  rates: ChargeRate[];
}

export interface UserSettingsDoc {
  userId: number;
  timeWindows: TimeWindowSettings;
  discipline: DisciplineSettings;
  expiryControls: ExpiryControlSettings;
  charges: ChargesSettings;
  updatedAt: number;               // UTC ms
}

// ─── Default Values ────────────────────────────────────────────

export const DEFAULT_TIME_WINDOWS: TimeWindowSettings = {
  nse: {
    noTradeFirstMinutes: 15,
    noTradeLastMinutes: 15,
    lunchBreakPause: false,
    lunchBreakStart: "12:30",
    lunchBreakEnd: "13:30",
  },
  mcx: {
    noTradeFirstMinutes: 15,
    noTradeLastMinutes: 30,
  },
};

export const DEFAULT_DISCIPLINE: DisciplineSettings = {
  maxTradesPerDay: 6,
  maxLossPerDay: 5000,
  maxLossPerDayPercent: 2,
  maxConsecutiveLosses: 3,
  cooldownAfterLoss: 15,
  mandatoryChecklist: true,
  minChecklistScore: 60,
  maxPositionSize: 10,
  trailingStopEnabled: false,
  trailingStopPercent: 1.5,
  noRevengeTrading: true,
  requireRationale: false,
};

export const DEFAULT_EXPIRY_RULES: ExpiryInstrumentRule[] = [
  {
    instrument: "NIFTY_50",
    blockOnExpiryDay: false,
    blockDaysBefore: 0,
    reducePositionSize: false,
    reduceSizePercent: 50,
    warningBanner: true,
    autoExit: false,
    autoExitMinutes: 30,
    noCarryToExpiry: true,
  },
  {
    instrument: "BANKNIFTY",
    blockOnExpiryDay: false,
    blockDaysBefore: 0,
    reducePositionSize: false,
    reduceSizePercent: 50,
    warningBanner: true,
    autoExit: false,
    autoExitMinutes: 30,
    noCarryToExpiry: true,
  },
  {
    instrument: "CRUDEOIL",
    blockOnExpiryDay: false,
    blockDaysBefore: 0,
    reducePositionSize: false,
    reduceSizePercent: 50,
    warningBanner: true,
    autoExit: false,
    autoExitMinutes: 30,
    noCarryToExpiry: true,
  },
  {
    instrument: "NATURALGAS",
    blockOnExpiryDay: false,
    blockDaysBefore: 0,
    reducePositionSize: false,
    reduceSizePercent: 50,
    warningBanner: true,
    autoExit: false,
    autoExitMinutes: 30,
    noCarryToExpiry: true,
  },
];

export const DEFAULT_CHARGES: ChargeRate[] = [
  { name: "Brokerage", rate: 20, unit: "flat_per_order", description: "₹20/order flat (Dhan)", enabled: true },
  { name: "STT", rate: 0.0625, unit: "percent_sell", description: "0.0625% sell side", enabled: true },
  { name: "Exchange Transaction", rate: 0.053, unit: "percent", description: "0.053% (NSE)", enabled: true },
  { name: "GST", rate: 18, unit: "percent_on_brokerage", description: "18% on brokerage + exchange transaction", enabled: true },
  { name: "SEBI", rate: 0.0001, unit: "percent", description: "0.0001%", enabled: true },
  { name: "Stamp Duty", rate: 0.003, unit: "percent_buy", description: "0.003% buy side", enabled: true },
];

// ─── Mongoose Schema ───────────────────────────────────────────

const nseTimeWindowSchema = new Schema(
  {
    noTradeFirstMinutes: { type: Number, default: 15 },
    noTradeLastMinutes: { type: Number, default: 15 },
    lunchBreakPause: { type: Boolean, default: false },
    lunchBreakStart: { type: String, default: "12:30" },
    lunchBreakEnd: { type: String, default: "13:30" },
  },
  { _id: false }
);

const mcxTimeWindowSchema = new Schema(
  {
    noTradeFirstMinutes: { type: Number, default: 15 },
    noTradeLastMinutes: { type: Number, default: 30 },
  },
  { _id: false }
);

const timeWindowsSchema = new Schema(
  {
    nse: { type: nseTimeWindowSchema, default: () => ({}) },
    mcx: { type: mcxTimeWindowSchema, default: () => ({}) },
  },
  { _id: false }
);

const disciplineSchema = new Schema(
  {
    maxTradesPerDay: { type: Number, default: 6 },
    maxLossPerDay: { type: Number, default: 5000 },
    maxLossPerDayPercent: { type: Number, default: 2 },
    maxConsecutiveLosses: { type: Number, default: 3 },
    cooldownAfterLoss: { type: Number, default: 15 },
    mandatoryChecklist: { type: Boolean, default: true },
    minChecklistScore: { type: Number, default: 60 },
    maxPositionSize: { type: Number, default: 10 },
    trailingStopEnabled: { type: Boolean, default: false },
    trailingStopPercent: { type: Number, default: 1.5 },
    noRevengeTrading: { type: Boolean, default: true },
    requireRationale: { type: Boolean, default: false },
  },
  { _id: false }
);

const expiryRuleSchema = new Schema(
  {
    instrument: { type: String, required: true },
    blockOnExpiryDay: { type: Boolean, default: false },
    blockDaysBefore: { type: Number, default: 0 },
    reducePositionSize: { type: Boolean, default: false },
    reduceSizePercent: { type: Number, default: 50 },
    warningBanner: { type: Boolean, default: true },
    autoExit: { type: Boolean, default: false },
    autoExitMinutes: { type: Number, default: 30 },
    noCarryToExpiry: { type: Boolean, default: true },
  },
  { _id: false }
);

const chargeRateSchema = new Schema(
  {
    name: { type: String, required: true },
    rate: { type: Number, required: true },
    unit: { type: String, required: true },
    description: { type: String, default: "" },
    enabled: { type: Boolean, default: true },
  },
  { _id: false }
);

const userSettingsSchema = new Schema<UserSettingsDoc & Document>(
  {
    userId: { type: Number, required: true, unique: true, index: true },
    timeWindows: { type: timeWindowsSchema, default: () => ({}) },
    discipline: { type: disciplineSchema, default: () => ({}) },
    expiryControls: {
      rules: { type: [expiryRuleSchema], default: () => [...DEFAULT_EXPIRY_RULES] },
    },
    charges: {
      rates: { type: [chargeRateSchema], default: () => [...DEFAULT_CHARGES] },
    },
    updatedAt: { type: Number, default: () => Date.now() },
  },
  {
    timestamps: false,
    collection: "user_settings",
  }
);

export const UserSettingsModel = mongoose.model("UserSettings", userSettingsSchema);

// ─── CRUD Helpers ──────────────────────────────────────────────

/**
 * Get user settings by userId. Returns defaults if none exist.
 */
export async function getUserSettings(userId: number): Promise<UserSettingsDoc> {
  const doc = await UserSettingsModel.findOne({ userId }).lean();
  if (doc) return docToSettings(doc);

  // Return defaults if no settings exist yet
  return {
    userId,
    timeWindows: { ...DEFAULT_TIME_WINDOWS },
    discipline: { ...DEFAULT_DISCIPLINE },
    expiryControls: { rules: [...DEFAULT_EXPIRY_RULES] },
    charges: { rates: [...DEFAULT_CHARGES] },
    updatedAt: Date.now(),
  };
}

/**
 * Update user settings (upsert). Merges with existing settings.
 */
export async function updateUserSettings(
  userId: number,
  updates: Partial<Pick<UserSettingsDoc, "timeWindows" | "discipline" | "expiryControls" | "charges">>
): Promise<UserSettingsDoc> {
  const setFields: Record<string, unknown> = { updatedAt: Date.now() };

  if (updates.timeWindows) {
    if (updates.timeWindows.nse) {
      for (const [key, value] of Object.entries(updates.timeWindows.nse)) {
        setFields[`timeWindows.nse.${key}`] = value;
      }
    }
    if (updates.timeWindows.mcx) {
      for (const [key, value] of Object.entries(updates.timeWindows.mcx)) {
        setFields[`timeWindows.mcx.${key}`] = value;
      }
    }
  }

  if (updates.discipline) {
    for (const [key, value] of Object.entries(updates.discipline)) {
      setFields[`discipline.${key}`] = value;
    }
  }

  if (updates.expiryControls) {
    setFields["expiryControls.rules"] = updates.expiryControls.rules;
  }

  if (updates.charges) {
    setFields["charges.rates"] = updates.charges.rates;
  }

  const doc = await UserSettingsModel.findOneAndUpdate(
    { userId },
    { $set: setFields },
    { upsert: true, returnDocument: "after", lean: true }
  );

  return docToSettings(doc!);
}

// ─── Helper ────────────────────────────────────────────────────

function docToSettings(doc: Record<string, any>): UserSettingsDoc {
  return {
    userId: doc.userId,
    timeWindows: {
      nse: {
        noTradeFirstMinutes: doc.timeWindows?.nse?.noTradeFirstMinutes ?? 15,
        noTradeLastMinutes: doc.timeWindows?.nse?.noTradeLastMinutes ?? 15,
        lunchBreakPause: doc.timeWindows?.nse?.lunchBreakPause ?? false,
        lunchBreakStart: doc.timeWindows?.nse?.lunchBreakStart ?? "12:30",
        lunchBreakEnd: doc.timeWindows?.nse?.lunchBreakEnd ?? "13:30",
      },
      mcx: {
        noTradeFirstMinutes: doc.timeWindows?.mcx?.noTradeFirstMinutes ?? 15,
        noTradeLastMinutes: doc.timeWindows?.mcx?.noTradeLastMinutes ?? 30,
      },
    },
    discipline: {
      maxTradesPerDay: doc.discipline?.maxTradesPerDay ?? 6,
      maxLossPerDay: doc.discipline?.maxLossPerDay ?? 5000,
      maxLossPerDayPercent: doc.discipline?.maxLossPerDayPercent ?? 2,
      maxConsecutiveLosses: doc.discipline?.maxConsecutiveLosses ?? 3,
      cooldownAfterLoss: doc.discipline?.cooldownAfterLoss ?? 15,
      mandatoryChecklist: doc.discipline?.mandatoryChecklist ?? true,
      minChecklistScore: doc.discipline?.minChecklistScore ?? 60,
      maxPositionSize: doc.discipline?.maxPositionSize ?? 10,
      trailingStopEnabled: doc.discipline?.trailingStopEnabled ?? false,
      trailingStopPercent: doc.discipline?.trailingStopPercent ?? 1.5,
      noRevengeTrading: doc.discipline?.noRevengeTrading ?? true,
      requireRationale: doc.discipline?.requireRationale ?? false,
    },
    expiryControls: {
      rules: (doc.expiryControls?.rules ?? DEFAULT_EXPIRY_RULES).map((r: any) => ({
        instrument: r.instrument,
        blockOnExpiryDay: r.blockOnExpiryDay ?? false,
        blockDaysBefore: r.blockDaysBefore ?? 0,
        reducePositionSize: r.reducePositionSize ?? false,
        reduceSizePercent: r.reduceSizePercent ?? 50,
        warningBanner: r.warningBanner ?? true,
        autoExit: r.autoExit ?? false,
        autoExitMinutes: r.autoExitMinutes ?? 30,
        noCarryToExpiry: r.noCarryToExpiry ?? true,
      })),
    },
    charges: {
      rates: (doc.charges?.rates ?? DEFAULT_CHARGES).map((c: any) => ({
        name: c.name,
        rate: c.rate,
        unit: c.unit,
        description: c.description ?? "",
        enabled: c.enabled ?? true,
      })),
    },
    updatedAt: doc.updatedAt ?? Date.now(),
  };
}
