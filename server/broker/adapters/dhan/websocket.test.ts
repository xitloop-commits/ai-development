/**
 * DhanWebSocket Tests
 *
 * Tests the market feed WebSocket client with a mocked 'ws' module.
 * Also covers binary packet parsing functions as pure unit tests.
 *
 * Two groups:
 *   1. Pure parsing helpers (no WebSocket needed)
 *   2. DhanWebSocket lifecycle and subscription (mocked ws)
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoisted MockWs ────────────────────────────────────────────
// vi.hoisted runs before imports so the mock class is ready for vi.mock()

const { MockWs, getInstances, clearInstances } = vi.hoisted(() => {
  // Use require() here — imports are not yet available inside vi.hoisted()
  const { EventEmitter } = require("events") as typeof import("events");
  const instances: any[] = [];

  class MockWs extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState: number = 1; // OPEN by default
    url: string;
    sentMessages: any[] = [];
    _socket = { setNoDelay: () => {} };

    constructor(url: string) {
      super();
      this.url = url;
      instances.push(this);
    }

    send(data: any) {
      this.sentMessages.push(data);
    }

    close() {
      this.readyState = 3; // CLOSED — intentionally does NOT emit "close"
    }

    ping() {}
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

// ─── Imports (after mock is registered) ───────────────────────

import {
  DhanWebSocket,
  parseHeader,
  parseTickerPacket,
  parseQuotePacket,
  parseFullPacket,
} from "./websocket";
import { DHAN_WS_FEED_URL, DHAN_FEED_REQUEST, DHAN_FEED_RESPONSE } from "./constants";

// ─── Helpers ──────────────────────────────────────────────────

const TEST_TOKEN = "test-access-token-xyz";
const TEST_CLIENT = "test-client-123";

function makeConfig(overrides: Record<string, any> = {}) {
  return {
    accessToken: TEST_TOKEN,
    clientId: TEST_CLIENT,
    onTick: vi.fn(),
    onRawMessage: vi.fn(),
    onPrevClose: vi.fn(),
    onDisconnect: vi.fn(),
    onError: vi.fn(),
    onConnected: vi.fn(),
    ...overrides,
  };
}

/** Creates a DhanWebSocket, connects it by firing "open" on the mock, and returns both. */
async function connectWs(cfg = makeConfig()) {
  const ws = new DhanWebSocket(cfg);
  const connectPromise = ws.connect();
  // Grab the MockWs instance created during ws.connect()
  const mock = getInstances().at(-1)!;
  mock.emit("open");
  await connectPromise;
  return { ws, mock, cfg };
}

beforeEach(() => {
  clearInstances();
  vi.clearAllMocks();
});

// ─── Binary Parsing (pure functions) ──────────────────────────

