import { describe, expect, it, beforeEach } from "vitest";
import { MockAdapter } from "./index";
import type { OrderParams } from "../../types";
import { transformCandleData } from "../../types";

// ─── Test Helpers ───────────────────────────────────────────────

function sampleBuyOrder(overrides?: Partial<OrderParams>): OrderParams {
  return {
    instrument: "NIFTY_50",
    exchange: "NSE_FNO",
    transactionType: "BUY",
    optionType: "CE",
    strike: 26000,
    expiry: "2026-04-03",
    quantity: 50,
    price: 150,
    orderType: "LIMIT",
    productType: "INTRADAY",
    tag: "test-order",
    ...overrides,
  };
}

function sampleSellOrder(overrides?: Partial<OrderParams>): OrderParams {
  return {
    instrument: "NIFTY_50",
    exchange: "NSE_FNO",
    transactionType: "SELL",
    optionType: "CE",
    strike: 26000,
    expiry: "2026-04-03",
    quantity: 50,
    price: 170,
    orderType: "LIMIT",
    productType: "INTRADAY",
    tag: "test-exit",
    ...overrides,
  };
}

// ─── Test Suite ─────────────────────────────────────────────────

describe("MockAdapter", () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter("mock", "Paper Trading", 500000);
  });

  // ── Lifecycle ─────────────────────────────────────────────────

  describe("Lifecycle", () => {
    it("connects and disconnects", async () => {
      await adapter.connect();
      expect(adapter.isConnected()).toBe(true);

      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);
    });

    it("has correct identity", () => {
      expect(adapter.brokerId).toBe("mock");
      expect(adapter.displayName).toBe("Paper Trading");
    });
  });

  // ── Auth ──────────────────────────────────────────────────────

  describe("Auth", () => {
    it("validateToken always returns valid", async () => {
      const result = await adapter.validateToken();
      expect(result.valid).toBe(true);
    });

    it("updateToken is a no-op", async () => {
      // Should not throw
      await adapter.updateToken("any-token", "any-client");
    });
  });

  // ── Place Order ───────────────────────────────────────────────

  describe("Place Order", () => {
    it("places a BUY order and gets FILLED status", async () => {
      const result = await adapter.placeOrder(sampleBuyOrder());

      expect(result.status).toBe("FILLED");
      expect(result.orderId).toMatch(/^MOCK-ORD-/);
      expect(result.timestamp).toBeGreaterThan(0);
      expect(result.message).toContain("paper trading");
    });

    it("order appears in order book after placement", async () => {
      await adapter.placeOrder(sampleBuyOrder());

      const orders = await adapter.getOrderBook();
      expect(orders.length).toBe(1);
      expect(orders[0].instrument).toBe("NIFTY_50");
      expect(orders[0].status).toBe("FILLED");
      expect(orders[0].filledQuantity).toBe(50);
      expect(orders[0].averagePrice).toBe(150);
    });

    it("trade appears in trade book after placement", async () => {
      await adapter.placeOrder(sampleBuyOrder());

      const trades = await adapter.getTradeBook();
      expect(trades.length).toBe(1);
      expect(trades[0].instrument).toBe("NIFTY_50");
      expect(trades[0].price).toBe(150);
      expect(trades[0].quantity).toBe(50);
    });

    it("position is created after BUY order", async () => {
      await adapter.placeOrder(sampleBuyOrder());

      const positions = await adapter.getPositions();
      expect(positions.length).toBe(1);
      expect(positions[0].instrument).toBe("NIFTY_50");
      expect(positions[0].transactionType).toBe("BUY");
      expect(positions[0].quantity).toBe(50);
      expect(positions[0].averagePrice).toBe(150);
      expect(positions[0].status).toBe("OPEN");
    });

    it("places multiple orders for different instruments", async () => {
      await adapter.placeOrder(sampleBuyOrder());
      await adapter.placeOrder(
        sampleBuyOrder({
          instrument: "BANK_NIFTY",
          strike: 55000,
          price: 200,
          quantity: 30,
        })
      );

      const orders = await adapter.getOrderBook();
      expect(orders.length).toBe(2);

      const positions = await adapter.getPositions();
      expect(positions.length).toBe(2);
    });

    it("adds to existing position when buying same instrument", async () => {
      await adapter.placeOrder(sampleBuyOrder({ price: 100, quantity: 50 }));
      await adapter.placeOrder(sampleBuyOrder({ price: 200, quantity: 50 }));

      const positions = await adapter.getPositions();
      expect(positions.length).toBe(1);
      expect(positions[0].quantity).toBe(100);
      // Average price: (100*50 + 200*50) / 100 = 150
      expect(positions[0].averagePrice).toBe(150);
    });
  });

  // ── Exit Position ─────────────────────────────────────────────

  describe("Exit Position", () => {
    it("closes position with opposite SELL order", async () => {
      // Buy
      await adapter.placeOrder(sampleBuyOrder({ price: 150 }));

      // Sell (exit)
      await adapter.placeOrder(sampleSellOrder({ price: 170 }));

      const positions = await adapter.getPositions();
      // The BUY position should be closed, and a new SELL position created
      // (since exit creates a new position entry with opposite direction)
      const closedPositions = positions.filter((p) => p.status === "CLOSED");
      expect(closedPositions.length).toBeGreaterThanOrEqual(1);
    });

    it("calculates P&L on exit (profit)", async () => {
      // Buy at 150
      await adapter.placeOrder(sampleBuyOrder({ price: 150, quantity: 50 }));

      // Sell at 170 (profit of 20 per unit * 50 = 1000)
      await adapter.placeOrder(sampleSellOrder({ price: 170, quantity: 50 }));

      const positions = await adapter.getPositions();
      const closedBuy = positions.find(
        (p) => p.transactionType === "BUY" && p.status === "CLOSED"
      );
      expect(closedBuy).toBeDefined();
      expect(closedBuy!.pnl).toBe(1000); // (170 - 150) * 50
    });

    it("calculates P&L on exit (loss)", async () => {
      // Buy at 150
      await adapter.placeOrder(sampleBuyOrder({ price: 150, quantity: 50 }));

      // Sell at 130 (loss of 20 per unit * 50 = -1000)
      await adapter.placeOrder(sampleSellOrder({ price: 130, quantity: 50 }));

      const positions = await adapter.getPositions();
      const closedBuy = positions.find(
        (p) => p.transactionType === "BUY" && p.status === "CLOSED"
      );
      expect(closedBuy).toBeDefined();
      expect(closedBuy!.pnl).toBe(-1000); // (130 - 150) * 50
    });
  });

  // ── Modify & Cancel ───────────────────────────────────────────

  describe("Modify & Cancel", () => {
    it("rejects modify on filled order (instant fill in paper mode)", async () => {
      const placed = await adapter.placeOrder(sampleBuyOrder());

      const result = await adapter.modifyOrder(placed.orderId, {
        price: 160,
      });
      expect(result.status).toBe("REJECTED");
      expect(result.message).toContain("Cannot modify");
    });

    it("rejects cancel on filled order", async () => {
      const placed = await adapter.placeOrder(sampleBuyOrder());

      const result = await adapter.cancelOrder(placed.orderId);
      expect(result.status).toBe("REJECTED");
      expect(result.message).toContain("Cannot cancel");
    });

    it("rejects modify on non-existent order", async () => {
      const result = await adapter.modifyOrder("FAKE-ORDER-ID", {
        price: 160,
      });
      expect(result.status).toBe("REJECTED");
      expect(result.message).toContain("not found");
    });

    it("rejects cancel on non-existent order", async () => {
      const result = await adapter.cancelOrder("FAKE-ORDER-ID");
      expect(result.status).toBe("REJECTED");
      expect(result.message).toContain("not found");
    });
  });

  // ── Exit All ──────────────────────────────────────────────────

  describe("Exit All", () => {
    it("closes all open positions", async () => {
      // Open 3 positions
      await adapter.placeOrder(sampleBuyOrder({ instrument: "NIFTY_50" }));
      await adapter.placeOrder(
        sampleBuyOrder({ instrument: "BANK_NIFTY", strike: 55000 })
      );
      await adapter.placeOrder(
        sampleBuyOrder({ instrument: "CRUDE_OIL", exchange: "MCX_COMM", strike: 6000 })
      );

      const openBefore = await adapter.getOpenPositions();
      expect(openBefore.length).toBe(3);

      // Exit all
      const results = await adapter.exitAll();
      expect(results.length).toBe(3);
      results.forEach((r) => expect(r.status).toBe("FILLED"));

      // All positions should be closed
      const openAfter = await adapter.getOpenPositions();
      expect(openAfter.length).toBe(0);
    });

    it("returns empty array when no open positions", async () => {
      const results = await adapter.exitAll();
      expect(results).toEqual([]);
    });
  });

  // ── Margin ────────────────────────────────────────────────────

  describe("Margin", () => {
    it("returns initial margin when no orders placed", async () => {
      const margin = await adapter.getMargin();
      expect(margin.total).toBe(500000);
      expect(margin.available).toBe(500000);
      expect(margin.used).toBe(0);
    });

    it("reduces available margin after BUY order", async () => {
      await adapter.placeOrder(sampleBuyOrder({ price: 150, quantity: 50 }));

      const margin = await adapter.getMargin();
      expect(margin.used).toBe(7500); // 150 * 50
      expect(margin.available).toBe(492500); // 500000 - 7500
      expect(margin.total).toBe(500000);
    });

    it("accumulates margin usage across multiple orders", async () => {
      await adapter.placeOrder(sampleBuyOrder({ price: 100, quantity: 50 }));
      await adapter.placeOrder(
        sampleBuyOrder({
          instrument: "BANK_NIFTY",
          strike: 55000,
          price: 200,
          quantity: 30,
        })
      );

      const margin = await adapter.getMargin();
      expect(margin.used).toBe(11000); // (100*50) + (200*30)
      expect(margin.available).toBe(489000);
    });
  });

  // ── Kill Switch ───────────────────────────────────────────────

  describe("Kill Switch", () => {
    it("blocks new orders when activated", async () => {
      await adapter.killSwitch("ACTIVATE");
      expect(adapter.isKillSwitchActive()).toBe(true);

      const result = await adapter.placeOrder(sampleBuyOrder());
      expect(result.status).toBe("REJECTED");
      expect(result.message).toContain("Kill switch");
    });

    it("blocks modify when activated", async () => {
      // Place order first
      const placed = await adapter.placeOrder(sampleBuyOrder());

      // Activate kill switch
      await adapter.killSwitch("ACTIVATE");

      const result = await adapter.modifyOrder(placed.orderId, {
        price: 160,
      });
      expect(result.status).toBe("REJECTED");
      expect(result.message).toContain("Kill switch");
    });

    it("exits all positions on activation", async () => {
      // Open positions
      await adapter.placeOrder(sampleBuyOrder());
      await adapter.placeOrder(
        sampleBuyOrder({ instrument: "BANK_NIFTY", strike: 55000 })
      );

      const openBefore = await adapter.getOpenPositions();
      expect(openBefore.length).toBe(2);

      // Activate kill switch
      const result = await adapter.killSwitch("ACTIVATE");
      expect(result.status).toBe("activated");
      expect(result.message).toContain("2 position(s) closed");

      const openAfter = await adapter.getOpenPositions();
      expect(openAfter.length).toBe(0);
    });

    it("resumes trading after deactivation", async () => {
      await adapter.killSwitch("ACTIVATE");
      expect(adapter.isKillSwitchActive()).toBe(true);

      const deactivateResult = await adapter.killSwitch("DEACTIVATE");
      expect(deactivateResult.status).toBe("deactivated");
      expect(adapter.isKillSwitchActive()).toBe(false);

      // Should be able to place orders again
      const orderResult = await adapter.placeOrder(sampleBuyOrder());
      expect(orderResult.status).toBe("FILLED");
    });
  });

  // ── Order Status ──────────────────────────────────────────────

  describe("Order Status", () => {
    it("returns order details by orderId", async () => {
      const placed = await adapter.placeOrder(sampleBuyOrder());
      const order = await adapter.getOrderStatus(placed.orderId);

      expect(order.orderId).toBe(placed.orderId);
      expect(order.instrument).toBe("NIFTY_50");
      expect(order.status).toBe("FILLED");
      expect(order.quantity).toBe(50);
      expect(order.averagePrice).toBe(150);
    });

    it("throws for non-existent orderId", async () => {
      await expect(adapter.getOrderStatus("FAKE-ID")).rejects.toThrow(
        "not found"
      );
    });
  });

  // ── Market Data (Mock) ────────────────────────────────────────

  describe("Market Data", () => {
    it("returns sample scrip master", async () => {
      const instruments = await adapter.getScripMaster("NSE_FNO");
      expect(instruments.length).toBeGreaterThan(0);
      expect(instruments[0].securityId).toMatch(/^MOCK-/);
      expect(instruments[0].lotSize).toBeGreaterThan(0);
    });

    it("returns sample expiry list", async () => {
      const expiries = await adapter.getExpiryList("NIFTY_50");
      expect(expiries.length).toBeGreaterThan(0);
      expect(expiries[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("returns sample option chain", async () => {
      const chain = await adapter.getOptionChain("NIFTY_50", "2026-04-03");
      expect(chain.underlying).toBe("NIFTY_50");
      expect(chain.expiry).toBe("2026-04-03");
      expect(chain.rows.length).toBeGreaterThan(0);
      expect(chain.spotPrice).toBeGreaterThan(0);

      const row = chain.rows[0];
      expect(row).toHaveProperty("strike");
      expect(row).toHaveProperty("callOI");
      expect(row).toHaveProperty("putOI");
      expect(row).toHaveProperty("callLTP");
      expect(row).toHaveProperty("putLTP");
    });
  });

  // ── Charts / Historical Data (Mock) ───────────────────

  describe("Intraday Data", () => {
    it("returns candle data with correct shape", async () => {
      const data = await adapter.getIntradayData({
        securityId: "13",
        exchangeSegment: "IDX_I",
        instrument: "INDEX",
        interval: "5",
        fromDate: "2026-04-04 09:15:00",
        toDate: "2026-04-04 15:30:00",
      });

      expect(data.open.length).toBeGreaterThan(0);
      expect(data.high.length).toBe(data.open.length);
      expect(data.low.length).toBe(data.open.length);
      expect(data.close.length).toBe(data.open.length);
      expect(data.volume.length).toBe(data.open.length);
      expect(data.timestamp.length).toBe(data.open.length);
    });

    it("includes open interest when oi=true", async () => {
      const data = await adapter.getIntradayData({
        securityId: "13",
        exchangeSegment: "IDX_I",
        instrument: "INDEX",
        interval: "15",
        fromDate: "2026-04-04 09:15:00",
        toDate: "2026-04-04 15:30:00",
        oi: true,
      });

      expect(data.openInterest).toBeDefined();
      expect(data.openInterest!.length).toBe(data.open.length);
    });

    it("omits open interest when oi is not set", async () => {
      const data = await adapter.getIntradayData({
        securityId: "13",
        exchangeSegment: "IDX_I",
        instrument: "INDEX",
        interval: "1",
        fromDate: "2026-04-04 09:15:00",
        toDate: "2026-04-04 15:30:00",
      });

      expect(data.openInterest).toBeUndefined();
    });

    it("returns valid OHLCV values", async () => {
      const data = await adapter.getIntradayData({
        securityId: "13",
        exchangeSegment: "IDX_I",
        instrument: "INDEX",
        interval: "5",
        fromDate: "2026-04-04 09:15:00",
        toDate: "2026-04-04 15:30:00",
      });

      for (let i = 0; i < data.open.length; i++) {
        expect(data.high[i]).toBeGreaterThanOrEqual(data.low[i]);
        expect(data.volume[i]).toBeGreaterThan(0);
        expect(data.timestamp[i]).toBeGreaterThan(0);
      }
    });
  });

  describe("Historical Data", () => {
    it("returns daily candle data with correct shape", async () => {
      const data = await adapter.getHistoricalData({
        securityId: "13",
        exchangeSegment: "IDX_I",
        instrument: "INDEX",
        fromDate: "2026-03-01",
        toDate: "2026-04-01",
      });

      expect(data.open.length).toBeGreaterThan(0);
      expect(data.high.length).toBe(data.open.length);
      expect(data.low.length).toBe(data.open.length);
      expect(data.close.length).toBe(data.open.length);
      expect(data.volume.length).toBe(data.open.length);
      expect(data.timestamp.length).toBe(data.open.length);
    });

    it("includes open interest when oi=true", async () => {
      const data = await adapter.getHistoricalData({
        securityId: "13",
        exchangeSegment: "IDX_I",
        instrument: "INDEX",
        fromDate: "2026-03-01",
        toDate: "2026-04-01",
        oi: true,
      });

      expect(data.openInterest).toBeDefined();
      expect(data.openInterest!.length).toBe(data.open.length);
    });

    it("supports expiryCode parameter", async () => {
      const data = await adapter.getHistoricalData({
        securityId: "13",
        exchangeSegment: "NSE_FNO",
        instrument: "FUTIDX",
        fromDate: "2026-03-01",
        toDate: "2026-04-01",
        expiryCode: 1,
      });

      expect(data.open.length).toBeGreaterThan(0);
    });

    it("returns valid OHLCV values", async () => {
      const data = await adapter.getHistoricalData({
        securityId: "13",
        exchangeSegment: "IDX_I",
        instrument: "INDEX",
        fromDate: "2026-03-01",
        toDate: "2026-04-01",
      });

      for (let i = 0; i < data.open.length; i++) {
        expect(data.high[i]).toBeGreaterThanOrEqual(data.low[i]);
        expect(data.volume[i]).toBeGreaterThan(0);
        expect(data.timestamp[i]).toBeGreaterThan(0);
      }
    });

    it("timestamps are in ascending order", async () => {
      const data = await adapter.getHistoricalData({
        securityId: "13",
        exchangeSegment: "IDX_I",
        instrument: "INDEX",
        fromDate: "2026-03-01",
        toDate: "2026-04-01",
      });

      for (let i = 1; i < data.timestamp.length; i++) {
        expect(data.timestamp[i]).toBeGreaterThan(data.timestamp[i - 1]);
      }
    });
  });

  // ── Transform Candle Data ───────────────────────────────────

  describe("transformCandleData (CSV output)", () => {
    it("returns a CSV string with header row for intraday", async () => {
      const data = await adapter.getIntradayData({
        securityId: "13",
        exchangeSegment: "IDX_I",
        instrument: "INDEX",
        interval: "5",
        fromDate: "2026-04-04 09:15:00",
        toDate: "2026-04-04 15:30:00",
      });

      const csv = transformCandleData(data, "intraday");

      expect(typeof csv).toBe("string");
      const lines = csv.split("\n");
      expect(lines[0]).toBe("time,open,high,low,close,volume");
      // Data rows = total lines - 1 header
      expect(lines.length - 1).toBe(data.timestamp.length);
      // Intraday time format: YYYY-MM-DD HH:mm
      expect(lines[1].split(",")[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it("returns a CSV string with header row for historical", async () => {
      const data = await adapter.getHistoricalData({
        securityId: "13",
        exchangeSegment: "IDX_I",
        instrument: "INDEX",
        fromDate: "2026-03-01",
        toDate: "2026-04-01",
      });

      const csv = transformCandleData(data, "historical");
      const lines = csv.split("\n");

      expect(lines[0]).toBe("time,open,high,low,close,volume");
      // Historical time format: YYYY-MM-DD
      expect(lines[1].split(",")[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("CSV rows are sorted ascending by time", async () => {
      const data = await adapter.getIntradayData({
        securityId: "13",
        exchangeSegment: "IDX_I",
        instrument: "INDEX",
        interval: "5",
        fromDate: "2026-04-04 09:15:00",
        toDate: "2026-04-04 15:30:00",
      });

      const csv = transformCandleData(data, "intraday");
      const lines = csv.split("\n");
      const dataLines = lines.slice(1);

      for (let i = 1; i < dataLines.length; i++) {
        const prevTime = dataLines[i - 1].split(",")[0];
        const currTime = dataLines[i].split(",")[0];
        expect(currTime >= prevTime).toBe(true);
      }
    });

    it("includes openInterest column in header and data when oi=true", async () => {
      const data = await adapter.getIntradayData({
        securityId: "49081",
        exchangeSegment: "NSE_FNO",
        instrument: "FUTIDX",
        interval: "5",
        fromDate: "2026-04-04 09:15:00",
        toDate: "2026-04-04 15:30:00",
        oi: true,
      });

      const csv = transformCandleData(data, "intraday");
      const lines = csv.split("\n");

      expect(lines[0]).toBe("time,open,high,low,close,volume,openInterest");
      // Data row should have 7 columns
      expect(lines[1].split(",").length).toBe(7);
    });

    it("omits openInterest column when oi=false", async () => {
      const data = await adapter.getIntradayData({
        securityId: "13",
        exchangeSegment: "IDX_I",
        instrument: "INDEX",
        interval: "5",
        fromDate: "2026-04-04 09:15:00",
        toDate: "2026-04-04 15:30:00",
        oi: false,
      });

      const csv = transformCandleData(data, "intraday");
      const lines = csv.split("\n");

      expect(lines[0]).toBe("time,open,high,low,close,volume");
      // Data row should have 6 columns
      expect(lines[1].split(",").length).toBe(6);
    });

    it("each data row has valid numeric values", async () => {
      const data = await adapter.getIntradayData({
        securityId: "13",
        exchangeSegment: "IDX_I",
        instrument: "INDEX",
        interval: "5",
        fromDate: "2026-04-04 09:15:00",
        toDate: "2026-04-04 15:30:00",
      });

      const csv = transformCandleData(data, "intraday");
      const lines = csv.split("\n");
      const firstDataRow = lines[1].split(",");

      // open, high, low, close, volume should all be valid numbers
      for (let i = 1; i < firstDataRow.length; i++) {
        expect(Number.isNaN(Number(firstDataRow[i]))).toBe(false);
      }
    });
  });

  // ── Order Update Callbacks ────────────────────────────────────

  describe("Order Update Callbacks", () => {
    it("fires callback on order fill", async () => {
      const updates: any[] = [];
      adapter.onOrderUpdate((update) => updates.push(update));

      await adapter.placeOrder(sampleBuyOrder());

      expect(updates.length).toBe(1);
      expect(updates[0].status).toBe("FILLED");
      expect(updates[0].filledQuantity).toBe(50);
    });
  });

  // ── Reset ─────────────────────────────────────────────────────

  describe("Reset", () => {
    it("clears all state on reset", async () => {
      await adapter.placeOrder(sampleBuyOrder());
      await adapter.killSwitch("ACTIVATE");

      adapter.reset();

      expect(adapter.isKillSwitchActive()).toBe(false);
      const orders = await adapter.getOrderBook();
      expect(orders.length).toBe(0);
      const positions = await adapter.getPositions();
      expect(positions.length).toBe(0);
      const margin = await adapter.getMargin();
      expect(margin.available).toBe(500000);
    });

    it("accepts custom initial margin on reset", async () => {
      adapter.reset(1000000);
      const margin = await adapter.getMargin();
      expect(margin.total).toBe(1000000);
      expect(margin.available).toBe(1000000);
    });
  });
});
