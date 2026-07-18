/**
 * Broker Service — Multi-Adapter Singleton (BSA v1.7)
 *
 * Manages named adapter slots, each serving specific trading channels:
 *   dhanLive    → my-live               (brokerId: "dhan-primary-ac")
 *   dhanAiData  → ai-live + TFA data feed (brokerId: "dhan-secondary-ac")
 *   mockPaper   → paper (shared AI + My) (brokerId: "mock-paper")
 *
 * Kill switches are per-workspace and independent (ai / my).
 * Kill switch state is persisted to user_settings and loaded at startup.
 */

import type { BrokerAdapter, BrokerServiceStatus } from "./types";
import {
  getBrokerConfig,
  getActiveBrokerConfig,
  upsertBrokerConfig,
  setActiveBroker as setActiveBrokerInDB,
} from "./brokerConfig";
import { tickBus } from "./tickBus";
import { getUserSettings, updateUserSettings } from "../userSettings";
import { DhanAdapter } from "./adapters/dhan/index";
import { MockAdapter } from "./adapters/mock/index";
import { createLogger } from "./logger";

const log = createLogger("BSA", "Service");

// ─── Types ──────────────────────────────────────────────────────

/** Factory function that creates an adapter instance (kept for backward compat). */
export type AdapterFactory = () => BrokerAdapter;

export interface AdapterMeta {
  brokerId: string;
  displayName: string;
  isPaperBroker: boolean;
}

// ─── Channel → Adapter mapping ──────────────────────────────────

export type Channel =
  | "paper"
  | "ai-live"
  | "my-live";

/** Per-trade attribution / kill-switch grouping. */
export type Workspace = "ai" | "my";

// ─── Singleton State ────────────────────────────────────────────

interface BSAAdapters {
  dhanLive: DhanAdapter | null;       // my-live (options + equity)  (user's primary Dhan account)
  dhanAiData: DhanAdapter | null;     // ai-live + TFA data feed (spouse's Dhan account)
  mockPaper: MockAdapter | null;      // paper (shared AI + My book; options + equity)
}

const adapters: BSAAdapters = {
  dhanLive: null,
  dhanAiData: null,
  mockPaper: null,
};

interface KillSwitchState {
  ai: boolean;
  my: boolean;
}

const killSwitch: KillSwitchState = {
  ai: false,
  my: false,
};

// ─── Legacy registry (kept for backward compat with setup flow) ──

const adapterFactories = new Map<string, AdapterFactory>();
const adapterMeta = new Map<string, AdapterMeta>();

// ─── One-shot brokerId Rename Migration (2026-05-27) ────────────
//
// Hardcoded rename of the two Dhan brokerIds:
//   "dhan"         → "dhan-primary-ac"   (primary, Partha's account)
//   "dhan-ai-data" → "dhan-secondary-ac"     (spouse Ahila's account, TFA + ai-live)
//
// Runs once at startup before seedBrokerConfigs. Idempotent — if a doc
// already exists under the new brokerId (i.e. migration already happened
// on this machine), the corresponding old doc is left untouched (will be
// orphaned but harmless; safe to drop manually later). Removing this
// function is safe once every machine has booted at least once with this
// code.
const BROKER_ID_RENAME_MAP: Record<string, string> = {
  "dhan":         "dhan-primary-ac",
  "dhan-ai-data": "dhan-secondary-ac",
};

async function renameLegacyBrokerIds(): Promise<void> {
  const { default: mongoose } = await import("mongoose");
  const db = mongoose.connection.db;
  if (!db) return;

  for (const [oldId, newId] of Object.entries(BROKER_ID_RENAME_MAP)) {
    const newDoc = await db.collection("broker_configs").findOne({ brokerId: newId });
    if (newDoc) continue; // Already migrated on this machine.

    const oldDoc = await db.collection("broker_configs").findOne({ brokerId: oldId });
    if (!oldDoc) continue; // Nothing to rename; seedBrokerConfigs will create fresh.

    await db.collection("broker_configs").updateOne(
      { brokerId: oldId },
      { $set: { brokerId: newId } },
    );
    log.important(`Migrated broker_configs.brokerId: "${oldId}" → "${newId}"`);
  }
}

// ─── Seed Documents ─────────────────────────────────────────────

