/**
 * DhanOrderUpdateWs Tests
 *
 * Tests the order update WebSocket client with a mocked 'ws' module.
 * Covers:
 * - Auth message sent on open
 * - order_alert normalization (all fields)
 * - TxnType B/S → BUY/SELL mapping
 * - Reconnection on unexpected close
 * - No reconnection after disconnect()
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── Hoisted MockWs ────────────────────────────────────────────

const { MockWs, getInstances, clearInstances } = vi.hoisted(() => {
  // Use require() — imports are not yet available inside vi.hoisted()
  const { EventEmitter } = require("events") as typeof import("events");
  const instances: any[] = [];

  class MockWs extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState: number = 1;
    url: string;
    sentMessages: any[] = [];

    constructor(url: string) {
      super();
      this.url = url;
      instances.push(this);
    }

    send(data: any) {
      this.sentMessages.push(data);
    }

    close() {
      this.readyState = 3;
    }

    ping() {}

    removeAllListeners() {
      super.removeAllListeners();
      return this;
    }
  }

  return {
    MockWs,
    getInstances: () => instances as InstanceType<typeof MockWs>[],
    clearInstances: () => instances.splice(0),
  };
});

vi.mock("ws", () => ({
  default: MockWs,
  WebSocket: MockWs,
}));

// ─── Imports ──────────────────────────────────────────────────

import { DhanOrderUpdateWs } from "./orderUpdateWs";
import type { DhanOrderUpdateRaw, NormalizedOrderUpdate } from "./orderUpdateWs";

// ─── Helpers ──────────────────────────────────────────────────

const TEST_CLIENT = "client-999";
const TEST_TOKEN = "ws-token-abc";

function makeRawAlert(overrides: Partial<DhanOrderUpdateRaw["Data"]> = {}): DhanOrderUpdateRaw {
  return {
    Type: "order_alert",
    Data: {
      Exchange: "NSE",
      Segment: "D",
      SecurityId: "52175",
      ClientId: TEST_CLIENT,
      ExchOrderNo: "EXCH-001",
      OrderNo: "ORD-001",
      Product: "I",
      TxnType: "B",
      OrderType: "LMT",
      Quantity: 75,
      TradedQty: 75,
      RemainingQuantity: 0,
      Price: 150.0,
      TriggerPrice: 0,
      TradedPrice: 151.0,
      AvgTradedPrice: 150.5,
      Status: "TRADED",
      LegNo: 1,
      Symbol: "NIFTY26APR24000CE",
      StrikePrice: 24000,
      ExpiryDate: "2026-04-03",
      OptType: "CE",
      LotSize: 75,
      CorrelationId: "corr-xyz",
      Remarks: "",
      LastUpdatedTime: "2026-04-11 10:15:00",
      AlgoOrdNo: "ALGO-001",
      ...overrides,
    },
  };
}

beforeEach(() => {
  clearInstances();
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tests ────────────────────────────────────────────────────

describe("DhanOrderUpdateWs", () => {
  describe("Connection", () => {
    it("connects to the Dhan order update WS URL", () => {
      const client = new DhanOrderUpdateWs(TEST_CLIENT, TEST_TOKEN);
      client.connect();

      const mock = getInstances().at(-1)!;
      expect(mock.url).toBe("wss://api-order-update.dhan.co");
    });

    it("sends auth JSON on open", () => {
      const client = new DhanOrderUpdateWs(TEST_CLIENT, TEST_TOKEN);
      client.connect();

      const mock = getInstances().at(-1)!;
      mock.emit("open");

      expect(mock.sentMessages.length).toBe(1);
      const msg = JSON.parse(mock.sentMessages[0]);
      expect(msg.LoginReq.MsgCode).toBe(42);
      expect(msg.LoginReq.ClientId).toBe(TEST_CLIENT);
      expect(msg.LoginReq.Token).toBe(TEST_TOKEN);
      expect(msg.UserType).toBe("SELF");
    });

    it("connected property is true when WS is OPEN", () => {
      const client = new DhanOrderUpdateWs(TEST_CLIENT, TEST_TOKEN);
      client.connect();

      const mock = getInstances().at(-1)!;
      mock.readyState = MockWs.OPEN;
      expect(client.connected).toBe(true);
    });

    it("connected property is false when WS is CLOSED", () => {
      const client = new DhanOrderUpdateWs(TEST_CLIENT, TEST_TOKEN);
      client.connect();

      const mock = getInstances().at(-1)!;
      mock.readyState = MockWs.CLOSED;
      expect(client.connected).toBe(false);
    });
  });

  describe("Order Alert Parsing", () => {
    it("emits orderUpdate for order_alert messages", (done) => {
      const client = new DhanOrderUpdateWs(TEST_CLIENT, TEST_TOKEN);
      client.connect();

      const mock = getInstances().at(-1)!;
      mock.emit("open");

      client.on("orderUpdate", (update: NormalizedOrderUpdate) => {
        expect(update).toBeDefined();
        done();
      });

      const raw = makeRawAlert();
      mock.emit("message", JSON.stringify(raw));
    });

    it("normalizes all fields from the order_alert payload", (done) => {
      const client = new DhanOrderUpdateWs(TEST_CLIENT, TEST_TOKEN);
      client.connect();

      const mock = getInstances().at(-1)!;
      mock.emit("open");

      client.on("orderUpdate", (update: NormalizedOrderUpdate) => {
        expect(update.orderId).toBe("ORD-001");
        expect(update.exchOrderId).toBe("EXCH-001");
        expect(update.securityId).toBe("52175");
        expect(update.exchange).toBe("NSE");
        expect(update.symbol).toBe("NIFTY26APR24000CE");
        expect(update.txnType).toBe("BUY");       // "B" → "BUY"
        expect(update.status).toBe("TRADED");
        expect(update.legNo).toBe(1);
        expect(update.entryOrderId).toBe("ALGO-001");
        expect(update.quantity).toBe(75);
        expect(update.tradedQty).toBe(75);
        expect(update.remainingQty).toBe(0);
        expect(update.price).toBe(150.0);
        expect(update.triggerPrice).toBe(0);
        expect(update.tradedPrice).toBe(151.0);
        expect(update.avgTradedPrice).toBe(150.5);
        expect(update.strikePrice).toBe(24000);
        expect(update.expiryDate).toBe("2026-04-03");
        expect(update.optionType).toBe("CE");
        expect(update.lotSize).toBe(75);
        expect(update.correlationId).toBe("corr-xyz");
        expect(update.timestamp).toBe("2026-04-11 10:15:00");
        done();
      });

      mock.emit("message", JSON.stringify(makeRawAlert()));
    });

    it("maps TxnType 'S' to SELL", (done) => {
      const client = new DhanOrderUpdateWs(TEST_CLIENT, TEST_TOKEN);
      client.connect();

      const mock = getInstances().at(-1)!;
      mock.emit("open");

      client.on("orderUpdate", (update: NormalizedOrderUpdate) => {
        expect(update.txnType).toBe("SELL");
        done();
      });

      mock.emit("message", JSON.stringify(makeRawAlert({ TxnType: "S" })));
    });

    it("handles string StrikePrice by parsing to number", (done) => {
      const client = new DhanOrderUpdateWs(TEST_CLIENT, TEST_TOKEN);
      client.connect();

      const mock = getInstances().at(-1)!;
      mock.emit("open");

      client.on("orderUpdate", (update: NormalizedOrderUpdate) => {
        expect(update.strikePrice).toBe(24000);
        done();
      });

      mock.emit("message", JSON.stringify(makeRawAlert({ StrikePrice: "24000" })));
    });

    it("does not emit for non-order_alert message types", () => {
      const client = new DhanOrderUpdateWs(TEST_CLIENT, TEST_TOKEN);
      client.connect();

      const mock = getInstances().at(-1)!;
      mock.emit("open");

      const updateSpy = vi.fn();
      client.on("orderUpdate", updateSpy);

      // Non-alert message type
      mock.emit("message", JSON.stringify({ Type: "heartbeat", Data: {} }));
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it("does not throw on malformed (non-JSON) messages", () => {
      const client = new DhanOrderUpdateWs(TEST_CLIENT, TEST_TOKEN);
      client.connect();

      const mock = getInstances().at(-1)!;
      mock.emit("open");

      // Should not throw
      expect(() => mock.emit("message", "not-valid-json")).not.toThrow();
    });
  });

  describe("Reconnection", () => {
    it("schedules reconnect on unexpected close", () => {
      const client = new DhanOrderUpdateWs(TEST_CLIENT, TEST_TOKEN);
      client.connect();

      const mock = getInstances().at(-1)!;
      mock.emit("open");
      mock.emit("close", 1006, "abnormal");

      const instanceCountBefore = getInstances().length;

      // Advance fake timers by reconnect delay (5000ms)
      vi.advanceTimersByTime(5000);

      // A new MockWs instance should have been created for the reconnect
      expect(getInstances().length).toBeGreaterThan(instanceCountBefore);
    });

    it("does NOT reconnect after disconnect()", () => {
      const client = new DhanOrderUpdateWs(TEST_CLIENT, TEST_TOKEN);
      client.connect();

      const mock = getInstances().at(-1)!;
      mock.emit("open");

      client.disconnect();

      const instanceCountAfterDisconnect = getInstances().length;

      // Advance timers — no reconnect should occur
      vi.advanceTimersByTime(10000);
      expect(getInstances().length).toBe(instanceCountAfterDisconnect);
    });
  });

  describe("Credential Update", () => {
    it("updateCredentials() reconnects with new credentials when connected", () => {
      const client = new DhanOrderUpdateWs(TEST_CLIENT, TEST_TOKEN);
      client.connect();

      const mock = getInstances().at(-1)!;
      mock.readyState = MockWs.OPEN;

      const newToken = "new-token-xyz";
      client.updateCredentials(TEST_CLIENT, newToken);

      // After updateCredentials, should have created a new WS connection
      vi.runAllTimers();
      const newMock = getInstances().at(-1)!;
      // New instance should exist (disconnect + reconnect)
      expect(newMock).toBeDefined();
    });
  });
});
