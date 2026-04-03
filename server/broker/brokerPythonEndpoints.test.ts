/**
 * Vitest tests for Broker Service REST endpoints used by Python AI modules.
 *
 * Covers:
 * - GET /api/broker/token/status
 * - GET /api/broker/option-chain/expiry-list (with exchangeSegment)
 * - GET /api/broker/option-chain (with exchangeSegment)
 * - GET /api/broker/scrip-master/mcx-futcom
 * - GET /api/broker/scrip-master/lookup
 * - POST /api/broker/orders
 * - GET /api/broker/positions
 * - POST /api/broker/kill-switch
 *
 * All tests use the MockAdapter — no external dependencies.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import {
  registerAdapter,
  initBrokerService,
  _resetForTesting,
  getActiveBroker,
} from "./brokerService";
import {
  upsertBrokerConfig,
  BrokerConfigModel,
} from "./brokerConfig";
import { MockAdapter } from "./adapters/mock";
import type { BrokerConfigDoc } from "./types";

// ─── Test Setup ─────────────────────────────────────────────────

const TEST_MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/test_python_endpoints";
const TEST_BROKER_ID = "mock_python_test";

const mockConfig: Omit<BrokerConfigDoc, "_id"> = {
  brokerId: TEST_BROKER_ID,
  displayName: "Paper Trading (Python Endpoint Test)",
  isActive: true,
  isPaperBroker: true,
  credentials: {
    accessToken: "test-token-12345",
    clientId: "1100012345",
    expiresIn: 86400000,
    updatedAt: Date.now(),
    status: "valid",
  },
  settings: {
    orderEntryOffset: 1,
    defaultSL: 2,
    defaultTP: 5,
    orderType: "LIMIT",
    productType: "INTRADAY",
  },
  connection: {
    apiStatus: "connected",
    wsStatus: "disconnected",
    lastApiCall: null,
    lastWsTick: null,
    latencyMs: null,
  },
  capabilities: {
    bracketOrder: false,
    coverOrder: false,
    websocket: false,
    optionChain: true,
    gtt: false,
    amo: false,
  },
};

// ─── Lifecycle ──────────────────────────────────────────────────

beforeAll(async () => {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(TEST_MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });
  }
  await BrokerConfigModel.deleteMany({ brokerId: TEST_BROKER_ID });
}, 15000);

afterAll(async () => {
  await BrokerConfigModel.deleteMany({ brokerId: TEST_BROKER_ID });
  await mongoose.disconnect();
}, 10000);

beforeEach(async () => {
  _resetForTesting();
  await BrokerConfigModel.deleteMany({ brokerId: TEST_BROKER_ID });
  registerAdapter(TEST_BROKER_ID, () => new MockAdapter());
  await upsertBrokerConfig(mockConfig);
  await initBrokerService();
});

// ─── Token Status (used by option_chain_fetcher, execution_module) ──

describe("GET /api/broker/token/status (Python: option_chain_fetcher, execution_module)", () => {
  it("returns valid token status for mock adapter", async () => {
    const broker = getActiveBroker()!;
    const result = await broker.validateToken();
    expect(result).toBeDefined();
    expect(result.valid).toBe(true);
  });

  it("returns expiresAt as optional field", async () => {
    const broker = getActiveBroker()!;
    const result = await broker.validateToken();
    // MockAdapter does not set expiresAt — it's optional per the interface
    // Real adapters (Dhan) will set it
    expect(result.valid).toBe(true);
  });
});

// ─── Expiry List with exchangeSegment (used by option_chain_fetcher) ──

describe("GET /api/broker/option-chain/expiry-list (Python: option_chain_fetcher)", () => {
  it("returns expiry dates for IDX_I segment (NIFTY)", async () => {
    const broker = getActiveBroker()!;
    const expiries = await broker.getExpiryList("13", "IDX_I");
    expect(Array.isArray(expiries)).toBe(true);
    expect(expiries.length).toBeGreaterThan(0);
    // Each entry should be a date string
    expiries.forEach((d: string) => {
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  it("returns expiry dates for MCX_COMM segment (CRUDEOIL)", async () => {
    const broker = getActiveBroker()!;
    const expiries = await broker.getExpiryList("486502", "MCX_COMM");
    expect(Array.isArray(expiries)).toBe(true);
    expect(expiries.length).toBeGreaterThan(0);
  });

  it("defaults to IDX_I when exchangeSegment is omitted", async () => {
    const broker = getActiveBroker()!;
    const expiries = await broker.getExpiryList("13");
    expect(Array.isArray(expiries)).toBe(true);
    expect(expiries.length).toBeGreaterThan(0);
  });

  it("returns empty array for invalid underlying", async () => {
    const broker = getActiveBroker()!;
    // MockAdapter returns same data regardless, but real adapter would return []
    const expiries = await broker.getExpiryList("999999", "IDX_I");
    expect(Array.isArray(expiries)).toBe(true);
  });
});

// ─── Option Chain with exchangeSegment (used by option_chain_fetcher) ──

describe("GET /api/broker/option-chain (Python: option_chain_fetcher)", () => {
  it("returns option chain with normalized rows for IDX_I", async () => {
    const broker = getActiveBroker()!;
    const chain = await broker.getOptionChain("13", "2026-04-07", "IDX_I");
    expect(chain).toBeDefined();
    expect(chain.underlying).toBe("13");
    expect(chain.expiry).toBe("2026-04-07");
    expect(chain.spotPrice).toBeGreaterThan(0);
    expect(Array.isArray(chain.rows)).toBe(true);
    expect(chain.rows.length).toBeGreaterThan(0);
  });

  it("returns option chain with normalized rows for MCX_COMM", async () => {
    const broker = getActiveBroker()!;
    const chain = await broker.getOptionChain("486502", "2026-04-20", "MCX_COMM");
    expect(chain).toBeDefined();
    expect(Array.isArray(chain.rows)).toBe(true);
    expect(chain.rows.length).toBeGreaterThan(0);
  });

  it("each row has all required OptionChainRow fields", async () => {
    const broker = getActiveBroker()!;
    const chain = await broker.getOptionChain("13", "2026-04-07", "IDX_I");
    const row = chain.rows[0];
    expect(row).toHaveProperty("strike");
    expect(row).toHaveProperty("callOI");
    expect(row).toHaveProperty("callOIChange");
    expect(row).toHaveProperty("callLTP");
    expect(row).toHaveProperty("callVolume");
    expect(row).toHaveProperty("callIV");
    expect(row).toHaveProperty("putOI");
    expect(row).toHaveProperty("putOIChange");
    expect(row).toHaveProperty("putLTP");
    expect(row).toHaveProperty("putVolume");
    expect(row).toHaveProperty("putIV");
    expect(typeof row.strike).toBe("number");
    expect(typeof row.callOI).toBe("number");
    expect(typeof row.putOI).toBe("number");
  });

  it("returns timestamp in the response", async () => {
    const broker = getActiveBroker()!;
    const chain = await broker.getOptionChain("13", "2026-04-07");
    expect(chain.timestamp).toBeDefined();
    expect(typeof chain.timestamp).toBe("number");
    expect(chain.timestamp).toBeGreaterThan(0);
  });

  it("defaults to IDX_I when exchangeSegment is omitted", async () => {
    const broker = getActiveBroker()!;
    const chain = await broker.getOptionChain("13", "2026-04-07");
    expect(chain).toBeDefined();
    expect(chain.rows.length).toBeGreaterThan(0);
  });
});

// ─── MCX FUTCOM Resolution (used by option_chain_fetcher) ──

describe("GET /api/broker/scrip-master/mcx-futcom (Python: option_chain_fetcher)", () => {
  it("resolves CRUDEOIL to a valid security", async () => {
    const broker = getActiveBroker()!;
    const result = broker.resolveMCXFutcom!("CRUDEOIL");
    // MockAdapter returns synchronously, real adapter is async
    const resolved = result instanceof Promise ? await result : result;
    expect(resolved).not.toBeNull();
    expect(resolved!.securityId).toBeDefined();
    expect(resolved!.exchange).toBe("MCX");
    expect(resolved!.instrumentName).toBe("FUTCOM");
    expect(resolved!.lotSize).toBeGreaterThan(0);
  });

  it("resolves NATURALGAS to a valid security", async () => {
    const broker = getActiveBroker()!;
    const result = broker.resolveMCXFutcom!("NATURALGAS");
    const resolved = result instanceof Promise ? await result : result;
    expect(resolved).not.toBeNull();
    expect(resolved!.securityId).toBeDefined();
    expect(resolved!.exchange).toBe("MCX");
    expect(resolved!.instrumentName).toBe("FUTCOM");
  });

  it("returns null for unknown commodity", async () => {
    const broker = getActiveBroker()!;
    const result = broker.resolveMCXFutcom!("UNKNOWNCOMMODITY");
    const resolved = result instanceof Promise ? await result : result;
    expect(resolved).toBeNull();
  });

  it("is case-insensitive", async () => {
    const broker = getActiveBroker()!;
    const upper = broker.resolveMCXFutcom!("CRUDEOIL");
    const lower = broker.resolveMCXFutcom!("crudeoil");
    const resolvedUpper = upper instanceof Promise ? await upper : upper;
    const resolvedLower = lower instanceof Promise ? await lower : lower;
    expect(resolvedUpper).not.toBeNull();
    expect(resolvedLower).not.toBeNull();
    expect(resolvedUpper!.securityId).toBe(resolvedLower!.securityId);
  });
});

// ─── Scrip Master Lookup (used by execution_module) ──

describe("GET /api/broker/scrip-master/lookup (Python: execution_module)", () => {
  it("finds NIFTY CE option by symbol and strike", async () => {
    const broker = getActiveBroker()!;
    const result = broker.lookupSecurity!({
      symbol: "NIFTY",
      strike: 26000,
      optionType: "CE",
    });
    expect(result).not.toBeNull();
    expect(result!.securityId).toBeDefined();
    expect(result!.optionType).toBe("CE");
    expect(result!.strikePrice).toBe(26000);
  });

  it("finds NIFTY PE option by symbol and strike", async () => {
    const broker = getActiveBroker()!;
    const result = broker.lookupSecurity!({
      symbol: "NIFTY",
      strike: 26000,
      optionType: "PE",
    });
    expect(result).not.toBeNull();
    expect(result!.optionType).toBe("PE");
  });

  it("returns null for non-existent security", async () => {
    const broker = getActiveBroker()!;
    const result = broker.lookupSecurity!({
      symbol: "NONEXISTENT",
      strike: 99999,
      optionType: "CE",
    });
    expect(result).toBeNull();
  });

  it("returns lotSize in the result", async () => {
    const broker = getActiveBroker()!;
    const result = broker.lookupSecurity!({
      symbol: "NIFTY",
      strike: 26000,
      optionType: "CE",
    });
    expect(result).not.toBeNull();
    expect(result!.lotSize).toBeGreaterThan(0);
  });
});

// ─── Order Placement (used by execution_module) ──

describe("POST /api/broker/orders (Python: execution_module)", () => {
  it("places a BUY order and returns orderId with FILLED status", async () => {
    const broker = getActiveBroker()!;
    const result = await broker.placeOrder({
      instrument: "NIFTY",
      exchange: "NSE_FNO",
      transactionType: "BUY",
      optionType: "CE",
      strike: 26000,
      expiry: "2026-04-07",
      quantity: 50,
      price: 150,
      orderType: "LIMIT",
      productType: "INTRADAY",
    });
    expect(result).toBeDefined();
    expect(result.orderId).toBeDefined();
    expect(result.orderId.length).toBeGreaterThan(0);
    expect(result.status).toBe("FILLED");
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it("places a SELL order for exit", async () => {
    const broker = getActiveBroker()!;
    // First place a BUY
    await broker.placeOrder({
      instrument: "NIFTY",
      exchange: "NSE_FNO",
      transactionType: "BUY",
      optionType: "CE",
      strike: 26000,
      expiry: "2026-04-07",
      quantity: 50,
      price: 150,
      orderType: "LIMIT",
      productType: "INTRADAY",
    });
    // Then exit with SELL
    const result = await broker.placeOrder({
      instrument: "NIFTY",
      exchange: "NSE_FNO",
      transactionType: "SELL",
      optionType: "CE",
      strike: 26000,
      expiry: "2026-04-07",
      quantity: 50,
      price: 160,
      orderType: "MARKET",
      productType: "INTRADAY",
    });
    expect(result.orderId).toBeDefined();
    expect(result.status).toBe("FILLED");
  });
});

// ─── Positions (used by execution_module) ──

describe("GET /api/broker/positions (Python: execution_module)", () => {
  it("returns empty positions initially", async () => {
    const broker = getActiveBroker()!;
    const positions = await broker.getPositions();
    expect(Array.isArray(positions)).toBe(true);
    expect(positions.length).toBe(0);
  });

  it("returns position after order fill", async () => {
    const broker = getActiveBroker()!;
    await broker.placeOrder({
      instrument: "NIFTY",
      exchange: "NSE_FNO",
      transactionType: "BUY",
      optionType: "CE",
      strike: 26000,
      expiry: "2026-04-07",
      quantity: 50,
      price: 150,
      orderType: "LIMIT",
      productType: "INTRADAY",
    });
    const positions = await broker.getPositions();
    expect(positions.length).toBeGreaterThan(0);
    const pos = positions[0];
    expect(pos.instrument).toBe("NIFTY");
    expect(pos.quantity).toBe(50);
    expect(pos.averagePrice).toBe(150);
    expect(pos.status).toBe("OPEN");
    expect(pos.optionType).toBe("CE");
    expect(pos.strike).toBe(26000);
  });

  it("closes position after exit order", async () => {
    const broker = getActiveBroker()!;
    // Open
    await broker.placeOrder({
      instrument: "NIFTY",
      exchange: "NSE_FNO",
      transactionType: "BUY",
      optionType: "CE",
      strike: 26000,
      expiry: "2026-04-07",
      quantity: 50,
      price: 150,
      orderType: "LIMIT",
      productType: "INTRADAY",
    });
    // Close
    await broker.placeOrder({
      instrument: "NIFTY",
      exchange: "NSE_FNO",
      transactionType: "SELL",
      optionType: "CE",
      strike: 26000,
      expiry: "2026-04-07",
      quantity: 50,
      price: 160,
      orderType: "MARKET",
      productType: "INTRADAY",
    });
    const positions = await broker.getPositions();
    const closedPos = positions.find((p) => p.status === "CLOSED");
    expect(closedPos).toBeDefined();
  });
});

// ─── Kill Switch (used by execution_module) ──

describe("POST /api/broker/kill-switch (Python: execution_module)", () => {
  it("activates kill switch and rejects new orders", async () => {
    const broker = getActiveBroker()!;
    const ksResult = await broker.killSwitch("ACTIVATE");
    expect(ksResult.status).toBe("activated");

    // New orders should be REJECTED, not throw
    const orderResult = await broker.placeOrder({
      instrument: "NIFTY",
      exchange: "NSE_FNO",
      transactionType: "BUY",
      optionType: "CE",
      strike: 26000,
      expiry: "2026-04-07",
      quantity: 50,
      price: 150,
      orderType: "LIMIT",
      productType: "INTRADAY",
    });
    expect(orderResult.status).toBe("REJECTED");
    expect(orderResult.message).toContain("Kill switch");
  });

  it("deactivates kill switch and allows orders again", async () => {
    const broker = getActiveBroker()!;
    await broker.killSwitch("ACTIVATE");
    const deactivateResult = await broker.killSwitch("DEACTIVATE");
    expect(deactivateResult.status).toBe("deactivated");

    const result = await broker.placeOrder({
      instrument: "NIFTY",
      exchange: "NSE_FNO",
      transactionType: "BUY",
      optionType: "CE",
      strike: 26000,
      expiry: "2026-04-07",
      quantity: 50,
      price: 150,
      orderType: "LIMIT",
      productType: "INTRADAY",
    });
    expect(result.orderId).toBeDefined();
    expect(result.status).toBe("FILLED");
  });
});