/**
 * Ensure the 5 required broker_configs documents exist in MongoDB.
 * Uses upsert — will NOT overwrite existing tokens or settings.
 */
async function seedBrokerConfigs(): Promise<void> {
  type Seed = {
    brokerId: string;
    displayName: string;
    isPaperBroker: boolean;
    role: "trading" | "data-and-ai" | "paper";
  };
  const seeds: Seed[] = [
    { brokerId: "dhan-primary-ac", displayName: "Dhan (Trading)",      isPaperBroker: false, role: "trading"     },
    { brokerId: "dhan-secondary-ac",   displayName: "Dhan (AI + Data)",    isPaperBroker: false, role: "data-and-ai" },
    { brokerId: "mock-paper",         displayName: "Paper",               isPaperBroker: true,  role: "paper"       },
  ];

  for (const seed of seeds) {
    const existing = await getBrokerConfig(seed.brokerId);
    if (!existing) {
      await upsertBrokerConfig({
        brokerId: seed.brokerId,
        displayName: seed.displayName,
        isPaperBroker: seed.isPaperBroker,
        role: seed.role,
        isActive: seed.brokerId === "dhan-primary-ac", // primary trading account is the default active broker
      });
      log.info(`Seeded broker config: ${seed.brokerId} (role=${seed.role})`);
    } else if (!existing.role) {
      // Backfill role on existing docs that pre-date this field.
      await upsertBrokerConfig({ brokerId: seed.brokerId, role: seed.role });
      log.info(`Backfilled role on broker config: ${seed.brokerId} (role=${seed.role})`);
    }
  }
}

/**
 * One-time migration: if the primary "dhan-primary-ac" broker_config has no
 * auth credentials yet but the legacy .env vars are present, copy them into
 * MongoDB. Lets users delete the env vars after first boot. Idempotent.
 *
 * Only the primary broker is migrated — multi-account credentials never
 * lived in env vars and there's no per-broker namespace for them.
 */
async function migrateEnvCredentialsToMongo(): Promise<void> {
  const envClientId   = process.env.DHAN_CLIENT_ID;
  const envPin        = process.env.DHAN_PIN;
  const envTotpSecret = process.env.DHAN_TOTP_SECRET;
  if (!envClientId && !envPin && !envTotpSecret) return;

  const { default: mongoose } = await import("mongoose");
  const db = mongoose.connection.db;
  if (!db) return;

  const doc = await db.collection("broker_configs").findOne({ brokerId: "dhan-primary-ac" });
  if (!doc) return;

  const auth = (doc as any).auth ?? {};
  const update: Record<string, string> = {};

  if (!auth.clientId   && envClientId)   update["auth.clientId"]   = envClientId;
  if (!auth.pin        && envPin)        update["auth.pin"]        = envPin;
  if (!auth.totpSecret && envTotpSecret) update["auth.totpSecret"] = envTotpSecret;

  if (Object.keys(update).length === 0) return;

  await db.collection("broker_configs").updateOne({ brokerId: "dhan-primary-ac" }, { $set: update });
  log.info(
    `Migrated env credentials to broker_configs.auth (dhan-primary-ac): ${Object.keys(update).join(", ")}. ` +
    `You can now safely delete DHAN_CLIENT_ID / DHAN_PIN / DHAN_TOTP_SECRET from .env.`
  );
}

// ─── Channel Routing ────────────────────────────────────────────

/**
 * Resolve a channel string to the correct adapter instance.
 */
export function getAdapter(channel: Channel): BrokerAdapter {
  switch (channel) {
    case "ai-live":
      // Prefer the dedicated dhan-secondary-ac adapter (spouse account); fall back
      // to the primary adapter if dhan-secondary-ac hasn't been configured yet
      // (first-run before credentials are entered into Settings).
      if (adapters.dhanAiData) return adapters.dhanAiData;
      if (adapters.dhanLive) return adapters.dhanLive;
      throw new Error("Neither DhanAdapter (ai-data) nor (live) is initialised");
    case "my-live":
      // my-live routes options AND equity to the primary account.
      if (!adapters.dhanLive) throw new Error("DhanAdapter (live) not initialised");
      return adapters.dhanLive;
    case "paper":
      // The shared paper book (AI + My); options AND equity paper fills.
      if (!adapters.mockPaper) throw new Error("MockAdapter (mock-paper) not initialised");
      return adapters.mockPaper;
    default:
      throw new Error(`Unknown channel "${channel}"`);
  }
}

