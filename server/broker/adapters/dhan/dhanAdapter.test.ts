/**
 * DhanAdapter Tests
 *
 * Tests the DhanAdapter with mocked HTTP calls (no real Dhan API needed).
 * Covers:
 * - Token expiry calculation
 * - Token validation (mocked /fundlimit)
 * - 401 detection and handling
 * - updateToken flow with MongoDB persistence
 * - Order placement with mocked responses
 * - Kill switch
 * - Connect/disconnect lifecycle
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../../../mongo";
import { DhanAdapter } from "./index";
import { calculateTokenExpiry } from "./auth";
import { DHAN_TOKEN_EXPIRY_MS, DHAN_TOKEN_EXPIRY_BUFFER_MS } from "./constants";
import {
  BrokerConfigModel,
  upsertBrokerConfig,
  getBrokerConfig,
} from "../../brokerConfig";

// ─── Test Setup ────────────────────────────────────────────────

const TEST_BROKER_ID = "dhan";
const TEST_CLIENT_ID = "1000000099";
const TEST_TOKEN = "test-jwt-token-abc123";

// Mock global fetch
const originalFetch = global.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof global.fetch;
}

function restoreFetch() {
  global.fetch = originalFetch;
}

// ─── Connect to MongoDB ────────────────────────────────────────

beforeEach(async () => {
  await connectMongo();
  // Clean up test broker config
  await BrokerConfigModel.deleteMany({ brokerId: TEST_BROKER_ID });
  restoreFetch();
});

afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await BrokerConfigModel.deleteMany({ brokerId: TEST_BROKER_ID });
  await disconnectMongo();
});

// ─── Token Expiry Calculation ──────────────────────────────────

describe("calculateTokenExpiry", () => {
  it("should report valid token within expiry window", () => {
    const updatedAt = Date.now() - 1000 * 60 * 60; // 1 hour ago
    const result = calculateTokenExpiry(updatedAt);

    expect(result.isExpired).toBe(false);
    expect(result.isExpiringSoon).toBe(false);
    expect(result.remainingMs).toBeGreaterThan(0);
    expect(result.expiresAt).toBe(updatedAt + DHAN_TOKEN_EXPIRY_MS);
  });

  it("should report expired token past 24 hours", () => {
    const updatedAt = Date.now() - DHAN_TOKEN_EXPIRY_MS - 1000; // 24h + 1s ago
    const result = calculateTokenExpiry(updatedAt);

    expect(result.isExpired).toBe(true);
    expect(result.remainingMs).toBe(0);
  });

  it("should report expiring soon within buffer window", () => {
    // Set updatedAt so remaining time is 30 minutes (within 1h buffer)
    const updatedAt = Date.now() - DHAN_TOKEN_EXPIRY_MS + 30 * 60 * 1000;
    const result = calculateTokenExpiry(updatedAt);

    expect(result.isExpired).toBe(false);
    expect(result.isExpiringSoon).toBe(true);
    expect(result.remainingMs).toBeLessThanOrEqual(DHAN_TOKEN_EXPIRY_BUFFER_MS);
  });

  it("should handle custom expiresIn value", () => {
    const customExpiry = 2 * 60 * 60 * 1000; // 2 hours
    const updatedAt = Date.now() - customExpiry - 1000;
    const result = calculateTokenExpiry(updatedAt, customExpiry);

    expect(result.isExpired).toBe(true);
  });
});

// ─── Token Validation (mocked HTTP) ───────────────────────────

describe("DhanAdapter.validateToken", () => {
  it("should return valid when Dhan API returns 200 with fund data", async () => {
    // Create config in MongoDB
    await upsertBrokerConfig({
      brokerId: TEST_BROKER_ID,
      displayName: "Dhan",
      isActive: true,
      isPaperBroker: false,
      credentials: {
        accessToken: TEST_TOKEN,
        clientId: TEST_CLIENT_ID,
        updatedAt: Date.now(),
        expiresIn: DHAN_TOKEN_EXPIRY_MS,
        status: "valid",
      },
    });

    // Mock Dhan /fundlimit → 200
    mockFetch((url) => {
      if (url.includes("/fundlimit")) {
        return new Response(
          JSON.stringify({
            dhanClientId: TEST_CLIENT_ID,
            availabelBalance: 50000,
            sodLimit: 100000,
            collateralAmount: 0,
            receiveableAmount: 0,
            utilizedAmount: 50000,
            blockedPayoutAmount: 0,
            withdrawableBalance: 50000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const adapter = new DhanAdapter();
    adapter._setInternalState({
      accessToken: TEST_TOKEN,
      clientId: TEST_CLIENT_ID,
      tokenUpdatedAt: Date.now(),
    });

    const result = await adapter.validateToken();

    expect(result.valid).toBe(true);
    expect(result.expiresAt).toBeDefined();
    expect(result.expiresAt!).toBeGreaterThan(Date.now());
  });

  it("should return invalid when Dhan API returns 401", async () => {
    await upsertBrokerConfig({
      brokerId: TEST_BROKER_ID,
      displayName: "Dhan",
      isActive: true,
      isPaperBroker: false,
      credentials: {
        accessToken: "expired-token",
        clientId: TEST_CLIENT_ID,
        updatedAt: Date.now() - DHAN_TOKEN_EXPIRY_MS - 1000,
        expiresIn: DHAN_TOKEN_EXPIRY_MS,
        status: "valid",
      },
    });

    const adapter = new DhanAdapter();
    adapter._setInternalState({
      accessToken: "expired-token",
      clientId: TEST_CLIENT_ID,
      tokenUpdatedAt: Date.now() - DHAN_TOKEN_EXPIRY_MS - 1000, // expired
    });

    const result = await adapter.validateToken();

    expect(result.valid).toBe(false);

    // Verify MongoDB was updated
    const config = await getBrokerConfig(TEST_BROKER_ID);
    expect(config?.credentials.status).toBe("expired");
    expect(config?.connection.apiStatus).toBe("error");
  });

  it("should return invalid when no token is set", async () => {
    const adapter = new DhanAdapter();
    adapter._setInternalState({ accessToken: "", tokenUpdatedAt: 0 });

    const result = await adapter.validateToken();
    expect(result.valid).toBe(false);
  });
});

// ─── updateToken Flow ──────────────────────────────────────────

describe("DhanAdapter.updateToken", () => {
  it("should validate and save a valid token to MongoDB", async () => {
    await upsertBrokerConfig({
      brokerId: TEST_BROKER_ID,
      displayName: "Dhan",
      isActive: true,
      isPaperBroker: false,
    });

    // Mock Dhan /fundlimit → 200 (token is valid)
    mockFetch((url) => {
      if (url.includes("/fundlimit")) {
        return new Response(
          JSON.stringify({
            dhanClientId: TEST_CLIENT_ID,
            availabelBalance: 75000,
            sodLimit: 100000,
            collateralAmount: 0,
            receiveableAmount: 0,
            utilizedAmount: 25000,
            blockedPayoutAmount: 0,
            withdrawableBalance: 75000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const adapter = new DhanAdapter();
    await adapter.updateToken(TEST_TOKEN, TEST_CLIENT_ID);

    // Verify internal state
    const state = adapter._getInternalState();
    expect(state.accessToken).toBe(TEST_TOKEN);
    expect(state.clientId).toBe(TEST_CLIENT_ID);
    expect(state.tokenUpdatedAt).toBeGreaterThan(0);

    // Verify MongoDB was updated
    const config = await getBrokerConfig(TEST_BROKER_ID);
    expect(config?.credentials.accessToken).toBe(TEST_TOKEN);
    expect(config?.credentials.clientId).toBe(TEST_CLIENT_ID);
    expect(config?.credentials.status).toBe("valid");
    expect(config?.connection.apiStatus).toBe("connected");
  });

  it("should reject and mark expired when token is invalid", async () => {
    await upsertBrokerConfig({
      brokerId: TEST_BROKER_ID,
      displayName: "Dhan",
      isActive: true,
      isPaperBroker: false,
    });

    // Mock Dhan /fundlimit → 401 (token is invalid)
    mockFetch((url) => {
      if (url.includes("/fundlimit")) {
        return new Response(
          JSON.stringify({
            errorType: "DH-901",
            errorCode: "401",
            errorMessage: "Unauthorized",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const adapter = new DhanAdapter();

    await expect(adapter.updateToken("bad-token")).rejects.toThrow();

    // Verify MongoDB was updated with expired status
    const config = await getBrokerConfig(TEST_BROKER_ID);
    expect(config?.credentials.status).toBe("expired");
    expect(config?.connection.apiStatus).toBe("error");
  });
});

// ─── Order Placement (mocked HTTP) ────────────────────────────

describe("DhanAdapter.placeOrder", () => {
  it("should place an order successfully", async () => {
    mockFetch((url, init) => {
      if (url.includes("/orders") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            orderId: "ORD-12345",
            orderStatus: "TRANSIT",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const adapter = new DhanAdapter();
    adapter._setInternalState({
      accessToken: TEST_TOKEN,
      clientId: TEST_CLIENT_ID,
      tokenUpdatedAt: Date.now(),
    });

    const result = await adapter.placeOrder({
      instrument: "52175",
      exchange: "NSE_FNO",
      transactionType: "BUY",
      optionType: "CE",
      strike: 24000,
      expiry: "2026-04-03",
      quantity: 75,
      price: 150,
      orderType: "LIMIT",
      productType: "INTRADAY",
    });

    expect(result.orderId).toBe("ORD-12345");
    expect(result.status).toBe("PENDING"); // TRANSIT maps to PENDING
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it("should throw when no token is set", async () => {
    const adapter = new DhanAdapter();
    adapter._setInternalState({ accessToken: "" });

    await expect(
      adapter.placeOrder({
        instrument: "52175",
        exchange: "NSE_FNO",
        transactionType: "BUY",
        optionType: "CE",
        strike: 24000,
        expiry: "2026-04-03",
        quantity: 75,
        price: 150,
        orderType: "LIMIT",
        productType: "INTRADAY",
      })
    ).rejects.toThrow("No Dhan access token configured");
  });

  it("should throw when kill switch is active", async () => {
    const adapter = new DhanAdapter();
    adapter._setInternalState({
      accessToken: TEST_TOKEN,
      clientId: TEST_CLIENT_ID,
      tokenUpdatedAt: Date.now(),
      killSwitchActive: true,
    });

    await expect(
      adapter.placeOrder({
        instrument: "52175",
        exchange: "NSE_FNO",
        transactionType: "BUY",
        optionType: "CE",
        strike: 24000,
        expiry: "2026-04-03",
        quantity: 75,
        price: 150,
        orderType: "LIMIT",
        productType: "INTRADAY",
      })
    ).rejects.toThrow("Kill switch is active");
  });

  it("should handle 401 during order placement", async () => {
    await upsertBrokerConfig({
      brokerId: TEST_BROKER_ID,
      displayName: "Dhan",
      isActive: true,
      isPaperBroker: false,
      credentials: {
        accessToken: TEST_TOKEN,
        clientId: TEST_CLIENT_ID,
        updatedAt: Date.now(),
        expiresIn: DHAN_TOKEN_EXPIRY_MS,
        status: "valid",
      },
    });

    mockFetch((url) => {
      return new Response(
        JSON.stringify({ errorType: "DH-901", errorCode: "401", errorMessage: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    });

    const adapter = new DhanAdapter();
    adapter._setInternalState({
      accessToken: TEST_TOKEN,
      clientId: TEST_CLIENT_ID,
      tokenUpdatedAt: Date.now(),
    });

    await expect(
      adapter.placeOrder({
        instrument: "52175",
        exchange: "NSE_FNO",
        transactionType: "BUY",
        optionType: "CE",
        strike: 24000,
        expiry: "2026-04-03",
        quantity: 75,
        price: 150,
        orderType: "LIMIT",
        productType: "INTRADAY",
      })
    ).rejects.toThrow("Token expired");

    // Verify MongoDB was updated
    const config = await getBrokerConfig(TEST_BROKER_ID);
    expect(config?.credentials.status).toBe("expired");
  });
});

// ─── Margin / Fund Limit ───────────────────────────────────────

describe("DhanAdapter.getMargin", () => {
  it("should return margin info from Dhan API", async () => {
    mockFetch((url) => {
      if (url.includes("/fundlimit")) {
        return new Response(
          JSON.stringify({
            dhanClientId: TEST_CLIENT_ID,
            availabelBalance: 98440,
            sodLimit: 113642,
            collateralAmount: 0,
            receiveableAmount: 0,
            utilizedAmount: 15202,
            blockedPayoutAmount: 0,
            withdrawableBalance: 98310,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const adapter = new DhanAdapter();
    adapter._setInternalState({
      accessToken: TEST_TOKEN,
      clientId: TEST_CLIENT_ID,
      tokenUpdatedAt: Date.now(),
    });

    const margin = await adapter.getMargin();

    expect(margin.available).toBe(98440);
    expect(margin.used).toBe(15202);
    expect(margin.total).toBe(113642);
  });
});

// ─── Connect Lifecycle ─────────────────────────────────────────

describe("DhanAdapter.connect", () => {
  it("should load credentials from MongoDB and validate token", async () => {
    await upsertBrokerConfig({
      brokerId: TEST_BROKER_ID,
      displayName: "Dhan",
      isActive: true,
      isPaperBroker: false,
      credentials: {
        accessToken: TEST_TOKEN,
        clientId: TEST_CLIENT_ID,
        updatedAt: Date.now(),
        expiresIn: DHAN_TOKEN_EXPIRY_MS,
        status: "valid",
      },
    });

    // Mock Dhan /fundlimit → 200
    mockFetch((url) => {
      if (url.includes("/fundlimit")) {
        return new Response(
          JSON.stringify({
            dhanClientId: TEST_CLIENT_ID,
            availabelBalance: 50000,
            sodLimit: 100000,
            collateralAmount: 0,
            receiveableAmount: 0,
            utilizedAmount: 50000,
            blockedPayoutAmount: 0,
            withdrawableBalance: 50000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const adapter = new DhanAdapter();
    await adapter.connect();

    const state = adapter._getInternalState();
    expect(state.accessToken).toBe(TEST_TOKEN);
    expect(state.clientId).toBe(TEST_CLIENT_ID);

    // Verify connection status updated
    const config = await getBrokerConfig(TEST_BROKER_ID);
    expect(config?.connection.apiStatus).toBe("connected");
  });

  it("should handle missing config gracefully", async () => {
    const adapter = new DhanAdapter();
    await adapter.connect(); // Should not throw

    const state = adapter._getInternalState();
    expect(state.accessToken).toBe("");
  });

  it("should handle expired token on connect", async () => {
    await upsertBrokerConfig({
      brokerId: TEST_BROKER_ID,
      displayName: "Dhan",
      isActive: true,
      isPaperBroker: false,
      credentials: {
        accessToken: "old-token",
        clientId: TEST_CLIENT_ID,
        updatedAt: Date.now() - DHAN_TOKEN_EXPIRY_MS - 1000, // expired
        expiresIn: DHAN_TOKEN_EXPIRY_MS,
        status: "valid",
      },
    });

    const adapter = new DhanAdapter();
    await adapter.connect();

    // Should have marked as expired
    const config = await getBrokerConfig(TEST_BROKER_ID);
    expect(config?.credentials.status).toBe("expired");
    expect(config?.connection.apiStatus).toBe("error");
  });
});

// ─── Disconnect ────────────────────────────────────────────────

describe("DhanAdapter.disconnect", () => {
  it("should clear internal state and update MongoDB", async () => {
    await upsertBrokerConfig({
      brokerId: TEST_BROKER_ID,
      displayName: "Dhan",
      isActive: true,
      isPaperBroker: false,
    });

    const adapter = new DhanAdapter();
    adapter._setInternalState({
      accessToken: TEST_TOKEN,
      clientId: TEST_CLIENT_ID,
      tokenUpdatedAt: Date.now(),
    });

    await adapter.disconnect();

    const state = adapter._getInternalState();
    expect(state.accessToken).toBe("");
    expect(state.clientId).toBe("");
    expect(state.tokenUpdatedAt).toBe(0);
    expect(state.killSwitchActive).toBe(false);

    const config = await getBrokerConfig(TEST_BROKER_ID);
    expect(config?.connection.apiStatus).toBe("disconnected");
  });
});

// ─── Kill Switch ───────────────────────────────────────────────

describe("DhanAdapter.killSwitch", () => {
  it("should activate kill switch via Dhan API", async () => {
    // Mock: orders → empty, positions → empty, killswitch → success
    mockFetch((url, init) => {
      if (url.includes("/orders") && init?.method === "GET") {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/positions")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/killswitch")) {
        return new Response(
          JSON.stringify({
            dhanClientId: TEST_CLIENT_ID,
            killSwitchStatus: "Kill Switch has been successfully activated",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const adapter = new DhanAdapter();
    adapter._setInternalState({
      accessToken: TEST_TOKEN,
      clientId: TEST_CLIENT_ID,
      tokenUpdatedAt: Date.now(),
    });

    const result = await adapter.killSwitch("ACTIVATE");

    expect(result.status).toBe("ACTIVATED");
    expect(adapter._getInternalState().killSwitchActive).toBe(true);
  });

  it("should deactivate kill switch via Dhan API", async () => {
    mockFetch((url) => {
      if (url.includes("/killswitch")) {
        return new Response(
          JSON.stringify({
            dhanClientId: TEST_CLIENT_ID,
            killSwitchStatus: "Kill Switch has been successfully deactivated",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const adapter = new DhanAdapter();
    adapter._setInternalState({
      accessToken: TEST_TOKEN,
      clientId: TEST_CLIENT_ID,
      tokenUpdatedAt: Date.now(),
      killSwitchActive: true,
    });

    const result = await adapter.killSwitch("DEACTIVATE");

    expect(result.status).toBe("DEACTIVATED");
    expect(adapter._getInternalState().killSwitchActive).toBe(false);
  });
});
