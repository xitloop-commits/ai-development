/**
 * Trade Executor Agent — Settings.
 *
 * Single Mongo doc per userId holding tunables that today live as
 * code constants:
 *   - AI Live lot cap
 *   - RCA monitor: max-age, stale-tick window, vol threshold
 *   - Recovery engine: stuck threshold
 *
 * Read paths cache the doc for 30 s so per-tick lookups in RCA /
 * recovery / TEA stay cheap. Writes invalidate the cache. Defaults
 * apply when Mongo is empty / unreachable.
 *
 * Settings are user-wide for now (no per-channel splits). When the
 * canary needs different RCA params on ai-live vs ai-paper we'll
 * add a `channel?` field — easy schema extension.
 */

import mongoose, { Schema } from "mongoose";

// ─── Defaults ────────────────────────────────────────────────────

export const EXECUTOR_DEFAULTS = {
  aiLiveLotCap: 1,
  rcaMaxAgeMs: 30 * 60 * 1000,        // 30 min
  rcaStaleTickMs: 5 * 60 * 1000,       // 5 min
  rcaVolThreshold: 0.7,
  recoveryStuckMs: 60_000,             // 60 s
} as const;

export interface ExecutorSettings {
  userId: string;
  aiLiveLotCap: number;
  rcaMaxAgeMs: number;
  rcaStaleTickMs: number;
  rcaVolThreshold: number;
  recoveryStuckMs: number;
  updatedAt: number;
}

// ─── Mongoose Model ──────────────────────────────────────────────

const executorSettingsSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true },
    aiLiveLotCap: { type: Number, default: EXECUTOR_DEFAULTS.aiLiveLotCap },
    rcaMaxAgeMs: { type: Number, default: EXECUTOR_DEFAULTS.rcaMaxAgeMs },
    rcaStaleTickMs: { type: Number, default: EXECUTOR_DEFAULTS.rcaStaleTickMs },
    rcaVolThreshold: { type: Number, default: EXECUTOR_DEFAULTS.rcaVolThreshold },
    recoveryStuckMs: { type: Number, default: EXECUTOR_DEFAULTS.recoveryStuckMs },
    updatedAt: { type: Number, default: () => Date.now() },
  },
  { timestamps: false, collection: "executor_settings" },
);

export const ExecutorSettingsModel = mongoose.model("ExecutorSettings", executorSettingsSchema);

// ─── Cache + read-through ────────────────────────────────────────

const CACHE_TTL_MS = 30_000;
let cached: { value: ExecutorSettings; cachedAt: number } | null = null;

const DEFAULT_USER_ID = "1";

/** Defaults shaped as a full ExecutorSettings doc. */
function defaultsFor(userId: string): ExecutorSettings {
  return {
    userId,
    ...EXECUTOR_DEFAULTS,
    updatedAt: 0,
  };
}

/**
 * Get the executor settings doc. Cached for 30 s; cache invalidated
 * on every update. Falls back to EXECUTOR_DEFAULTS if Mongo is
 * unreachable so RCA / TEA / recovery can still run with sane values.
 */
export async function getExecutorSettings(userId: string = DEFAULT_USER_ID): Promise<ExecutorSettings> {
  const now = Date.now();
  if (cached && cached.value.userId === userId && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.value;
  }
  try {
    const doc = await ExecutorSettingsModel.findOne({ userId }).lean();
    const value: ExecutorSettings = doc
      ? {
          userId: doc.userId,
          aiLiveLotCap: doc.aiLiveLotCap ?? EXECUTOR_DEFAULTS.aiLiveLotCap,
          rcaMaxAgeMs: doc.rcaMaxAgeMs ?? EXECUTOR_DEFAULTS.rcaMaxAgeMs,
          rcaStaleTickMs: doc.rcaStaleTickMs ?? EXECUTOR_DEFAULTS.rcaStaleTickMs,
          rcaVolThreshold: doc.rcaVolThreshold ?? EXECUTOR_DEFAULTS.rcaVolThreshold,
          recoveryStuckMs: doc.recoveryStuckMs ?? EXECUTOR_DEFAULTS.recoveryStuckMs,
          updatedAt: doc.updatedAt ?? 0,
        }
      : defaultsFor(userId);
    cached = { value, cachedAt: now };
    return value;
  } catch {
    return defaultsFor(userId);
  }
}

/** Update one or more settings fields. Invalidates the cache. */
export async function updateExecutorSettings(
  patch: Partial<Omit<ExecutorSettings, "userId" | "updatedAt">>,
  userId: string = DEFAULT_USER_ID,
): Promise<ExecutorSettings> {
  const doc = await ExecutorSettingsModel.findOneAndUpdate(
    { userId },
    { $set: { ...patch, updatedAt: Date.now() } },
    { upsert: true, returnDocument: "after", lean: true },
  );
  cached = null;
  return {
    userId,
    aiLiveLotCap: doc?.aiLiveLotCap ?? EXECUTOR_DEFAULTS.aiLiveLotCap,
    rcaMaxAgeMs: doc?.rcaMaxAgeMs ?? EXECUTOR_DEFAULTS.rcaMaxAgeMs,
    rcaStaleTickMs: doc?.rcaStaleTickMs ?? EXECUTOR_DEFAULTS.rcaStaleTickMs,
    rcaVolThreshold: doc?.rcaVolThreshold ?? EXECUTOR_DEFAULTS.rcaVolThreshold,
    recoveryStuckMs: doc?.recoveryStuckMs ?? EXECUTOR_DEFAULTS.recoveryStuckMs,
    updatedAt: doc?.updatedAt ?? Date.now(),
  };
}
