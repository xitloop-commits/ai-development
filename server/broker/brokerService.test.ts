import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import {
  BrokerConfigModel,
  getBrokerConfig,
  getActiveBrokerConfig,
  getAllBrokerConfigs,
  upsertBrokerConfig,
  setActiveBroker,
  updateBrokerCredentials,
  updateBrokerConnection,
  updateBrokerSettings,
  deleteBrokerConfig,
} from "./brokerConfig";
import {
  registerAdapter,
  getRegisteredAdapters,
  getActiveBroker,
  initBrokerService,
  switchBroker,
  toggleKillSwitch,
  isKillSwitchActive,
  getBrokerServiceStatus,
  _resetForTesting,
} from "./brokerService";
import type { BrokerAdapter, OrderParams, ModifyParams } from "./types";

// ─── Test Helpers ───────────────────────────────────────────────

/** Minimal stub adapter for testing the service layer. */
function createStubAdapter(
  brokerId: string,
  displayName: string
): BrokerAdapter {
  let connected = false;
  let killActive = false;

  return {
    brokerId,
    displayName,

    async validateToken() {
      return { valid: true, expiresAt: Date.now() + 86400000 };
    },
    async updateToken() {},

    async placeOrder() {
      if (killActive) throw new Error("Kill switch active");
      return {
        orderId: "stub-order-1",
        status: "FILLED" as const,
        timestamp: Date.now(),
      };
    },
    async modifyOrder() {
      return {
        orderId: "stub-order-1",
        status: "OPEN" as const,
        timestamp: Date.now(),
      };
    },
    async cancelOrder() {
      return {
        orderId: "stub-order-1",
        status: "CANCELLED" as const,
        timestamp: Date.now(),
      };
    },
    async exitAll() {
      return [];
    },
    async getOrderBook() {
      return [];
    },
    async getOrderStatus() {
      return {
        orderId: "stub-order-1",
        instrument: "NIFTY_50",
        exchange: "NSE_FNO" as const,
        transactionType: "BUY" as const,
        optionType: "CE" as const,
        strike: 24500,
        expiry: "2026-04-03",
        quantity: 50,
        filledQuantity: 50,
        price: 100,
        averagePrice: 100,
        orderType: "LIMIT" as const,
        productType: "INTRADAY" as const,
        status: "FILLED" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    },
    async getTradeBook() {
      return [];
    },
    async getPositions() {
      return [];
    },
    async getMargin() {
      return { available: 500000, used: 0, total: 500000 };
    },
    async getScripMaster() {
      return [];
    },
    async getExpiryList() {
      return [];
    },
    async getOptionChain() {
      return {
        underlying: "",
        expiry: "",
        spotPrice: 0,
        rows: [],
        timestamp: Date.now(),
      };
    },
    subscribeLTP() {},
    unsubscribeLTP() {},
    onOrderUpdate() {},

    async connect() {
      connected = true;
    },
    async disconnect() {
      connected = false;
    },

    async killSwitch(action) {
      killActive = action === "ACTIVATE";
      return {
        status: killActive ? "activated" : "deactivated",
        message: `Kill switch ${killActive ? "activated" : "deactivated"}`,
      };
    },
  };
}

// ─── Setup & Teardown ───────────────────────────────────────────

beforeAll(async () => {
  const uri = process.env.MONGODB_URI!;
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });
  }
}, 15000);

afterAll(async () => {
  // Clean up test data
  await BrokerConfigModel.deleteMany({
    brokerId: { $in: ["test_dhan", "test_mock", "test_broker_a", "test_broker_b"] },
  });
  await mongoose.disconnect();
}, 10000);

// ─── Test Suite 1: Broker Config CRUD ───────────────────────────