/**
 * Direct brokerId → adapter lookup, used when the caller knows the broker
 * identity (e.g. the Settings UI pasting a token into a specific slot).
 * Returns null if no adapter is registered.
 */
export function _getAdapterByBrokerId(brokerId: string): BrokerAdapter | null {
  switch (brokerId) {
    case "dhan-primary-ac": return adapters.dhanLive;
    case "dhan-secondary-ac": return adapters.dhanAiData;
    case "mock-paper": return adapters.mockPaper;
  }
  return null;
}

// ─── Kill Switch ─────────────────────────────────────────────────

/**
 * Check if the kill switch is active for a given channel.
 * Paper and sandbox channels are never affected.
 */
export function isChannelKillSwitchActive(channel: Channel): boolean {
  switch (channel) {
    case "ai-live":     return killSwitch.ai;
    case "my-live":     return killSwitch.my;
    default:            return false; // paper never blocked
  }
}

/**
 * Activate or deactivate the kill switch for a specific workspace.
 * State is persisted to user_settings.
 */
export async function toggleWorkspaceKillSwitch(
  workspace: Workspace,
  action: "ACTIVATE" | "DEACTIVATE"
): Promise<{ status: string; workspace: Workspace; active: boolean }> {
  const active = action === "ACTIVATE";
  killSwitch[workspace] = active;

  // Persist to user_settings
  await updateUserSettings(1 /* single-user */, {
    tradingMode: {
      aiKillSwitch: killSwitch.ai,
      myKillSwitch: killSwitch.my,
    },
  });

  // If activating, call killSwitch on the live channel adapter
  if (active) {
    const channelMap: Record<Workspace, "ai-live" | "my-live"> = {
      ai: "ai-live",
      my: "my-live",
    };
    try {
      const adapter = getAdapter(channelMap[workspace]);
      await adapter.killSwitch("ACTIVATE");
    } catch (err) {
      log.warn(`Kill switch activate error for ${workspace}:`, err);
    }
  }

  log.info(`Kill switch ${action} — workspace: ${workspace}`);
  return { status: active ? "activated" : "deactivated", workspace, active };
}

export function getKillSwitchState(): KillSwitchState {
  return { ...killSwitch };
}

// ─── Legacy single-adapter helpers (used by brokerRouter + brokerRoutes) ───

/**
 * Get the currently active adapter (the live Dhan primary account).
 * Prefer getAdapter(channel) in new code.
 */
export function getActiveBroker(): BrokerAdapter | null {
  return adapters.dhanLive;
}

/** @deprecated use toggleWorkspaceKillSwitch */
export async function toggleKillSwitch(
  action: "ACTIVATE" | "DEACTIVATE"
): Promise<{ status: string; message?: string }> {
  await toggleWorkspaceKillSwitch("ai", action);
  await toggleWorkspaceKillSwitch("my", action);
  return {
    status: action === "ACTIVATE" ? "activated" : "deactivated",
    message: `All kill switches ${action === "ACTIVATE" ? "activated" : "deactivated"}.`,
  };
}

/** @deprecated use isChannelKillSwitchActive(channel) */
export function isKillSwitchActive(): boolean {
  return killSwitch.ai || killSwitch.my;
}

// ─── Registration (legacy, kept for setup flow) ─────────────────

export function registerAdapter(
  brokerId: string,
  factory: AdapterFactory,
  meta?: { displayName?: string; isPaperBroker?: boolean }
): void {
  adapterFactories.set(brokerId, factory);
  adapterMeta.set(brokerId, {
    brokerId,
    displayName: meta?.displayName ?? brokerId,
    isPaperBroker: meta?.isPaperBroker ?? false,
  });
  log.info(`Registered adapter: ${brokerId}`);
}

export function getRegisteredAdapters(): string[] {
  return Array.from(adapterFactories.keys());
}

export function getRegisteredAdaptersMeta(): AdapterMeta[] {
  return Array.from(adapterMeta.values());
}

// ─── Initialization ──────────────────────────────────────────────

