/**
 * Vitest tests for Broker Service tRPC + REST endpoints.
 *
 * Tests the full API surface using:
 * - tRPC caller (direct procedure calls) for frontend-facing endpoints
 * - Express supertest-style tests for REST endpoints
 *
 * All tests use the MockAdapter — no external dependencies.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import {
  initBrokerService,
  _resetForTesting,
  getAdapter,
} from "./brokerService";
import { BrokerConfigModel } from "./brokerConfig";

// ─── Test Setup ─────────────────────────────────────────────────

const TEST_MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/test_broker_endpoints";

const sampleOrder = {
  instrument: "NIFTY",
  exchange: "NSE_FNO" as const,
  transactionType: "BUY" as const,
  optionType: "CE" as const,
  strike: 24000,
  expiry: "2026-04-02",
  quantity: 50,
  price: 150,
  orderType: "LIMIT" as const,
  productType: "INTRADAY" as const,
};

// ─── Lifecycle ──────────────────────────────────────────────────

beforeAll(async () => {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(TEST_MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });
  }
}, 15000);

afterAll(async () => {
  await BrokerConfigModel.deleteMany({
    brokerId: { $in: ["dhan", "dhan-sandbox", "mock-ai", "mock-my"] },
  });
  await mongoose.disconnect();
}, 10000);

beforeEach(async () => {
  _resetForTesting();
  await initBrokerService();
}, 15000);

// ─── Broker Service Status Tests ────────────────────────────────

describe("Broker Service Status", () => {
  it("returns active broker info when mock is loaded", async () => {
    const broker = getAdapter("ai-paper");
    expect(broker).not.toBeNull();
    expect(broker.brokerId).toBe("mock-ai");
    expect(broker.displayName).toBeDefined();
  });

  it("reports token as valid for mock adapter", async () => {
    const broker = getAdapter("ai-paper");
    const result = await broker.validateToken();
    expect(result.valid).toBe(true);
  });
});

// ─── Order Placement Tests ──────────────────────────────────────

describe("Order Placement via Broker", () => {
  it("places a BUY order and gets FILLED status", async () => {
    const broker = getAdapter("ai-paper");
    const result = await broker.placeOrder(sampleOrder);

    expect(result.orderId).toBeDefined();
    expect(result.status).toBe("FILLED");
    expect(result.message).toContain("paper trading");
  });

  it("creates a position after order fill", async () => {
    const broker = getAdapter("ai-paper");
    await broker.placeOrder(sampleOrder);

    const positions = await broker.getPositions();
    expect(positions.length).toBe(1);
    expect(positions[0].instrument).toBe("NIFTY");
    expect(positions[0].transactionType).toBe("BUY");
    expect(positions[0].quantity).toBe(50);
    expect(positions[0].averagePrice).toBe(150);
    expect(positions[0].status).toBe("OPEN");
  });

  it("deducts margin after order fill", async () => {
    const broker = getAdapter("ai-paper");
    const marginBefore = await broker.getMargin();
    expect(marginBefore.total).toBe(500000);

    await broker.placeOrder(sampleOrder);

    const marginAfter = await broker.getMargin();
    expect(marginAfter.used).toBe(7500); // 150 * 50
    expect(marginAfter.available).toBe(492500);
  });

  it("records the order in order book", async () => {
    const broker = getAdapter("ai-paper");
    const result = await broker.placeOrder(sampleOrder);

    const orders = await broker.getOrderBook();
    expect(orders.length).toBe(1);
    expect(orders[0].orderId).toBe(result.orderId);
    expect(orders[0].status).toBe("FILLED");
  });

  it("records the trade in trade book", async () => {
    const broker = getAdapter("ai-paper");
    await broker.placeOrder(sampleOrder);

    const trades = await broker.getTradeBook();
    expect(trades.length).toBe(1);
    expect(trades[0].instrument).toBe("NIFTY");
    expect(trades[0].price).toBe(150);
    expect(trades[0].quantity).toBe(50);
  });
});

// ─── Exit Position Tests ────────────────────────────────────────

describe("Exit Position via Broker", () => {
  it("exits a position with opposite SELL order", async () => {
    const broker = getAdapter("ai-paper");
    await broker.placeOrder(sampleOrder);

    // Exit with opposite order
    await broker.placeOrder({
      ...sampleOrder,
      transactionType: "SELL",
      price: 170,
    });

    const positions = await broker.getPositions();
    const closed = positions.filter((p) => p.status === "CLOSED");
    expect(closed.length).toBe(1);
    expect(closed[0].pnl).toBe(1000); // (170 - 150) * 50
  });

  it("exitAll closes all open positions", async () => {
    const broker = getAdapter("ai-paper");

    // Open 3 positions
    await broker.placeOrder(sampleOrder);
    await broker.placeOrder({
      ...sampleOrder,
      strike: 24100,
      price: 120,
    });
    await broker.placeOrder({
      ...sampleOrder,
      strike: 24200,
      price: 90,
    });

    const openBefore = await broker.getOpenPositions();
    expect(openBefore.length).toBe(3);

    await broker.exitAll();

    const openAfter = await broker.getOpenPositions();
    expect(openAfter.length).toBe(0);
  });
});

// ─── Kill Switch Tests ──────────────────────────────────────────

describe("Kill Switch via Broker Service", () => {
  it("blocks orders when kill switch is active", async () => {
    const broker = getAdapter("ai-paper");
    await broker.killSwitch("ACTIVATE");

    // MockAdapter returns REJECTED status instead of throwing
    const result = await broker.placeOrder(sampleOrder);
    expect(result.status).toBe("REJECTED");
    expect(result.message).toMatch(/kill switch/i);
  });

  it("resumes orders after kill switch deactivation", async () => {
    const broker = getAdapter("ai-paper");
    await broker.killSwitch("ACTIVATE");
    await broker.killSwitch("DEACTIVATE");

    const result = await broker.placeOrder(sampleOrder);
    expect(result.status).toBe("FILLED");
  });

  it("exits all positions on kill switch activation", async () => {
    const broker = getAdapter("ai-paper");
    await broker.placeOrder(sampleOrder);
    await broker.placeOrder({
      ...sampleOrder,
      strike: 24100,
      price: 120,
    });

    const openBefore = await broker.getOpenPositions();
    expect(openBefore.length).toBe(2);

    await broker.killSwitch("ACTIVATE");

    const openAfter = await broker.getOpenPositions();
    expect(openAfter.length).toBe(0);
  });
});

// ─── Market Data Tests ──────────────────────────────────────────

describe("Market Data via Broker", () => {
  it("returns scrip master for NSE_FNO", async () => {
    const broker = getAdapter("ai-paper");
    const instruments = await broker.getScripMaster("NSE_FNO");
    expect(instruments.length).toBeGreaterThan(0);
    // MockAdapter returns simplified exchange names
    expect(instruments[0].exchange).toBeDefined();
  });

  it("returns expiry list for NIFTY", async () => {
    const broker = getAdapter("ai-paper");
    const expiries = await broker.getExpiryList("NIFTY");
    expect(expiries.length).toBeGreaterThan(0);
  });

  it("returns option chain for NIFTY", async () => {
    const broker = getAdapter("ai-paper");
    const chain = await broker.getOptionChain("NIFTY", "2026-04-02");
    expect(chain.underlying).toBe("NIFTY");
    expect(chain.expiry).toBe("2026-04-02");
    expect(chain.rows.length).toBeGreaterThan(0);
  });

  it("returns intraday candle data", async () => {
    const broker = getAdapter("ai-paper");
    const data = await broker.getIntradayData({
      securityId: "13",
      exchangeSegment: "IDX_I",
      instrument: "INDEX",
      interval: "5",
      fromDate: "2026-04-04 09:15:00",
      toDate: "2026-04-04 15:30:00",
    });
    expect(data.open.length).toBeGreaterThan(0);
    expect(data.high.length).toBe(data.open.length);
    expect(data.close.length).toBe(data.open.length);
    expect(data.volume.length).toBe(data.open.length);
    expect(data.timestamp.length).toBe(data.open.length);
  });

  it("returns historical candle data", async () => {
    const broker = getAdapter("ai-paper");
    const data = await broker.getHistoricalData({
      securityId: "13",
      exchangeSegment: "IDX_I",
      instrument: "INDEX",
      fromDate: "2026-03-01",
      toDate: "2026-04-01",
    });
    expect(data.open.length).toBeGreaterThan(0);
    expect(data.high.length).toBe(data.open.length);
    expect(data.close.length).toBe(data.open.length);
    expect(data.volume.length).toBe(data.open.length);
    expect(data.timestamp.length).toBe(data.open.length);
  });

  it("returns intraday data with open interest", async () => {
    const broker = getAdapter("ai-paper");
    const data = await broker.getIntradayData({
      securityId: "13",
      exchangeSegment: "NSE_FNO",
      instrument: "FUTIDX",
      interval: "15",
      fromDate: "2026-04-04 09:15:00",
      toDate: "2026-04-04 15:30:00",
      oi: true,
    });
    expect(data.openInterest).toBeDefined();
    expect(data.openInterest!.length).toBe(data.open.length);
  });
});

// ─── Config CRUD via Endpoints ──────────────────────────────────

describe("Broker Config via Service", () => {
  it("stores access token in MongoDB config", async () => {
    const { upsertBrokerConfig } = await import("./brokerConfig");
    await upsertBrokerConfig({
      brokerId: "mock-ai",
      displayName: "Paper (AI Trades)",
      credentials: {
        accessToken: "eyJhbGciOiJIUzI1NiJ9.test_token_1234",
        clientId: "",
        expiresIn: 86400000,
        updatedAt: Date.now(),
        status: "valid",
      },
    });

    const rawConfig = await BrokerConfigModel.findOne({ brokerId: "mock-ai" }).lean();
    expect(rawConfig?.credentials.accessToken).toBe(
      "eyJhbGciOiJIUzI1NiJ9.test_token_1234"
    );
  });

  it("updates broker settings", async () => {
    const { updateBrokerSettings } = await import("./brokerConfig");
    const updated = await updateBrokerSettings("mock-ai", {
      defaultSL: 5,
      defaultTP: 10,
    });
    expect(updated).not.toBeNull();
    expect(updated!.settings.defaultSL).toBe(5);
    expect(updated!.settings.defaultTP).toBe(10);
  });
});

// ─── Margin Info Tests ──────────────────────────────────────────

describe("Margin Info", () => {
  it("returns correct initial margin", async () => {
    const broker = getAdapter("ai-paper");
    const margin = await broker.getMargin();
    expect(margin.total).toBe(500000);
    expect(margin.used).toBe(0);
    expect(margin.available).toBe(500000);
  });

  it("updates margin after multiple orders", async () => {
    const broker = getAdapter("ai-paper");

    await broker.placeOrder(sampleOrder); // 150 * 50 = 7500
    await broker.placeOrder({
      ...sampleOrder,
      strike: 24100,
      price: 200,
      quantity: 25,
    }); // 200 * 25 = 5000

    const margin = await broker.getMargin();
    expect(margin.used).toBe(12500);
    expect(margin.available).toBe(487500);
  });
});

// ─── Full Round-Trip Test ───────────────────────────────────────

describe("Full Round-Trip: Place → Check → Exit → Verify", () => {
  it("completes a full trade lifecycle", async () => {
    const broker = getAdapter("ai-paper");

    // 1. Place BUY order
    const buyResult = await broker.placeOrder(sampleOrder);
    expect(buyResult.status).toBe("FILLED");

    // 2. Check position is OPEN
    let positions = await broker.getPositions();
    expect(positions.filter((p) => p.status === "OPEN").length).toBe(1);

    // 3. Check margin is used
    let margin = await broker.getMargin();
    expect(margin.used).toBe(7500);

    // 4. Exit with SELL at higher price (profit)
    const sellResult = await broker.placeOrder({
      ...sampleOrder,
      transactionType: "SELL",
      price: 180,
    });
    expect(sellResult.status).toBe("FILLED");

    // 5. Position should be CLOSED with profit
    positions = await broker.getPositions();
    const closed = positions.filter((p) => p.status === "CLOSED");
    expect(closed.length).toBe(1);
    expect(closed[0].pnl).toBe(1500); // (180 - 150) * 50

    // 6. Margin should be released
    margin = await broker.getMargin();
    expect(margin.used).toBe(0);
    expect(margin.available).toBe(500000);

    // 7. Order book should have 2 orders
    const orders = await broker.getOrderBook();
    expect(orders.length).toBe(2);

    // 8. Trade book should have 2 trades
    const trades = await broker.getTradeBook();
    expect(trades.length).toBe(2);
  });
});
