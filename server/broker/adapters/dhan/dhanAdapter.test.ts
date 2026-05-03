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

// ─── Modify Order ──────────────────────────────────────────────

describe("DhanAdapter.modifyOrder", () => {
  it("should modify an order and map TRANSIT → PENDING", async () => {
    mockFetch((url, init) => {
      if (url.includes("/orders/ORD-99001") && init?.method === "PUT") {
        return new Response(
          JSON.stringify({ orderId: "ORD-99001", orderStatus: "TRANSIT" }),
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

    const result = await adapter.modifyOrder("ORD-99001", { price: 160, quantity: 75 });

    expect(result.orderId).toBe("ORD-99001");
    expect(result.status).toBe("PENDING");
    expect(result.message).toContain("ORD-99001");
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it("should throw when no token is set", async () => {
    const adapter = new DhanAdapter();
    adapter._setInternalState({ accessToken: "" });

    await expect(adapter.modifyOrder("ORD-99001", { price: 160 })).rejects.toThrow(
      "No Dhan access token configured"
    );
  });

  it("should throw on 401 during modify", async () => {
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

    mockFetch(() =>
      new Response(
        JSON.stringify({ errorType: "DH-901", errorCode: "401", errorMessage: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      )
    );

    const adapter = new DhanAdapter();
    adapter._setInternalState({
      accessToken: TEST_TOKEN,
      clientId: TEST_CLIENT_ID,
      tokenUpdatedAt: Date.now(),
    });

    await expect(adapter.modifyOrder("ORD-99001", { price: 160 })).rejects.toThrow(
      "Token expired"
    );

    const config = await getBrokerConfig(TEST_BROKER_ID);
    expect(config?.credentials.status).toBe("expired");
  });
});

// ─── Cancel Order ─────────────────────────────────────────────

describe("DhanAdapter.cancelOrder", () => {
  it("should cancel an order successfully", async () => {
    mockFetch((url, init) => {
      if (url.includes("/orders/ORD-99002") && init?.method === "DELETE") {
        return new Response(
          JSON.stringify({ orderId: "ORD-99002", orderStatus: "CANCELLED" }),
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

    const result = await adapter.cancelOrder("ORD-99002");

    expect(result.orderId).toBe("ORD-99002");
    expect(result.status).toBe("CANCELLED");
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it("should throw when no token is set", async () => {
    const adapter = new DhanAdapter();
    adapter._setInternalState({ accessToken: "" });

    await expect(adapter.cancelOrder("ORD-99002")).rejects.toThrow(
      "No Dhan access token configured"
    );
  });
});

// ─── Order Book ───────────────────────────────────────────────

describe("DhanAdapter.getOrderBook", () => {
  it("should return mapped orders with correct status translations", async () => {
    mockFetch((url, init) => {
      if (url.endsWith("/orders") && init?.method === "GET") {
        return new Response(
          JSON.stringify([
            {
              dhanClientId: TEST_CLIENT_ID,
              orderId: "ORD-A001",
              orderStatus: "TRADED",
              transactionType: "BUY",
              exchangeSegment: "NSE_FNO",
              productType: "INTRADAY",
              orderType: "LIMIT",
              validity: "DAY",
              tradingSymbol: "NIFTY26APR24000CE",
              securityId: "52175",
              quantity: 75,
              filledQty: 75,
              price: 150,
              averageTradedPrice: 150,
            },
            {
              dhanClientId: TEST_CLIENT_ID,
              orderId: "ORD-A002",
              orderStatus: "PENDING",
              transactionType: "SELL",
              exchangeSegment: "NSE_FNO",
              productType: "INTRADAY",
              orderType: "LIMIT",
              validity: "DAY",
              tradingSymbol: "NIFTY26APR24500PE",
              securityId: "52176",
              quantity: 50,
              filledQty: 0,
              price: 90,
              averageTradedPrice: 0,
            },
          ]),
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

    const orders = await adapter.getOrderBook();

    expect(orders.length).toBe(2);
    expect(orders[0].orderId).toBe("ORD-A001");
    expect(orders[0].status).toBe("FILLED");   // TRADED → FILLED
    expect(orders[0].transactionType).toBe("BUY");
    expect(orders[0].quantity).toBe(75);
    expect(orders[1].orderId).toBe("ORD-A002");
    expect(orders[1].status).toBe("PENDING");
  });

  it("should return empty array on API error", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ error: "server error" }), { status: 500 })
    );

    const adapter = new DhanAdapter();
    adapter._setInternalState({
      accessToken: TEST_TOKEN,
      clientId: TEST_CLIENT_ID,
      tokenUpdatedAt: Date.now(),
    });

    const orders = await adapter.getOrderBook();
    expect(orders).toEqual([]);
  });

  it("should throw when no token is set", async () => {
    const adapter = new DhanAdapter();
    adapter._setInternalState({ accessToken: "" });

    await expect(adapter.getOrderBook()).rejects.toThrow(
      "No Dhan access token configured"
    );
  });
});

// ─── Order Status ─────────────────────────────────────────────

describe("DhanAdapter.getOrderStatus", () => {
  it("should return a single order mapped correctly", async () => {
    mockFetch((url, init) => {
      if (url.includes("/orders/ORD-A003") && init?.method === "GET") {
        return new Response(
          JSON.stringify({
            dhanClientId: TEST_CLIENT_ID,
            orderId: "ORD-A003",
            orderStatus: "CANCELLED",
            transactionType: "BUY",
            exchangeSegment: "NSE_FNO",
            productType: "INTRADAY",
            orderType: "LIMIT",
            validity: "DAY",
            tradingSymbol: "NIFTY26APR24000CE",
            securityId: "52175",
            quantity: 75,
            filledQty: 0,
            price: 150,
            averageTradedPrice: 0,
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

    const order = await adapter.getOrderStatus("ORD-A003");

    expect(order.orderId).toBe("ORD-A003");
    expect(order.status).toBe("CANCELLED");
    expect(order.transactionType).toBe("BUY");
    expect(order.quantity).toBe(75);
  });

  it("should throw when order not found", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ errorMessage: "Order not found" }), { status: 404 })
    );

    const adapter = new DhanAdapter();
    adapter._setInternalState({
      accessToken: TEST_TOKEN,
      clientId: TEST_CLIENT_ID,
      tokenUpdatedAt: Date.now(),
    });

    await expect(adapter.getOrderStatus("ORD-MISSING")).rejects.toThrow("ORD-MISSING");
  });
});

// ─── Trade Book ───────────────────────────────────────────────

describe("DhanAdapter.getTradeBook", () => {
  it("should return mapped trades with correct fields", async () => {
    mockFetch((url, init) => {
      if (url.includes("/trades") && init?.method === "GET") {
        return new Response(
          JSON.stringify([
            {
              dhanClientId: TEST_CLIENT_ID,
              orderId: "ORD-T001",
              exchangeOrderId: "EX-001",
              transactionType: "BUY",
              exchangeSegment: "NSE_FNO",
              productType: "INTRADAY",
              orderType: "LIMIT",
              tradingSymbol: "NIFTY26APR24000CE",
              securityId: "52175",
              tradedQuantity: 75,
              tradedPrice: 152.50,
              createTime: "2026-04-11 10:15:00",
            },
          ]),
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

    const trades = await adapter.getTradeBook();

    expect(trades.length).toBe(1);
    expect(trades[0].orderId).toBe("ORD-T001");
    expect(trades[0].instrument).toBe("NIFTY26APR24000CE");
    expect(trades[0].transactionType).toBe("BUY");
    expect(trades[0].quantity).toBe(75);
    expect(trades[0].price).toBe(152.50);
    expect(trades[0].timestamp).toBeGreaterThan(0);
  });

  it("should return empty array on API error", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ error: "server error" }), { status: 500 })
    );

    const adapter = new DhanAdapter();
    adapter._setInternalState({
      accessToken: TEST_TOKEN,
      clientId: TEST_CLIENT_ID,
      tokenUpdatedAt: Date.now(),
    });

    const trades = await adapter.getTradeBook();
    expect(trades).toEqual([]);
  });
});

// ─── Positions ────────────────────────────────────────────────

describe("DhanAdapter.getPositions", () => {
  it("should return OPEN position for positive netQty", async () => {
    mockFetch((url, init) => {
      if (url.includes("/positions") && init?.method === "GET") {
        return new Response(
          JSON.stringify([
            {
              dhanClientId: TEST_CLIENT_ID,
              tradingSymbol: "NIFTY26APR24000CE",
              securityId: "52175",
              exchangeSegment: "NSE_FNO",
              productType: "INTRADAY",
              buyAvg: 152.50,
              buyQty: 75,
              sellAvg: 0,
              sellQty: 0,
              netQty: 75,
              realizedProfit: 0,
              unrealizedProfit: 1875,
            },
          ]),
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

    const positions = await adapter.getPositions();

    expect(positions.length).toBe(1);
    expect(positions[0].instrument).toBe("NIFTY26APR24000CE");
    expect(positions[0].quantity).toBe(75);
    expect(positions[0].averagePrice).toBe(152.50);
    expect(positions[0].status).toBe("OPEN");
    expect(positions[0].transactionType).toBe("BUY");
    expect(positions[0].pnl).toBe(1875);
  });

  it("should return CLOSED position for zero netQty", async () => {
    mockFetch((url, init) => {
      if (url.includes("/positions") && init?.method === "GET") {
        return new Response(
          JSON.stringify([
            {
              dhanClientId: TEST_CLIENT_ID,
              tradingSymbol: "NIFTY26APR24000PE",
              securityId: "52176",
              exchangeSegment: "NSE_FNO",
              productType: "INTRADAY",
              buyAvg: 90,
              buyQty: 50,
              sellAvg: 100,
              sellQty: 50,
              netQty: 0,
              realizedProfit: 500,
              unrealizedProfit: 0,
            },
          ]),
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

    const positions = await adapter.getPositions();

    expect(positions.length).toBe(1);
    expect(positions[0].status).toBe("CLOSED");
    expect(positions[0].pnl).toBe(500);
  });

  it("should map SELL transactionType for negative netQty", async () => {
    mockFetch((url, init) => {
      if (url.includes("/positions") && init?.method === "GET") {
        return new Response(
          JSON.stringify([
            {
              dhanClientId: TEST_CLIENT_ID,
              tradingSymbol: "NIFTY26APR24000CE",
              securityId: "52175",
              exchangeSegment: "NSE_FNO",
              productType: "INTRADAY",
              buyAvg: 0,
              buyQty: 0,
              sellAvg: 155,
              sellQty: 75,
              netQty: -75,
              realizedProfit: 0,
              unrealizedProfit: -375,
            },
          ]),
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

    const positions = await adapter.getPositions();

    expect(positions[0].transactionType).toBe("SELL");
    expect(positions[0].averagePrice).toBe(155); // sellAvg for negative netQty
    expect(positions[0].status).toBe("OPEN");
  });

  it("should return empty array on API error", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ error: "server error" }), { status: 500 })
    );

    const adapter = new DhanAdapter();
    adapter._setInternalState({
      accessToken: TEST_TOKEN,
      clientId: TEST_CLIENT_ID,
      tokenUpdatedAt: Date.now(),
    });

    const positions = await adapter.getPositions();
    expect(positions).toEqual([]);
  });
});

// ─── Exit All ─────────────────────────────────────────────────

describe("DhanAdapter.exitAll", () => {
  it("should cancel pending orders and close open positions", async () => {
    let postOrderCallCount = 0;

    mockFetch((url, init) => {
      // GET /orders — order book with one PENDING order
      if (url.endsWith("/orders") && init?.method === "GET") {
        return new Response(
          JSON.stringify([
            {
              dhanClientId: TEST_CLIENT_ID,
              orderId: "ORD-PEND",
              orderStatus: "PENDING",
              transactionType: "BUY",
              exchangeSegment: "NSE_FNO",
              productType: "INTRADAY",
              orderType: "LIMIT",
              validity: "DAY",
              tradingSymbol: "NIFTY26APR24000CE",
              securityId: "52175",
              quantity: 75,
              filledQty: 0,
              price: 150,
              averageTradedPrice: 0,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // DELETE /orders/ORD-PEND — cancel
      if (url.includes("/orders/ORD-PEND") && init?.method === "DELETE") {
        return new Response(
          JSON.stringify({ orderId: "ORD-PEND", orderStatus: "CANCELLED" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // GET /positions — one open position
      if (url.includes("/positions") && init?.method === "GET") {
        return new Response(
          JSON.stringify([
            {
              dhanClientId: TEST_CLIENT_ID,
              tradingSymbol: "NIFTY26APR24000CE",
              securityId: "52175",
              exchangeSegment: "NSE_FNO",
              productType: "INTRADAY",
              buyAvg: 150,
              buyQty: 75,
              sellAvg: 0,
              sellQty: 0,
              netQty: 75,
              realizedProfit: 0,
              unrealizedProfit: 375,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // POST /orders — exit market order
      if (url.endsWith("/orders") && init?.method === "POST") {
        postOrderCallCount++;
        return new Response(
          JSON.stringify({ orderId: "ORD-EXIT-01", orderStatus: "TRANSIT" }),
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

    const results = await adapter.exitAll();

    // Should have cancelled 1 order + exited 1 position = 2 results
    expect(results.length).toBe(2);
    expect(results[0].orderId).toBe("ORD-PEND");
    expect(results[0].status).toBe("CANCELLED");
    expect(results[1].orderId).toBe("ORD-EXIT-01");
    expect(postOrderCallCount).toBe(1);
  });

  it("should return empty array when no orders or positions", async () => {
    mockFetch((url, init) => {
      if (url.endsWith("/orders") && init?.method === "GET") {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/positions") && init?.method === "GET") {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const adapter = new DhanAdapter();
    adapter._setInternalState({
      accessToken: TEST_TOKEN,
      clientId: TEST_CLIENT_ID,
      tokenUpdatedAt: Date.now(),
    });

    const results = await adapter.exitAll();
    expect(results).toEqual([]);
  });
});

// ─── Expiry List ──────────────────────────────────────────────

describe("DhanAdapter.getExpiryList", () => {
  it("should return array of expiry date strings", async () => {
    mockFetch((url, init) => {
      if (url.includes("/optionchain/expirylist") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ data: ["2026-04-03", "2026-04-10", "2026-04-17", "2026-04-24"] }),
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

    const expiries = await adapter.getExpiryList("13", "IDX_I");

    expect(Array.isArray(expiries)).toBe(true);
    expect(expiries.length).toBe(4);
    expect(expiries[0]).toBe("2026-04-03");
    expiries.forEach((d) => expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/));
  });

  it("should default to IDX_I when exchangeSegment is omitted", async () => {
    let capturedBody: Record<string, unknown> = {};

    mockFetch((url, init) => {
      if (url.includes("/optionchain/expirylist") && init?.method === "POST") {
        capturedBody = JSON.parse(init!.body as string);
        return new Response(
          JSON.stringify({ data: ["2026-04-03"] }),
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

    await adapter.getExpiryList("13");
    expect(capturedBody["UnderlyingSeg"]).toBe("IDX_I");
  });

  it("should return empty array on API error", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ error: "bad request" }), { status: 400 })
    );

    const adapter = new DhanAdapter();
    adapter._setInternalState({
      accessToken: TEST_TOKEN,
      clientId: TEST_CLIENT_ID,
      tokenUpdatedAt: Date.now(),
    });

    const expiries = await adapter.getExpiryList("13", "IDX_I");
    expect(expiries).toEqual([]);
  });

  it("should throw when no token is set", async () => {
    const adapter = new DhanAdapter();
    adapter._setInternalState({ accessToken: "" });

    await expect(adapter.getExpiryList("13")).rejects.toThrow(
      "No Dhan access token configured"
    );
  });
});

// ─── Option Chain ─────────────────────────────────────────────

describe("DhanAdapter.getOptionChain", () => {
  it("should return option chain with parsed rows", async () => {
    mockFetch((url, init) => {
      if (url.includes("/optionchain") && !url.includes("/expirylist") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            data: {
              last_price: 24150.5,
              oc: {
                "24000": {
                  ce: {
                    oi: 5000,
                    previous_oi: 4500,
                    last_price: 245.5,
                    volume: 1200,
                    implied_volatility: 18.5,
                    security_id: 52175,
                  },
                  pe: {
                    oi: 3000,
                    previous_oi: 2800,
                    last_price: 95.25,
                    volume: 800,
                    implied_volatility: 17.2,
                    security_id: 52176,
                  },
                },
                "24500": {
                  ce: {
                    oi: 8000,
                    previous_oi: 7000,
                    last_price: 60.0,
                    volume: 2500,
                    implied_volatility: 19.1,
                    security_id: 52177,
                  },
                  pe: {
                    oi: 12000,
                    previous_oi: 11000,
                    last_price: 385.0,
                    volume: 3000,
                    implied_volatility: 22.4,
                    security_id: 52178,
                  },
                },
              },
            },
            status: "success",
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

    const chain = await adapter.getOptionChain("13", "2026-04-03", "IDX_I");

    expect(chain.underlying).toBe("13");
    expect(chain.expiry).toBe("2026-04-03");
    expect(chain.spotPrice).toBe(24150.5);
    expect(chain.timestamp).toBeGreaterThan(0);
    expect(chain.rows.length).toBe(2);

    // Rows should be sorted by strike ascending
    expect(chain.rows[0].strike).toBe(24000);
    expect(chain.rows[1].strike).toBe(24500);

    // Verify row fields for first strike
    const row = chain.rows[0];
    expect(row.callOI).toBe(5000);
    expect(row.callOIChange).toBe(500); // 5000 - 4500
    expect(row.callLTP).toBe(245.5);
    expect(row.callVolume).toBe(1200);
    expect(row.callIV).toBe(18.5);
    expect(row.putOI).toBe(3000);
    expect(row.putLTP).toBe(95.25);
    expect(row.putIV).toBe(17.2);
  });

  it("should include callSecurityId and putSecurityId", async () => {
    mockFetch((url, init) => {
      if (url.includes("/optionchain") && !url.includes("/expirylist") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            data: {
              last_price: 24000,
              oc: {
                "24000": {
                  ce: { oi: 1, previous_oi: 0, last_price: 100, volume: 10, implied_volatility: 15, security_id: 52175 },
                  pe: { oi: 2, previous_oi: 0, last_price: 80, volume: 5, implied_volatility: 14, security_id: 52176 },
                },
              },
            },
            status: "success",
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

    const chain = await adapter.getOptionChain("13", "2026-04-03");
    expect(chain.rows[0].callSecurityId).toBe("52175");
    expect(chain.rows[0].putSecurityId).toBe("52176");
  });

  it("should throw on API error response", async () => {
    mockFetch((url, init) => {
      if (url.includes("/optionchain") && !url.includes("/expirylist") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ errorType: "DH-905", errorMessage: "Invalid underlying" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
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

    await expect(adapter.getOptionChain("9999", "2026-04-03")).rejects.toThrow(
      "Failed to fetch option chain"
    );
  });
});

// ─── Intraday Data ────────────────────────────────────────────

describe("DhanAdapter.getIntradayData", () => {
  it("should return OHLCV candle arrays", async () => {
    const mockOpen = [24100, 24150, 24200];
    const mockHigh = [24200, 24250, 24300];
    const mockLow = [24050, 24100, 24150];
    const mockClose = [24150, 24180, 24250];
    const mockVolume = [10000, 12000, 8000];
    const mockTimestamp = [1744170900, 1744171200, 1744171500];

    mockFetch((url, init) => {
      if (url.includes("/charts/intraday") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            open: mockOpen,
            high: mockHigh,
            low: mockLow,
            close: mockClose,
            volume: mockVolume,
            timestamp: mockTimestamp,
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

    const data = await adapter.getIntradayData({
      securityId: "13",
      exchangeSegment: "IDX_I",
      instrument: "INDEX",
      interval: "5",
      fromDate: "2026-04-11 09:15:00",
      toDate: "2026-04-11 15:30:00",
    });

    expect(data.open).toEqual(mockOpen);
    expect(data.high).toEqual(mockHigh);
    expect(data.low).toEqual(mockLow);
    expect(data.close).toEqual(mockClose);
    expect(data.volume).toEqual(mockVolume);
    expect(data.timestamp).toEqual(mockTimestamp);
    expect(data.openInterest).toBeUndefined();
  });

  it("should include openInterest when oi=true is requested", async () => {
    const mockOI = [150000, 155000, 160000];

    mockFetch((url, init) => {
      if (url.includes("/charts/intraday") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            open: [24100],
            high: [24200],
            low: [24050],
            close: [24150],
            volume: [10000],
            timestamp: [1744170900],
            open_interest: mockOI,
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

    const data = await adapter.getIntradayData({
      securityId: "52175",
      exchangeSegment: "NSE_FNO",
      instrument: "OPTIDX",
      interval: "15",
      fromDate: "2026-04-11 09:15:00",
      toDate: "2026-04-11 15:30:00",
      oi: true,
    });

    expect(data.openInterest).toEqual(mockOI);
  });

  it("should throw when no token is set", async () => {
    const adapter = new DhanAdapter();
    adapter._setInternalState({ accessToken: "" });

    await expect(
      adapter.getIntradayData({
        securityId: "13",
        exchangeSegment: "IDX_I",
        instrument: "INDEX",
        interval: "5",
        fromDate: "2026-04-11 09:15:00",
        toDate: "2026-04-11 15:30:00",
      })
    ).rejects.toThrow("No Dhan access token configured");
  });
});

// ─── Historical Data ──────────────────────────────────────────

describe("DhanAdapter.getHistoricalData", () => {
  it("should return OHLCV candle arrays for a date range", async () => {
    const mockOpen = [23500, 23600, 23700, 23800, 23900];
    const mockHigh = [23700, 23800, 23900, 24000, 24100];
    const mockLow = [23400, 23500, 23600, 23700, 23800];
    const mockClose = [23650, 23750, 23850, 23950, 24050];
    const mockVolume = [500000, 520000, 480000, 510000, 490000];
    const mockTimestamp = [1743379200, 1743465600, 1743552000, 1743638400, 1743724800];

    mockFetch((url, init) => {
      if (url.includes("/charts/historical") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            open: mockOpen,
            high: mockHigh,
            low: mockLow,
            close: mockClose,
            volume: mockVolume,
            timestamp: mockTimestamp,
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

    const data = await adapter.getHistoricalData({
      securityId: "13",
      exchangeSegment: "IDX_I",
      instrument: "INDEX",
      fromDate: "2026-03-30",
      toDate: "2026-04-04",
    });

    expect(data.open).toEqual(mockOpen);
    expect(data.high).toEqual(mockHigh);
    expect(data.low).toEqual(mockLow);
    expect(data.close).toEqual(mockClose);
    expect(data.volume).toEqual(mockVolume);
    expect(data.timestamp).toEqual(mockTimestamp);
    expect(data.open.length).toBe(5);
  });

  it("should include openInterest when oi=true", async () => {
    const mockOI = [200000, 210000, 220000];

    mockFetch((url, init) => {
      if (url.includes("/charts/historical") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            open: [24000, 24100, 24200],
            high: [24200, 24300, 24400],
            low: [23900, 24000, 24100],
            close: [24100, 24200, 24300],
            volume: [100000, 110000, 120000],
            timestamp: [1743379200, 1743465600, 1743552000],
            open_interest: mockOI,
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

    const data = await adapter.getHistoricalData({
      securityId: "52175",
      exchangeSegment: "NSE_FNO",
      instrument: "OPTIDX",
      fromDate: "2026-03-30",
      toDate: "2026-04-04",
      oi: true,
    });

    expect(data.openInterest).toEqual(mockOI);
  });

  it("should throw when no token is set", async () => {
    const adapter = new DhanAdapter();
    adapter._setInternalState({ accessToken: "" });

    await expect(
      adapter.getHistoricalData({
        securityId: "13",
        exchangeSegment: "IDX_I",
        instrument: "INDEX",
        fromDate: "2026-03-30",
        toDate: "2026-04-04",
      })
    ).rejects.toThrow("No Dhan access token configured");
  });
});