/**
 * Initialize the BSA: seed configs, instantiate 4 adapters, load kill switch state.
 * Call once at server startup after MongoDB is connected.
 */
export async function initBrokerService(): Promise<void> {
  log.info("Initialising...");

  // 0. One-shot rename of legacy brokerIds in broker_configs (2026-05-27).
  //    Idempotent — no-ops once new brokerIds already exist.
  try {
    await renameLegacyBrokerIds();
  } catch (err) {
    log.warn("Legacy brokerId rename migration failed (non-fatal):", err);
  }

  // 1. Seed the required broker_configs documents
  await seedBrokerConfigs();

  // 1b. One-time migration: env-var credentials → MongoDB (no-op once done)
  try {
    await migrateEnvCredentialsToMongo();
  } catch (err) {
    log.warn("Env→Mongo credential migration failed (non-fatal):", err);
  }

  // 2. Load kill switch state from user_settings
  try {
    const settings = await getUserSettings(1 /* single-user */);
    killSwitch.ai      = settings.tradingMode.aiKillSwitch;
    killSwitch.my      = settings.tradingMode.myKillSwitch;
    log.info(`Kill switches loaded — ai:${killSwitch.ai} my:${killSwitch.my}`);
  } catch (err) {
    log.warn("Could not load kill switch state, defaulting to OFF:", err);
  }

  // 3. Instantiate DhanAdapter (live) → connect (opens WS + order update WS)
  try {
    adapters.dhanLive = new DhanAdapter("dhan-primary-ac");
    await adapters.dhanLive.connect();
    wireTickBus(adapters.dhanLive);
    log.important("DhanAdapter (live) connected");
  } catch (err) {
    log.error("DhanAdapter (live) failed to connect:", err);
  }

  // 4. Instantiate DhanAdapter (ai-data) → spouse Ahila's Dhan account for TFA + AI Live.
  // Pre-check the TOTP refresh INPUTS (auth.{clientId, pin, totpSecret}) rather
  // than the access token (which is the output — empty until the first refresh).
  // If connect() throws (auth credentials wrong, network down, etc.) we leave
  // adapters.dhanAiData null so getAdapter("ai-live") falls back to the primary.
  try {
    const aiDataConfig = await getBrokerConfig("dhan-secondary-ac");
    const auth = (aiDataConfig as any)?.auth ?? {};
    const hasAuthCreds = !!auth.clientId && !!auth.pin && !!auth.totpSecret;
    if (hasAuthCreds) {
      const candidate = new DhanAdapter("dhan-secondary-ac");
      try {
        await candidate.connect();
        wireTickBus(candidate);
        adapters.dhanAiData = candidate;
        log.important("DhanAdapter (ai-data) connected");
      } catch (err: any) {
        log.warn(`DhanAdapter (ai-data) NOT initialized: ${err.message}`);
      }
    } else {
      log.info(
        "DhanAdapter (ai-data) auth credentials missing — set them with: " +
        "node scripts/dhan-update-credentials.mjs --brokerId dhan-secondary-ac --clientId <ID> --pin <PIN> --totp <SECRET>"
      );
    }
  } catch (err) {
    log.warn("DhanAdapter (ai-data) initialization error:", err);
  }

  // 5. Instantiate MockAdapter (mock-paper) → no-op connect. One shared paper
  //    book for AI + My (T87); AI-vs-My is the per-trade source tag.
  try {
    adapters.mockPaper = new MockAdapter("mock-paper", "Paper");
    await adapters.mockPaper.connect();
    log.important("MockAdapter (mock-paper) ready");
  } catch (err) {
    log.warn("MockAdapter (mock-paper) failed:", err);
  }

  log.info("All adapters initialised.");
}

// ─── Broker Switching (legacy, kept for setup flow) ─────────────

export async function switchBroker(brokerId: string): Promise<BrokerAdapter> {
  const factory = adapterFactories.get(brokerId);
  if (!factory) {
    throw new Error(
      `No adapter registered for brokerId="${brokerId}". Registered: [${getRegisteredAdapters().join(", ")}]`
    );
  }
  const config = await getBrokerConfig(brokerId);
  if (!config) {
    throw new Error(`No broker config found for brokerId="${brokerId}".`);
  }
  if (adapters.dhanLive) {
    try { await adapters.dhanLive.disconnect(); } catch { /* ignore */ }
  }
  await setActiveBrokerInDB(brokerId);
  adapters.dhanLive = new DhanAdapter(brokerId);
  await adapters.dhanLive.connect();
  wireTickBus(adapters.dhanLive);
  killSwitch.ai = false;
  killSwitch.my = false;
  return adapters.dhanLive;
}