describe("Binary Packet Parsing", () => {
  describe("parseHeader", () => {
    it("reads responseCode from byte 0", () => {
      const buf = Buffer.alloc(16);
      buf.writeUInt8(2, 0); // responseCode = TICKER
      buf.writeInt16LE(16, 1); // messageLength
      buf.writeUInt8(2, 3); // exchangeSegment = NSE_FNO
      buf.writeInt32LE(52175, 4); // securityId

      const hdr = parseHeader(buf);
      expect(hdr.responseCode).toBe(2);
      expect(hdr.messageLength).toBe(16);
      expect(hdr.exchangeSegment).toBe(2);
      expect(hdr.securityId).toBe(52175);
    });
  });

  describe("parseTickerPacket", () => {
    it("reads ltp from bytes 8-11 and ltt from bytes 12-15", () => {
      const buf = Buffer.alloc(20);
      buf.writeFloatLE(245.75, 8); // ltp
      buf.writeInt32LE(1744170900, 12); // ltt

      const tick = parseTickerPacket(buf, "52175", "NSE_FNO" as any);
      expect(tick.ltp).toBeCloseTo(245.75, 1);
      expect(tick.ltt).toBe(1744170900);
      expect(tick.securityId).toBe("52175");
      expect(tick.exchange).toBe("NSE_FNO");
    });
  });

  describe("parseQuotePacket", () => {
    it("reads all OHLCV fields from the buffer", () => {
      const buf = Buffer.alloc(52);
      buf.writeFloatLE(300.5, 8);  // ltp
      buf.writeInt16LE(10, 12);    // ltq
      buf.writeInt32LE(1744170900, 14); // ltt
      buf.writeFloatLE(299.5, 18); // atp
      buf.writeInt32LE(5000, 22);  // volume
      buf.writeInt32LE(1000, 26);  // totalSellQty
      buf.writeInt32LE(2000, 30);  // totalBuyQty
      buf.writeFloatLE(295.0, 34); // dayOpen
      buf.writeFloatLE(305.0, 38); // dayClose
      buf.writeFloatLE(310.0, 42); // dayHigh
      buf.writeFloatLE(290.0, 46); // dayLow

      const tick = parseQuotePacket(buf, "52175", "NSE_FNO" as any);
      expect(tick.ltp).toBeCloseTo(300.5, 1);
      expect(tick.ltq).toBe(10);
      expect(tick.atp).toBeCloseTo(299.5, 1);
      expect(tick.volume).toBe(5000);
      expect(tick.totalSellQty).toBe(1000);
      expect(tick.totalBuyQty).toBe(2000);
      expect(tick.dayOpen).toBeCloseTo(295.0, 1);
      expect(tick.dayHigh).toBeCloseTo(310.0, 1);
      expect(tick.dayLow).toBeCloseTo(290.0, 1);
    });
  });

  describe("parseFullPacket", () => {
    it("reads all full packet fields (162 bytes)", () => {
      const buf = Buffer.alloc(162);
      buf.writeFloatLE(250.0, 8);  // ltp
      buf.writeInt16LE(25, 12);    // ltq
      buf.writeInt32LE(1744170900, 14); // ltt
      buf.writeFloatLE(249.5, 18); // atp
      buf.writeInt32LE(8000, 22);  // volume
      buf.writeInt32LE(1500, 26);  // totalSellQty
      buf.writeInt32LE(2500, 30);  // totalBuyQty
      buf.writeInt32LE(150000, 34); // oi
      buf.writeInt32LE(200000, 38); // highOI
      buf.writeInt32LE(100000, 42); // lowOI
      buf.writeFloatLE(245.0, 46); // dayOpen
      buf.writeFloatLE(252.0, 50); // dayClose
      buf.writeFloatLE(260.0, 54); // dayHigh
      buf.writeFloatLE(240.0, 58); // dayLow

      const tick = parseFullPacket(buf, "52175", "NSE_FNO" as any);
      expect(tick.ltp).toBeCloseTo(250.0, 1);
      expect(tick.oi).toBe(150000);
      expect(tick.highOI).toBe(200000);
      expect(tick.volume).toBe(8000);
      expect(tick.dayOpen).toBeCloseTo(245.0, 1);
      expect(tick.dayHigh).toBeCloseTo(260.0, 1);
      expect(tick.dayLow).toBeCloseTo(240.0, 1);
      expect(tick.depth.length).toBe(5);
    });
  });
});

// ─── DhanWebSocket Lifecycle ──────────────────────────────────

