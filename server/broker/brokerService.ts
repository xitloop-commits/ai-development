/**
 * Broker Service — Singleton
 *
 * Central orchestrator that:
 * 1. Registers adapter factories (Dhan, Mock, future brokers)
 * 2. Loads the active adapter based on MongoDB broker_configs
 * 3. Routes all calls through the active adapter
 * 4. Provides status and switching capabilities
 */

import type { BrokerAdapter, BrokerServiceStatus } from "./types";
import {
  getActiveBrokerConfig,
  getBrokerConfig,
  setActiveBroker as setActiveBrokerInDB,
} from "./brokerConfig";

// ─── Types ──────────────────────────────────────────────────────

/** Factory function that creates an adapter instance. */
export type AdapterFactory = () => BrokerAdapter;

// ─── Singleton State ────────────────────────────────────────────

const adapterFactories = new Map<string, AdapterFactory>();
let activeAdapter: BrokerAdapter | null = null;
let killSwitchActive = false;

// ─── Registration ───────────────────────────────────────────────

/**
 * Register an adapter factory. Call this at startup for each broker.
 * Does NOT instantiate the adapter — just stores the factory.
 */
export function registerAdapter(
  brokerId: string,
  factory: AdapterFactory
): void {
  adapterFactories.set(brokerId, factory);
  console.log(`[BrokerService] Registered adapter: ${brokerId}`);
}

/**
 * Get list of all registered adapter IDs.
 */
export function getRegisteredAdapters(): string[] {
  return Array.from(adapterFactories.keys());
}

// ─── Active Adapter ─────────────────────────────────────────────

/**
 * Get the currently active adapter.
 * Returns null if no adapter is loaded.
 */
export function getActiveBroker(): BrokerAdapter | null {
  return activeAdapter;
}

/**
 * Initialize the broker service by loading the active adapter from MongoDB.
 * Call this once at server startup (after MongoDB is connected).
 */
export async function initBrokerService(): Promise<void> {
  const config = await getActiveBrokerConfig();

  if (!config) {
    console.log(
      "[BrokerService] No active broker config found. Service idle."
    );
    return;
  }

  const factory = adapterFactories.get(config.brokerId);
  if (!factory) {
    console.warn(
      `[BrokerService] No adapter registered for brokerId="${config.brokerId}". Service idle.`
    );
    return;
  }

  try {
    activeAdapter = factory();
    await activeAdapter.connect();
    console.log(
      `[BrokerService] Active adapter loaded: ${activeAdapter.displayName} (${activeAdapter.brokerId})`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[BrokerService] Failed to connect adapter "${config.brokerId}": ${message}`
    );
    // Keep the adapter reference so we can retry later
  }
}

/**
 * Switch the active broker. Disconnects the current adapter and loads the new one.
 * Also updates MongoDB to mark the new broker as active.
 */
export async function switchBroker(brokerId: string): Promise<BrokerAdapter> {
  // Validate the adapter is registered
  const factory = adapterFactories.get(brokerId);
  if (!factory) {
    throw new Error(
      `No adapter registered for brokerId="${brokerId}". Registered: [${getRegisteredAdapters().join(", ")}]`
    );
  }

  // Validate the broker config exists in MongoDB
  const config = await getBrokerConfig(brokerId);
  if (!config) {
    throw new Error(
      `No broker config found in MongoDB for brokerId="${brokerId}". Create one first.`
    );
  }

  // Disconnect current adapter
  if (activeAdapter) {
    try {
      await activeAdapter.disconnect();
      console.log(
        `[BrokerService] Disconnected: ${activeAdapter.displayName}`
      );
    } catch (err) {
      console.warn(
        `[BrokerService] Error disconnecting ${activeAdapter.brokerId}:`,
        err
      );
    }
  }

  // Update MongoDB
  await setActiveBrokerInDB(brokerId);

  // Create and connect new adapter
  activeAdapter = factory();
  await activeAdapter.connect();
  killSwitchActive = false;

  console.log(
    `[BrokerService] Switched to: ${activeAdapter.displayName} (${activeAdapter.brokerId})`
  );

  return activeAdapter;
}

// ─── Kill Switch ────────────────────────────────────────────────

/**
 * Activate or deactivate the kill switch.
 * When active: all new order calls are blocked, exitAll is triggered.
 */
export async function toggleKillSwitch(
  action: "ACTIVATE" | "DEACTIVATE"
): Promise<{ status: string; message?: string }> {
  if (action === "ACTIVATE") {
    killSwitchActive = true;

    if (activeAdapter) {
      try {
        const result = await activeAdapter.killSwitch("ACTIVATE");
        return {
          status: "activated",
          message: result.message ?? "Kill switch activated. All trading halted.",
        };
      } catch (err) {
        return {
          status: "activated_with_errors",
          message: `Kill switch activated but adapter reported: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return { status: "activated", message: "Kill switch activated (no active adapter)." };
  }

  // DEACTIVATE
  killSwitchActive = false;

  if (activeAdapter) {
    try {
      await activeAdapter.killSwitch("DEACTIVATE");
    } catch {
      // ignore deactivation errors
    }
  }

  return { status: "deactivated", message: "Kill switch deactivated. Trading resumed." };
}

/**
 * Check if the kill switch is currently active.
 */
export function isKillSwitchActive(): boolean {
  return killSwitchActive;
}

// ─── Status ─────────────────────────────────────────────────────

/**
 * Get the overall broker service status.
 */
export async function getBrokerServiceStatus(): Promise<BrokerServiceStatus> {
  let tokenStatus: BrokerServiceStatus["tokenStatus"] = "unknown";
  let apiStatus: BrokerServiceStatus["apiStatus"] = "disconnected";
  let wsStatus: BrokerServiceStatus["wsStatus"] = "disconnected";

  if (activeAdapter) {
    try {
      const tokenResult = await activeAdapter.validateToken();
      tokenStatus = tokenResult.valid ? "valid" : "expired";
    } catch {
      tokenStatus = "unknown";
    }

    // Read connection status from config if available
    const config = await getActiveBrokerConfig();
    if (config) {
      apiStatus = config.connection.apiStatus;
      wsStatus = config.connection.wsStatus;
    }
  }

  return {
    activeBrokerId: activeAdapter?.brokerId ?? null,
    activeBrokerName: activeAdapter?.displayName ?? null,
    tokenStatus,
    apiStatus,
    wsStatus,
    killSwitchActive,
    registeredAdapters: getRegisteredAdapters(),
  };
}

// ─── Reset (for testing) ────────────────────────────────────────

/**
 * Reset the broker service state. Used in tests only.
 */
export function _resetForTesting(): void {
  activeAdapter = null;
  killSwitchActive = false;
  adapterFactories.clear();
}