// ─── Shutdown ─────────────────────────────────────────────────────

/**
 * Close every initialised adapter's WS + REST connection. Called from
 * the graceful-shutdown coordinator (priority 500). Errors are logged
 * but never thrown — shutdown must continue to mongo even if one
 * adapter hangs.
 */
export async function disconnectAllAdapters(): Promise<void> {
  const all: Array<[string, BrokerAdapter | null]> = [
    ["dhanLive", adapters.dhanLive],
    ["dhanAiData", adapters.dhanAiData],
    ["mockPaper", adapters.mockPaper],
  ];
  for (const [name, adapter] of all) {
    if (!adapter) continue;
    try {
      await adapter.disconnect();
      log.info(`Disconnected ${name} (${adapter.brokerId})`);
    } catch (err) {
      log.warn(`Failed to disconnect ${name}: ${(err as Error).message}`);
    }
  }
}

// ─── Status ──────────────────────────────────────────────────────

export async function getBrokerServiceStatus(): Promise<BrokerServiceStatus> {
  let tokenStatus: BrokerServiceStatus["tokenStatus"] = "unknown";
  let apiStatus: BrokerServiceStatus["apiStatus"] = "disconnected";
  let wsStatus: BrokerServiceStatus["wsStatus"] = "disconnected";

  const broker = adapters.dhanLive;
  if (broker) {
    try {
      const tokenResult = await broker.validateToken();
      tokenStatus = tokenResult.valid ? "valid" : "expired";
    } catch {
      tokenStatus = "unknown";
    }
    const config = await getActiveBrokerConfig();
    if (config) {
      apiStatus = config.connection.apiStatus;
      wsStatus = config.connection.wsStatus;
    }
  }

  return {
    activeBrokerId: broker?.brokerId ?? null,
    activeBrokerName: broker?.displayName ?? null,
    tokenStatus,
    apiStatus,
    wsStatus,
    killSwitchActive: killSwitch.ai || killSwitch.my,
    registeredAdapters: getRegisteredAdapters(),
  };
}

// ─── Tick Bus Wiring ─────────────────────────────────────────────

function wireTickBus(adapter: BrokerAdapter): void {
  // B11-followup 2/3 — stamp the source broker on every emitted event
  // so multi-adapter setups (dhan-primary-ac + dhan-secondary-ac) don't
  // collide on orderId-only matching downstream. Adapters themselves don't
  // need to know about the bus shape; the wire layer owns the tag.
  adapter.onOrderUpdate((update) => {
    tickBus.emitOrderUpdate({ ...update, brokerId: adapter.brokerId });
  });
  log.info(`TickBus wired for ${adapter.brokerId}`);
}

// ─── Reset (for testing) ─────────────────────────────────────────

export function _resetForTesting(): void {
  adapters.dhanLive = null;
  adapters.dhanAiData = null;
  adapters.mockPaper = null;
  killSwitch.ai = false;
  killSwitch.my = false;
  adapterFactories.clear();
  adapterMeta.clear();
}

/**
 * Test-only — inject pre-built adapter instances directly into the BSA
 * adapter map, bypassing initBrokerService(). Used by the channel-isolation
 * invariant test to avoid coupling to Mongo for a pure routing check.
 * Pass `null` for any slot that should remain unset.
 */
export function _setAdaptersForTesting(stubs: Partial<{
  dhanLive: BrokerAdapter;
  dhanAiData: BrokerAdapter;
  mockPaper: BrokerAdapter;
}>): void {
  if ("dhanLive" in stubs) adapters.dhanLive = stubs.dhanLive as DhanAdapter;
  if ("dhanAiData" in stubs) adapters.dhanAiData = stubs.dhanAiData as DhanAdapter;
  if ("mockPaper" in stubs) adapters.mockPaper = stubs.mockPaper as MockAdapter;
}