describe("Broker Config CRUD", () => {
  beforeEach(async () => {
    // Clean up before each test
    await BrokerConfigModel.deleteMany({
      brokerId: { $in: ["test_dhan", "test_mock"] },
    });
  });

  it("creates a new broker config via upsert", async () => {
    const config = await upsertBrokerConfig({
      brokerId: "test_dhan",
      displayName: "Dhan (Test)",
      isActive: false,
      isPaperBroker: false,
      capabilities: {
        bracketOrder: true,
        coverOrder: true,
        websocket: true,
        optionChain: true,
        gtt: true,
        amo: true,
      },
    });

    expect(config.brokerId).toBe("test_dhan");
    expect(config.displayName).toBe("Dhan (Test)");
    expect(config.isActive).toBe(false);
    expect(config.capabilities.bracketOrder).toBe(true);
    expect(config.credentials.status).toBe("unknown");
    expect(config.settings.orderEntryOffset).toBe(1.0);
  }, 10000);

  it("reads a broker config by brokerId", async () => {
    await upsertBrokerConfig({
      brokerId: "test_dhan",
      displayName: "Dhan (Test)",
    });

    const config = await getBrokerConfig("test_dhan");
    expect(config).not.toBeNull();
    expect(config!.brokerId).toBe("test_dhan");
    expect(config!.displayName).toBe("Dhan (Test)");
  }, 10000);

  it("returns null for non-existent brokerId", async () => {
    const config = await getBrokerConfig("non_existent_broker");
    expect(config).toBeNull();
  }, 10000);

  it("updates an existing config via upsert", async () => {
    await upsertBrokerConfig({
      brokerId: "test_dhan",
      displayName: "Dhan (Test)",
    });

    const updated = await upsertBrokerConfig({
      brokerId: "test_dhan",
      displayName: "Dhan (Updated)",
      isActive: true,
    });

    expect(updated.displayName).toBe("Dhan (Updated)");
    expect(updated.isActive).toBe(true);
  }, 10000);

  it("sets active broker (deactivates others)", async () => {
    await upsertBrokerConfig({
      brokerId: "test_dhan",
      displayName: "Dhan",
      isActive: true,
    });
    await upsertBrokerConfig({
      brokerId: "test_mock",
      displayName: "Mock",
      isActive: false,
    });

    const result = await setActiveBroker("test_mock");
    expect(result).not.toBeNull();
    expect(result!.isActive).toBe(true);

    const dhan = await getBrokerConfig("test_dhan");
    expect(dhan!.isActive).toBe(false);

    const active = await getActiveBrokerConfig();
    expect(active).not.toBeNull();
    expect(active!.brokerId).toBe("test_mock");
  }, 10000);

  it("updates broker credentials", async () => {
    await upsertBrokerConfig({
      brokerId: "test_dhan",
      displayName: "Dhan",
    });

    const updated = await updateBrokerCredentials("test_dhan", {
      accessToken: "new_token_123",
      clientId: "client_456",
      updatedAt: Date.now(),
      status: "valid",
    });

    expect(updated).not.toBeNull();
    expect(updated!.credentials.accessToken).toBe("new_token_123");
    expect(updated!.credentials.clientId).toBe("client_456");
    expect(updated!.credentials.status).toBe("valid");
  }, 10000);

  it("updates broker connection status", async () => {
    await upsertBrokerConfig({
      brokerId: "test_dhan",
      displayName: "Dhan",
    });

    const updated = await updateBrokerConnection("test_dhan", {
      apiStatus: "connected",
      latencyMs: 150,
      lastApiCall: Date.now(),
    });

    expect(updated).not.toBeNull();
    expect(updated!.connection.apiStatus).toBe("connected");
    expect(updated!.connection.latencyMs).toBe(150);
  }, 10000);

  it("updates broker settings", async () => {
    await upsertBrokerConfig({
      brokerId: "test_dhan",
      displayName: "Dhan",
    });

    const updated = await updateBrokerSettings("test_dhan", {
      orderEntryOffset: 0.5,
      defaultSL: 3.0,
    });

    expect(updated).not.toBeNull();
    expect(updated!.settings.orderEntryOffset).toBe(0.5);
    expect(updated!.settings.defaultSL).toBe(3.0);
    // Unchanged defaults preserved
    expect(updated!.settings.defaultTP).toBe(5.0);
  }, 10000);

  it("gets all broker configs", async () => {
    await upsertBrokerConfig({
      brokerId: "test_dhan",
      displayName: "Dhan",
    });
    await upsertBrokerConfig({
      brokerId: "test_mock",
      displayName: "Mock",
    });

    const all = await getAllBrokerConfigs();
    const testConfigs = all.filter((c) =>
      ["test_dhan", "test_mock"].includes(c.brokerId)
    );
    expect(testConfigs.length).toBe(2);
  }, 10000);

  it("deletes a broker config", async () => {
    await upsertBrokerConfig({
      brokerId: "test_dhan",
      displayName: "Dhan",
    });

    const deleted = await deleteBrokerConfig("test_dhan");
    expect(deleted).toBe(true);

    const config = await getBrokerConfig("test_dhan");
    expect(config).toBeNull();
  }, 10000);

  it("returns false when deleting non-existent config", async () => {
    const deleted = await deleteBrokerConfig("non_existent_broker");
    expect(deleted).toBe(false);
  }, 10000);
});

// ─── Test Suite 2: Broker Service ───────────────────────────────