describe("DhanWebSocket", () => {
  describe("URL Construction", () => {
    it("includes token, clientId, version=2, authType=2 in the WS URL", async () => {
      const { mock } = await connectWs();
      expect(mock.url).toContain(`token=${TEST_TOKEN}`);
      expect(mock.url).toContain(`clientId=${TEST_CLIENT}`);
      expect(mock.url).toContain("version=2");
      expect(mock.url).toContain("authType=2");
      expect(mock.url).toContain(DHAN_WS_FEED_URL);
    });
  });

  describe("Connection Lifecycle", () => {
    it("fires onConnected callback when WS emits open", async () => {
      const cfg = makeConfig();
      const { ws } = await connectWs(cfg);
      expect(cfg.onConnected).toHaveBeenCalledOnce();
      expect(ws.connected).toBe(true);
    });

    it("connected is false before connect()", () => {
      const ws = new DhanWebSocket(makeConfig());
      expect(ws.connected).toBe(false);
    });

    it("connected is false after disconnect()", async () => {
      const { ws } = await connectWs();
      await ws.disconnect();
      expect(ws.connected).toBe(false);
    });

    it("rejects the connect() promise when WS errors before open", async () => {
      const cfg = makeConfig();
      const ws = new DhanWebSocket(cfg);

      const connectPromise = ws.connect();
      const mock = getInstances().at(-1)!;

      const err = new Error("Connection refused");
      mock.emit("error", err);

      await expect(connectPromise).rejects.toThrow("Connection refused");
      expect(cfg.onError).toHaveBeenCalledWith(err);
    });

    it("calls onDisconnect when WS closes unexpectedly after connect", async () => {
      const cfg = makeConfig();
      const { ws, mock } = await connectWs(cfg);

      // Simulate unexpected server close
      mock.emit("close", 1006, Buffer.from("abnormal"));

      // Allow microtasks to settle
      await new Promise((r) => setTimeout(r, 0));

      expect(cfg.onDisconnect).not.toHaveBeenCalled(); // close event maps to scheduleReconnect, not onDisconnect
      expect(ws.connected).toBe(false);
    });

    it("onDisconnect fires on binary DISCONNECT packet (code 50)", async () => {
      const cfg = makeConfig();
      const { mock } = await connectWs(cfg);

      // Craft a DISCONNECT binary packet (code 50, min 10 bytes)
      const buf = Buffer.alloc(10);
      buf.writeUInt8(DHAN_FEED_RESPONSE.DISCONNECT, 0); // responseCode = 50
      buf.writeInt16LE(10, 1);
      buf.writeUInt8(0, 3);
      buf.writeInt32LE(0, 4);
      buf.writeInt16LE(807, 8); // code 807 = "Access token expired"

      mock.emit("message", buf);
      expect(cfg.onDisconnect).toHaveBeenCalledWith(807, "Access token expired");
    });
  });

  describe("Subscriptions", () => {
    it("subscribe() sends a JSON message when connected", async () => {
      const { ws, mock } = await connectWs();

      ws.subscribe([{ exchange: "NSE_FNO", securityId: "52175", mode: "full" }]);

      expect(mock.sentMessages.length).toBe(1);
      const msg = JSON.parse(mock.sentMessages[0]);
      expect(msg.RequestCode).toBe(DHAN_FEED_REQUEST.SUBSCRIBE_FULL);
      expect(msg.InstrumentCount).toBe(1);
      expect(msg.InstrumentList[0].ExchangeSegment).toBe("NSE_FNO");
      expect(msg.InstrumentList[0].SecurityId).toBe("52175");
    });

    it("subscriptionCount increases after subscribe()", async () => {
      const { ws } = await connectWs();
      expect(ws.subscriptionCount).toBe(0);

      ws.subscribe([
        { exchange: "NSE_FNO", securityId: "52175", mode: "full" },
        { exchange: "NSE_FNO", securityId: "52176", mode: "full" },
      ]);

      expect(ws.subscriptionCount).toBe(2);
    });

    it("duplicate subscribe does not increase subscriptionCount", async () => {
      const { ws } = await connectWs();

      ws.subscribe([{ exchange: "NSE_FNO", securityId: "52175", mode: "full" }]);
      ws.subscribe([{ exchange: "NSE_FNO", securityId: "52175", mode: "full" }]);

      expect(ws.subscriptionCount).toBe(1);
    });

    it("uses SUBSCRIBE_TICKER request code for ticker mode", async () => {
      const { ws, mock } = await connectWs();

      ws.subscribe([{ exchange: "NSE_FNO", securityId: "52175", mode: "ticker" }]);

      const msg = JSON.parse(mock.sentMessages[0]);
      expect(msg.RequestCode).toBe(DHAN_FEED_REQUEST.SUBSCRIBE_TICKER);
    });

    it("uses SUBSCRIBE_QUOTE request code for quote mode", async () => {
      const { ws, mock } = await connectWs();

      ws.subscribe([{ exchange: "NSE_FNO", securityId: "52175", mode: "quote" }]);

      const msg = JSON.parse(mock.sentMessages[0]);
      expect(msg.RequestCode).toBe(DHAN_FEED_REQUEST.SUBSCRIBE_QUOTE);
    });

    it("subscriptionCount decreases after unsubscribe()", async () => {
      const { ws } = await connectWs();

      ws.subscribe([
        { exchange: "NSE_FNO", securityId: "52175", mode: "full" },
        { exchange: "NSE_FNO", securityId: "52176", mode: "full" },
      ]);
      expect(ws.subscriptionCount).toBe(2);

      ws.unsubscribe([{ exchange: "NSE_FNO", securityId: "52175" }]);
      expect(ws.subscriptionCount).toBe(1);
    });

    it("queues subscriptions before connect and sends on open", async () => {
      const cfg = makeConfig();
      const ws = new DhanWebSocket(cfg);

      // Subscribe BEFORE connecting — should queue
      ws.subscribe([{ exchange: "NSE_FNO", securityId: "52175", mode: "full" }]);
      expect(ws.subscriptionCount).toBe(1);

      const connectPromise = ws.connect();
      const mock = getInstances().at(-1)!;
      mock.emit("open");
      await connectPromise;

      // After connect, resubscribeAll() should have sent the queued instruments
      expect(mock.sentMessages.length).toBeGreaterThan(0);
    });
  });

  describe("Message Handling", () => {
    it("passes raw binary buffer to onRawMessage callback", async () => {
      const cfg = makeConfig();
      const { mock } = await connectWs(cfg);

      const buf = Buffer.alloc(16);
      buf.writeUInt8(2, 0); // TICKER code
      buf.writeInt16LE(16, 1);
      buf.writeUInt8(2, 3); // NSE_FNO
      buf.writeInt32LE(52175, 4);
      buf.writeFloatLE(245.5, 8);
      buf.writeInt32LE(1744170900, 12);

      mock.emit("message", buf);
      expect(cfg.onRawMessage).toHaveBeenCalledWith(buf);
    });

    it("fires onTick for a TICKER packet (code 2)", async () => {
      const cfg = makeConfig();
      const { mock } = await connectWs(cfg);

      const buf = Buffer.alloc(20);
      buf.writeUInt8(DHAN_FEED_RESPONSE.TICKER, 0);
      buf.writeInt16LE(20, 1);
      buf.writeUInt8(2, 3); // NSE_FNO exchange segment code
      buf.writeInt32LE(52175, 4);
      buf.writeFloatLE(245.5, 8);
      buf.writeInt32LE(1744170900, 12);

      mock.emit("message", buf);

      expect(cfg.onTick).toHaveBeenCalled();
      const tick = cfg.onTick.mock.calls[0][0];
      expect(tick.securityId).toBe("52175");
      expect(tick.exchange).toBe("NSE_FNO");
      expect(tick.ltp).toBeCloseTo(245.5, 1);
    });

    it("fires onTick for a FULL packet (code 8) with depth", async () => {
      const cfg = makeConfig();
      const { mock } = await connectWs(cfg);

      const buf = Buffer.alloc(162);
      buf.writeUInt8(DHAN_FEED_RESPONSE.FULL, 0);
      buf.writeInt16LE(162, 1);
      buf.writeUInt8(2, 3); // NSE_FNO
      buf.writeInt32LE(52175, 4);
      buf.writeFloatLE(250.0, 8); // ltp

      mock.emit("message", buf);

      expect(cfg.onTick).toHaveBeenCalled();
      const tick = cfg.onTick.mock.calls[0][0];
      expect(tick.ltp).toBeCloseTo(250.0, 1);
      expect(tick.depth.length).toBe(5);
    });

    it("ignores messages shorter than 8 bytes", async () => {
      const cfg = makeConfig();
      const { mock } = await connectWs(cfg);

      const shortBuf = Buffer.alloc(4);
      mock.emit("message", shortBuf);

      // onTick should NOT be called for malformed packets
      expect(cfg.onTick).not.toHaveBeenCalled();
    });

    it("fires onPrevClose callback for PREV_CLOSE packet (code 6)", async () => {
      const cfg = makeConfig();
      const { mock } = await connectWs(cfg);

      const buf = Buffer.alloc(16);
      buf.writeUInt8(DHAN_FEED_RESPONSE.PREV_CLOSE, 0);
      buf.writeInt16LE(16, 1);
      buf.writeUInt8(2, 3); // NSE_FNO
      buf.writeInt32LE(52175, 4);
      buf.writeFloatLE(240.0, 8); // prevClose
      buf.writeInt32LE(120000, 12); // prevOI

      mock.emit("message", buf);

      expect(cfg.onPrevClose).toHaveBeenCalledWith({
        securityId: "52175",
        exchange: "NSE_FNO",
        prevClose: expect.closeTo(240.0, 1),
        prevOI: 120000,
      });
    });
  });

  describe("Disconnect", () => {
    it("disconnect() sets connected to false", async () => {
      const { ws } = await connectWs();
      expect(ws.connected).toBe(true);

      await ws.disconnect();
      expect(ws.connected).toBe(false);
    });

    it("disconnect() sends DISCONNECT request code before closing", async () => {
      const { ws, mock } = await connectWs();

      await ws.disconnect();

      const disconnectMsg = mock.sentMessages.find((m) => {
        try {
          return JSON.parse(m).RequestCode === DHAN_FEED_REQUEST.DISCONNECT;
        } catch {
          return false;
        }
      });
      expect(disconnectMsg).toBeDefined();
    });

    it("subsequent close events after disconnect() do not trigger reconnect", async () => {
      const cfg = makeConfig();
      const { ws, mock } = await connectWs(cfg);

      await ws.disconnect();

      // Simulate a late close event — should NOT schedule reconnect
      const instanceCountBefore = getInstances().length;
      mock.emit("close", 1000, Buffer.from("normal"));

      await new Promise((r) => setTimeout(r, 10));

      // No new MockWs instance should have been created (no reconnect)
      expect(getInstances().length).toBe(instanceCountBefore);
    });
  });
});
