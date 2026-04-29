/**
 * Broker Service — Multi-Adapter Singleton (BSA v1.7)
 *
 * Manages four named adapter slots, each serving specific trading channels:
 *   dhanLive    → ai-live, my-live, testing-live  (brokerId: "dhan")
 *   dhanSandbox → testing-sandbox                 (brokerId: "dhan-sandbox", sandboxMode)
 *   mockAi      → ai-paper                        (brokerId: "mock-ai")
 *   mockMy      → my-paper                        (brokerId: "mock-my")
 *
 * Kill switches are per-workspace and independent (ai / my / testing).
 * Kill switch state is persisted to user_settings and loaded at startup.
 */

import type { BrokerAdapter, BrokerServiceStatus } from "./types";
import {
  getBrokerConfig,
  getActiveBrokerConfig,
  getAllBrokerConfigs,
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
  | "ai-live"
  | "ai-paper"
  | "my-live"
  | "my-paper"
  | "testing-live"
  | "testing-sandbox";

export type Workspace = "ai" | "my" | "testing";

// ─── Singleton State ────────────────────────────────────────────

interface BSAAdapters {
  dhanLive: DhanAdapter | null;       // my-live, testing-live  (user's primary Dhan account)
  dhanAiData: DhanAdapter | null;     // ai-live + TFA data feed (spouse's Dhan account)
  dhanSandbox: DhanAdapter | null;    // testing-sandbox
  mockAi: MockAdapter | null;         // ai-paper
  mockMy: MockAdapter | null;         // my-paper
}

const adapters: BSAAdapters = {
  dhanLive: null,
  dhanAiData: null,
  dhanSandbox: null,
  mockAi: null,
  mockMy: null,
};

interface KillSwitchState {
  ai: boolean;
  my: boolean;
  testing: boolean;
}

const killSwitch: KillSwitchState = {
  ai: false,
  my: false,
  testing: false,
};

// ─── Legacy registry (kept for backward compat with setup flow) ──

const adapterFactories = new Map<string, AdapterFactory>();
const adapterMeta = new Map<string, AdapterMeta>();

// ─── Seed Documents ─────────────────────────────────────────────

/**
 * Ensure the 4 required broker_configs documents exist in MongoDB.
 * Uses upsert — will NOT overwrite existing tokens or settings.
 */
async function seedBrokerConfigs(): Promise<void> {
  type Seed = {
    brokerId: string;
    displayName: string;
    isPaperBroker: boolean;
    sandboxMode: boolean;
    role: "trading" | "data-and-ai" | "paper" | "sandbox";
  };
  const seeds: Seed[] = [
    { brokerId: "dhan",          displayName: "Dhan (Trading)",      isPaperBroker: false, sandboxMode: false, role: "trading"     },
    { brokerId: "dhan-ai-data",  displayName: "Dhan (AI + Data)",    isPaperBroker: false, sandboxMode: false, role: "data-and-ai" },
    { brokerId: "dhan-sandbox",  displayName: "Dhan Sandbox",        isPaperBroker: false, sandboxMode: true,  role: "sandbox"     },
    { brokerId: "mock-ai",       displayName: "Paper (AI Trades)",   isPaperBroker: true,  sandboxMode: false, role: "paper"       },
    { brokerId: "mock-my",       displayName: "Paper (My Trades)",   isPaperBroker: true,  sandboxMode: false, role: "paper"       },
  ];

  for (const seed of seeds) {
    const existing = await getBrokerConfig(seed.brokerId);
    if (!existing) {
      await upsertBrokerConfig({
        brokerId: seed.brokerId,
        displayName: seed.displayName,
        isPaperBroker: seed.isPaperBroker,
        sandboxMode: seed.sandboxMode,
        role: seed.role,
        isActive: seed.brokerId === "dhan", // primary trading account is the default active broker
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
 * One-time migration: if the primary "dhan" broker_config has no auth
 * credentials yet but the legacy .env vars are present, copy them into
 * MongoDB. Lets users delete the env vars after first boot. Idempotent.
 *
 * Only "dhan" (primary) is migrated — multi-account credentials never
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

  const doc = await db.collection("broker_configs").findOne({ brokerId: "dhan" });
  if (!doc) return;

  const auth = (doc as any).auth ?? {};
  const update: Record<string, string> = {};

  if (!auth.clientId   && envClientId)   update["auth.clientId"]   = envClientId;
  if (!auth.pin        && envPin)        update["auth.pin"]        = envPin;
  if (!auth.totpSecret && envTotpSecret) update["auth.totpSecret"] = envTotpSecret;

  if (Object.keys(update).length === 0) return;

  await db.collection("broker_configs").updateOne({ brokerId: "dhan" }, { $set: update });
  log.info(
    `Migrated env credentials to broker_configs.auth (dhan): ${Object.keys(update).join(", ")}. ` +
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
      // Prefer the dedicated dhan-ai-data adapter (spouse account); fall back
      // to dhan-primary if dhan-ai-data hasn't been configured yet (first-run
      // before credentials are entered into Settings).
      if (adapters.dhanAiData) return adapters.dhanAiData;
      if (adapters.dhanLive) return adapters.dhanLive;
      throw new Error("Neither DhanAdapter (ai-data) nor (live) is initialised");
    case "my-live":
    case "testing-live":
      if (!adapters.dhanLive) throw new Error("DhanAdapter (live) not initialised");
      return adapters.dhanLive;
    case "testing-sandbox":
      if (!adapters.dhanSandbox) throw new Error("DhanAdapter (sandbox) not initialised");
      return adapters.dhanSandbox;
    case "ai-paper":
      if (!adapters.mockAi) throw new Error("MockAdapter (mock-ai) not initialised");
      return adapters.mockAi;
    case "my-paper":
      if (!adapters.mockMy) throw new Error("MockAdapter (mock-my) not initialised");
      return adapters.mockMy;
    default:
      throw new Error(`Unknown channel: ${channel}`);
  }
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
    case "testing-live": return killSwitch.testing;
    default:            return false; // paper / sandbox never blocked
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
      testingKillSwitch: killSwitch.testing,
    },
  });

  // If activating, call killSwitch on the live channel adapter
  if (active) {
    const channelMap: Record<Workspace, "ai-live" | "my-live" | "testing-live"> = {
      ai: "ai-live",
      my: "my-live",
      testing: "testing-live",
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
 * Get the currently active adapter (dhanLive by default).
 * Kept for backward compatibility — prefer getAdapter(channel) in new code.
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
  await toggleWorkspaceKillSwitch("testing", action);
  return {
    status: action === "ACTIVATE" ? "activated" : "deactivated",
    message: `All kill switches ${action === "ACTIVATE" ? "activated" : "deactivated"}.`,
  };
}

/** @deprecated use isChannelKillSwitchActive(channel) */
export function isKillSwitchActive(): boolean {
  return killSwitch.ai || killSwitch.my || killSwitch.testing;
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
    killSwitch.testing = settings.tradingMode.testingKillSwitch;
    log.info(`Kill switches loaded — ai:${killSwitch.ai} my:${killSwitch.my} testing:${killSwitch.testing}`);
  } catch (err) {
    log.warn("Could not load kill switch state, defaulting to OFF:", err);
  }

  // 3. Instantiate DhanAdapter (live) → connect (opens WS + order update WS)
  try {
    adapters.dhanLive = new DhanAdapter("dhan", false);
    await adapters.dhanLive.connect();
    wireTickBus(adapters.dhanLive);
    log.important("DhanAdapter (live) connected");
  } catch (err) {
    log.error("DhanAdapter (live) failed to connect:", err);
  }

  // 4. Instantiate DhanAdapter (sandbox) → token validation only, no WS
  try {
    adapters.dhanSandbox = new DhanAdapter("dhan-sandbox", true);
    await adapters.dhanSandbox.connect();
    log.important("DhanAdapter (sandbox) connected");
  } catch (err) {
    log.warn("DhanAdapter (sandbox) failed to connect:", err);
  }

  // 4b. Instantiate DhanAdapter (ai-data) → spouse's Dhan account for TFA + AI Live.
  // Pre-check the TOTP refresh INPUTS (auth.{clientId, pin, totpSecret}) rather
  // than the access token (which is the output — empty until the first refresh).
  // If connect() throws (auth credentials wrong, network down, etc.) we leave
  // adapters.dhanAiData null so getAdapter("ai-live") falls back to the primary.
  try {
    const aiDataConfig = await getBrokerConfig("dhan-ai-data");
    const auth = (aiDataConfig as any)?.auth ?? {};
    const hasAuthCreds = !!auth.clientId && !!auth.pin && !!auth.totpSecret;
    if (hasAuthCreds) {
      const candidate = new DhanAdapter("dhan-ai-data", false);
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
        "node scripts/dhan-update-credentials.mjs --brokerId dhan-ai-data --clientId <ID> --pin <PIN> --totp <SECRET>"
      );
    }
  } catch (err) {
    log.warn("DhanAdapter (ai-data) initialization error:", err);
  }

  // 5. Instantiate MockAdapter (mock-ai) → no-op connect
  try {
    adapters.mockAi = new MockAdapter("mock-ai", "Paper (AI Trades)");
    await adapters.mockAi.connect();
    log.important("MockAdapter (mock-ai) ready");
  } catch (err) {
    log.warn("MockAdapter (mock-ai) failed:", err);
  }

  // 6. Instantiate MockAdapter (mock-my) → no-op connect
  try {
    adapters.mockMy = new MockAdapter("mock-my", "Paper (My Trades)");
    await adapters.mockMy.connect();
    log.important("MockAdapter (mock-my) ready");
  } catch (err) {
    log.warn("MockAdapter (mock-my) failed:", err);
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
    try { await adapters.dhanLive.disconnect(); } catch {}
  }
  await setActiveBrokerInDB(brokerId);
  adapters.dhanLive = new DhanAdapter(brokerId, false);
  await adapters.dhanLive.connect();
  wireTickBus(adapters.dhanLive);
  killSwitch.ai = false;
  killSwitch.my = false;
  killSwitch.testing = false;
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
    ["dhanSandbox", adapters.dhanSandbox],
    ["mockAi", adapters.mockAi],
    ["mockMy", adapters.mockMy],
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
    killSwitchActive: killSwitch.ai || killSwitch.my || killSwitch.testing,
    registeredAdapters: getRegisteredAdapters(),
  };
}

// ─── Tick Bus Wiring ─────────────────────────────────────────────

function wireTickBus(adapter: BrokerAdapter): void {
  // B11-followup 2/3 — stamp the source broker on every emitted event
  // so multi-adapter setups (dhan + dhan-ai-data) don't collide on
  // orderId-only matching downstream. Adapters themselves don't need
  // to know about the bus shape; the wire layer owns the tag.
  adapter.onOrderUpdate((update) => {
    tickBus.emitOrderUpdate({ ...update, brokerId: adapter.brokerId });
  });
  log.info(`TickBus wired for ${adapter.brokerId}`);
}

// ─── Reset (for testing) ─────────────────────────────────────────

export function _resetForTesting(): void {
  adapters.dhanLive = null;
  adapters.dhanAiData = null;
  adapters.dhanSandbox = null;
  adapters.mockAi = null;
  adapters.mockMy = null;
  killSwitch.ai = false;
  killSwitch.my = false;
  killSwitch.testing = false;
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
  dhanSandbox: BrokerAdapter;
  mockAi: BrokerAdapter;
  mockMy: BrokerAdapter;
}>): void {
  if ("dhanLive" in stubs) adapters.dhanLive = stubs.dhanLive as DhanAdapter;
  if ("dhanAiData" in stubs) adapters.dhanAiData = stubs.dhanAiData as DhanAdapter;
  if ("dhanSandbox" in stubs) adapters.dhanSandbox = stubs.dhanSandbox as DhanAdapter;
  if ("mockAi" in stubs) adapters.mockAi = stubs.mockAi as MockAdapter;
  if ("mockMy" in stubs) adapters.mockMy = stubs.mockMy as MockAdapter;
}