describe("Broker Service", () => {
  beforeEach(async () => {
    _resetForTesting();
    await BrokerConfigModel.deleteMany({
      brokerId: { $in: ["test_broker_a", "test_broker_b"] },
    });
  });

  it("registers adapter factories", () => {
    registerAdapter("test_broker_a", () =>
      createStubAdapter("test_broker_a", "Broker A")
    );
    registerAdapter("test_broker_b", () =>
      createStubAdapter("test_broker_b", "Broker B")
    );

    const registered = getRegisteredAdapters();
    expect(registered).toContain("test_broker_a");
    expect(registered).toContain("test_broker_b");
    expect(registered.length).toBe(2);
  });

  it("returns null when no adapter is active", () => {
    const adapter = getActiveBroker();
    expect(adapter).toBeNull();
  });

  it("initBrokerService loads active adapter from MongoDB", async () => {
    // Create config and set active
    await upsertBrokerConfig({
      brokerId: "test_broker_a",
      displayName: "Broker A",
      isActive: true,
    });

    registerAdapter("test_broker_a", () =>
      createStubAdapter("test_broker_a", "Broker A")
    );

    await initBrokerService();

    const adapter = getActiveBroker();
    expect(adapter).not.toBeNull();
    expect(adapter!.brokerId).toBe("test_broker_a");
    expect(adapter!.displayName).toBe("Broker A");
  }, 10000);

  it("initBrokerService is idle when no active config exists", async () => {
    registerAdapter("test_broker_a", () =>
      createStubAdapter("test_broker_a", "Broker A")
    );

    await initBrokerService();

    const adapter = getActiveBroker();
    expect(adapter).toBeNull();
  }, 10000);

  it("switchBroker changes the active adapter", async () => {
    // Create configs
    await upsertBrokerConfig({
      brokerId: "test_broker_a",
      displayName: "Broker A",
      isActive: true,
    });
    await upsertBrokerConfig({
      brokerId: "test_broker_b",
      displayName: "Broker B",
      isActive: false,
    });

    registerAdapter("test_broker_a", () =>
      createStubAdapter("test_broker_a", "Broker A")
    );
    registerAdapter("test_broker_b", () =>
      createStubAdapter("test_broker_b", "Broker B")
    );

    // Start with A
    await initBrokerService();
    expect(getActiveBroker()!.brokerId).toBe("test_broker_a");

    // Switch to B
    await switchBroker("test_broker_b");
    expect(getActiveBroker()!.brokerId).toBe("test_broker_b");

    // Verify MongoDB updated
    const configB = await getBrokerConfig("test_broker_b");
    expect(configB!.isActive).toBe(true);
    const configA = await getBrokerConfig("test_broker_a");
    expect(configA!.isActive).toBe(false);
  }, 15000);

  it("switchBroker throws for unregistered adapter", async () => {
    await expect(switchBroker("unknown_broker")).rejects.toThrow(
      /No adapter registered/
    );
  }, 10000);

  it("switchBroker throws for missing config", async () => {
    registerAdapter("test_broker_a", () =>
      createStubAdapter("test_broker_a", "Broker A")
    );

    await expect(switchBroker("test_broker_a")).rejects.toThrow(
      /No broker config found/
    );
  }, 10000);

  it("kill switch activates and deactivates", async () => {
    await upsertBrokerConfig({
      brokerId: "test_broker_a",
      displayName: "Broker A",
      isActive: true,
    });
    registerAdapter("test_broker_a", () =>
      createStubAdapter("test_broker_a", "Broker A")
    );
    await initBrokerService();

    // Activate
    const activateResult = await toggleKillSwitch("ACTIVATE");
    expect(activateResult.status).toBe("activated");
    expect(isKillSwitchActive()).toBe(true);

    // Deactivate
    const deactivateResult = await toggleKillSwitch("DEACTIVATE");
    expect(deactivateResult.status).toBe("deactivated");
    expect(isKillSwitchActive()).toBe(false);
  }, 10000);

  it("getBrokerServiceStatus returns correct shape", async () => {
    await upsertBrokerConfig({
      brokerId: "test_broker_a",
      displayName: "Broker A",
      isActive: true,
    });
    registerAdapter("test_broker_a", () =>
      createStubAdapter("test_broker_a", "Broker A")
    );
    await initBrokerService();

    const status = await getBrokerServiceStatus();
    expect(status.activeBrokerId).toBe("test_broker_a");
    expect(status.activeBrokerName).toBe("Broker A");
    expect(status.tokenStatus).toBe("valid");
    expect(status.killSwitchActive).toBe(false);
    expect(status.registeredAdapters).toContain("test_broker_a");
  }, 10000);

  it("getBrokerServiceStatus with no active adapter", async () => {
    const status = await getBrokerServiceStatus();
    expect(status.activeBrokerId).toBeNull();
    expect(status.activeBrokerName).toBeNull();
    expect(status.tokenStatus).toBe("unknown");
    expect(status.killSwitchActive).toBe(false);
  }, 10000);
});
