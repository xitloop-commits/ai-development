/**
 * Trade Executor Agent — Settings.
 *
 * Single Mongo doc per userId holding tunables that today live as
 * code constants:
 *   - AI Live lot cap
 *   - RCA monitor: max-age, stale-tick window, vol threshold,
 *     channels under supervision
 *   - Recovery engine: stuck threshold, channels polled
 *   - SEA bridge: enabled, channel, poll cadence, direction filter
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
import type { Channel } from "../portfolio/state";

// ─── Defaults ────────────────────────────────────────────────────

export type SeaDirectionFilter = "LONG_ONLY" | "ALL";

export const EXECUTOR_DEFAULTS = {
  aiLiveLotCap: 1,
  rcaMaxAgeMs: 30 * 60 * 1000,        // 30 min
  rcaStaleTickMs: 5 * 60 * 1000,       // 5 min
  rcaVolThreshold: 0.7,
  recoveryStuckMs: 60_000,             // 60 s

  // SEA bridge — Phase 1 canary defaults
  seaBridgeEnabled: true as boolean,
  seaBridgeChannel: "ai-paper" as Channel,
  seaBridgePollIntervalMs: 5_000,      // 5 s
  seaBridgeDirectionFilter: "LONG_ONLY" as SeaDirectionFilter,

  // Channels under monitoring
  rcaChannels: ["ai-paper"] as Channel[],
  recoveryChannels: ["my-live", "ai-live", "testing-live"] as Channel[],

  // B4-followup — auto kill-switch on consecutive BROKER_DESYNC events.
  // When N desyncs happen on a single channel within `windowSeconds`,
  // RCA flips the affected workspace's kill switch and fires a Telegram
  // alert. Counter is in-memory (lost on restart, fresh-start = fresh
  // counter is the right behaviour). Defaults conservative; operator
  // can disable for paper testing.
  desyncKillSwitchEnabled: true,
  desyncKillSwitchThreshold: 3,
  desyncKillSwitchWindowSeconds: 600,
} as const;

export interface ExecutorSettings {
  userId: string;
  aiLiveLotCap: number;
  rcaMaxAgeMs: number;
  rcaStaleTickMs: number;
  rcaVolThreshold: number;
  recoveryStuckMs: number;

  seaBridgeEnabled: boolean;
  seaBridgeChannel: Channel;
  seaBridgePollIntervalMs: number;
  seaBridgeDirectionFilter: SeaDirectionFilter;

  rcaChannels: Channel[];
  recoveryChannels: Channel[];

  // B4-followup — auto kill-switch on consecutive BROKER_DESYNC events.
  desyncKillSwitchEnabled: boolean;
  desyncKillSwitchThreshold: number;
  desyncKillSwitchWindowSeconds: number;

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

    seaBridgeEnabled: { type: Boolean, default: EXECUTOR_DEFAULTS.seaBridgeEnabled },
    seaBridgeChannel: { type: String, default: EXECUTOR_DEFAULTS.seaBridgeChannel },
    seaBridgePollIntervalMs: { type: Number, default: EXECUTOR_DEFAULTS.seaBridgePollIntervalMs },
    seaBridgeDirectionFilter: { type: String, default: EXECUTOR_DEFAULTS.seaBridgeDirectionFilter },

    rcaChannels: { type: [String], default: () => [...EXECUTOR_DEFAULTS.rcaChannels] },
    recoveryChannels: { type: [String], default: () => [...EXECUTOR_DEFAULTS.recoveryChannels] },

    desyncKillSwitchEnabled: { type: Boolean, default: EXECUTOR_DEFAULTS.desyncKillSwitchEnabled },
    desyncKillSwitchThreshold: { type: Number, default: EXECUTOR_DEFAULTS.desyncKillSwitchThreshold },
    desyncKillSwitchWindowSeconds: { type: Number, default: EXECUTOR_DEFAULTS.desyncKillSwitchWindowSeconds },

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
    aiLiveLotCap: EXECUTOR_DEFAULTS.aiLiveLotCap,
    rcaMaxAgeMs: EXECUTOR_DEFAULTS.rcaMaxAgeMs,
    rcaStaleTickMs: EXECUTOR_DEFAULTS.rcaStaleTickMs,
    rcaVolThreshold: EXECUTOR_DEFAULTS.rcaVolThreshold,
    recoveryStuckMs: EXECUTOR_DEFAULTS.recoveryStuckMs,
    seaBridgeEnabled: EXECUTOR_DEFAULTS.seaBridgeEnabled,
    seaBridgeChannel: EXECUTOR_DEFAULTS.seaBridgeChannel,
    seaBridgePollIntervalMs: EXECUTOR_DEFAULTS.seaBridgePollIntervalMs,
    seaBridgeDirectionFilter: EXECUTOR_DEFAULTS.seaBridgeDirectionFilter,
    rcaChannels: [...EXECUTOR_DEFAULTS.rcaChannels],
    recoveryChannels: [...EXECUTOR_DEFAULTS.recoveryChannels],
    desyncKillSwitchEnabled: EXECUTOR_DEFAULTS.desyncKillSwitchEnabled,
    desyncKillSwitchThreshold: EXECUTOR_DEFAULTS.desyncKillSwitchThreshold,
    desyncKillSwitchWindowSeconds: EXECUTOR_DEFAULTS.desyncKillSwitchWindowSeconds,
    updatedAt: 0,
  };
}

function docToSettings(doc: any, userId: string): ExecutorSettings {
  return {
    userId,
    aiLiveLotCap: doc?.aiLiveLotCap ?? EXECUTOR_DEFAULTS.aiLiveLotCap,
    rcaMaxAgeMs: doc?.rcaMaxAgeMs ?? EXECUTOR_DEFAULTS.rcaMaxAgeMs,
    rcaStaleTickMs: doc?.rcaStaleTickMs ?? EXECUTOR_DEFAULTS.rcaStaleTickMs,
    rcaVolThreshold: doc?.rcaVolThreshold ?? EXECUTOR_DEFAULTS.rcaVolThreshold,
    recoveryStuckMs: doc?.recoveryStuckMs ?? EXECUTOR_DEFAULTS.recoveryStuckMs,
    seaBridgeEnabled: doc?.seaBridgeEnabled ?? EXECUTOR_DEFAULTS.seaBridgeEnabled,
    seaBridgeChannel: doc?.seaBridgeChannel ?? EXECUTOR_DEFAULTS.seaBridgeChannel,
    seaBridgePollIntervalMs: doc?.seaBridgePollIntervalMs ?? EXECUTOR_DEFAULTS.seaBridgePollIntervalMs,
    seaBridgeDirectionFilter: doc?.seaBridgeDirectionFilter ?? EXECUTOR_DEFAULTS.seaBridgeDirectionFilter,
    rcaChannels: (doc?.rcaChannels && doc.rcaChannels.length > 0)
      ? doc.rcaChannels
      : [...EXECUTOR_DEFAULTS.rcaChannels],
    recoveryChannels: (doc?.recoveryChannels && doc.recoveryChannels.length > 0)
      ? doc.recoveryChannels
      : [...EXECUTOR_DEFAULTS.recoveryChannels],
    desyncKillSwitchEnabled: doc?.desyncKillSwitchEnabled ?? EXECUTOR_DEFAULTS.desyncKillSwitchEnabled,
    desyncKillSwitchThreshold: doc?.desyncKillSwitchThreshold ?? EXECUTOR_DEFAULTS.desyncKillSwitchThreshold,
    desyncKillSwitchWindowSeconds: doc?.desyncKillSwitchWindowSeconds ?? EXECUTOR_DEFAULTS.desyncKillSwitchWindowSeconds,
    updatedAt: doc?.updatedAt ?? 0,
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
    const value = doc ? docToSettings(doc, userId) : defaultsFor(userId);
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
  return doc ? docToSettings(doc, userId) : defaultsFor(userId);
}
