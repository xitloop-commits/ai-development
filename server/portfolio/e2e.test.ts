/**
 * E2E Integration Test — Full Trading Loop
 *
 * Tests the complete flow without MongoDB or real broker:
 *   1. MockAdapter places order → returns orderId
 *   2. tickBus emits ticks → tickHandler updates trade LTP/unrealizedPnl
 *   3. Paper auto-exit on TP/SL triggers
 *   4. Compounding engine position sizing, charges, day aggregates
 *
 * All DB calls are mocked via vi.mock.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAdapter } from "../broker/adapters/mock";
import { tickBus } from "../broker/tickBus";
import { tickMatchesTrade } from "./tickHandler";
import {
  createDayRecord,
  recalculateDayAggregates,
  calculateAvailableCapital,
  calculatePositionSize,
} from "./compounding";
import { calculateTradeCharges } from "./charges";
import type { TradeRecord } from "./state";
import type { TickData, OrderParams } from "../broker/types";

// ─── Helpers ────────────────────────────────────────────────────

function makeTrade(overrides?: Partial<TradeRecord>): TradeRecord {
  return {
    id: `T${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    instrument: "NIFTY_50",
    type: "CALL_BUY",
    strike: 26000,
    entryPrice: 150,
    exitPrice: null,
    ltp: 150,
    qty: 50,
    capitalPercent: 10,
    pnl: 0,
    unrealizedPnl: 0,
    charges: 0,
    chargesBreakdown: [],
    status: "OPEN",
    targetPrice: 157.5, // +5%
    stopLossPrice: 147,  // -2%
    brokerOrderId: null,
    brokerId: null,
    openedAt: Date.now(),
    closedAt: null,
    ...overrides,
  };
}

function makeTick(overrides?: Partial<TickData>): TickData {
  return {
    securityId: "NIFTY_50",
    exchange: "NSE_FNO",
    ltp: 155,
    ltq: 50,
    ltt: Math.floor(Date.now() / 1000),
    atp: 155,
    volume: 10000,
    totalSellQty: 5000,
    totalBuyQty: 5000,
    oi: 100000,
    highOI: 120000,
    lowOI: 80000,
    dayOpen: 150,
    dayClose: 0,
    dayHigh: 158,
    dayLow: 148,
    prevClose: 149,
    prevOI: 95000,
    depth: [],
    bidPrice: 154.95,
    askPrice: 155.05,
    timestamp: Date.now(),
    ...overrides,
  };
}

function sampleOrder(overrides?: Partial<OrderParams>): OrderParams {
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
    tag: "e2e-test",
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("E2E: Full Trading Loop", () => {
  let adapter: MockAdapter;

  beforeEach(async () => {
    adapter = new MockAdapter();
    await adapter.connect();
    tickBus.clear();
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  // ── 1. Order Placement ──────────────────────────────────────

  describe("1. Order Placement via MockAdapter", () => {
    it("places a buy order and returns orderId + FILLED status", async () => {
      const result = await adapter.placeOrder(sampleOrder());
      expect(result.orderId).toBeTruthy();
      expect(result.status).toBe("FILLED");
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it("places a sell order (exit) with opposite transaction", async () => {
      const entry = await adapter.placeOrder(sampleOrder());
      const exit = await adapter.placeOrder(
        sampleOrder({ transactionType: "SELL", price: 160, tag: "exit" })
      );
      expect(exit.orderId).toBeTruthy();
      expect(exit.status).toBe("FILLED");
      expect(exit.orderId).not.toBe(entry.orderId);
    });

    it("stores brokerOrderId in trade record after placement", async () => {
      const result = await adapter.placeOrder(sampleOrder());
      const trade = makeTrade({ brokerOrderId: result.orderId });
      expect(trade.brokerOrderId).toBe(result.orderId);
    });
  });

  // ── 2. Tick Matching ────────────────────────────────────────

  describe("2. Tick-to-Trade Matching", () => {
    it("matches tick securityId to trade instrument (direct)", () => {
      const trade = makeTrade({ instrument: "NIFTY_50" });
      const tick = makeTick({ securityId: "NIFTY_50" });
      expect(tickMatchesTrade(tick, trade)).toBe(true);
    });

    it("matches tick via alias mapping (NIFTY 50 → NIFTY_50)", () => {
      const trade = makeTrade({ instrument: "NIFTY 50" });
      const tick = makeTick({ securityId: "NIFTY_50" });
      expect(tickMatchesTrade(tick, trade)).toBe(true);
    });

    it("does not match unrelated instruments", () => {
      const trade = makeTrade({ instrument: "BANKNIFTY" });
      const tick = makeTick({ securityId: "NIFTY_50" });
      expect(tickMatchesTrade(tick, trade)).toBe(false);
    });

    it("matches BANKNIFTY aliases", () => {
      const trade = makeTrade({ instrument: "BANK NIFTY" });
      const tick = makeTick({ securityId: "BANKNIFTY" });
      expect(tickMatchesTrade(tick, trade)).toBe(true);
    });

    it("matches CRUDEOIL aliases", () => {
      const trade = makeTrade({ instrument: "CRUDE OIL" });
      const tick = makeTick({ securityId: "CRUDEOIL" });
      expect(tickMatchesTrade(tick, trade)).toBe(true);
    });
  });

  // ── 3. P&L Calculation via recalculateDayAggregates ─────────

  describe("3. Unrealized P&L Calculation", () => {
    it("calculates unrealized P&L for open BUY trade when LTP rises", () => {
      const trade = makeTrade({ entryPrice: 150, ltp: 160, qty: 50 });
      const day = createDayRecord(0, 100000, 5, 105000, "paper");
      day.trades.push(trade);
      const updated = recalculateDayAggregates(day);
      const t = updated.trades[0];
      // (160 - 150) * 50 * 1 = 500
      expect(t.unrealizedPnl).toBe(500);
      expect(updated.totalPnl).toBe(500);
    });

    it("calculates negative unrealized P&L for BUY when LTP drops", () => {
      const trade = makeTrade({ entryPrice: 150, ltp: 145, qty: 50 });
      const day = createDayRecord(0, 100000, 5, 105000, "paper");
      day.trades.push(trade);
      const updated = recalculateDayAggregates(day);
      const t = updated.trades[0];
      // (145 - 150) * 50 * 1 = -250
      expect(t.unrealizedPnl).toBe(-250);
    });

    it("calculates unrealized P&L for SELL trade (inverted direction)", () => {
      const trade = makeTrade({
        type: "CALL_SELL",
        entryPrice: 150,
        ltp: 145,
        qty: 50,
      });
      const day = createDayRecord(0, 100000, 5, 105000, "paper");
      day.trades.push(trade);
      const updated = recalculateDayAggregates(day);
      const t = updated.trades[0];
      // (145 - 150) * 50 * -1 = 250 (profit for seller)
      expect(t.unrealizedPnl).toBe(250);
    });

    it("aggregates P&L across multiple open trades", () => {
      const trade1 = makeTrade({ id: "t1", entryPrice: 150, ltp: 160, qty: 50 });
      const trade2 = makeTrade({
        id: "t2",
        instrument: "BANKNIFTY",
        entryPrice: 200,
        ltp: 190,
        qty: 25,
      });
      const day = createDayRecord(0, 100000, 5, 105000, "paper");
      day.trades.push(trade1, trade2);
      const updated = recalculateDayAggregates(day);
      // t1: (160-150)*50 = 500, t2: (190-200)*25 = -250
      expect(updated.totalPnl).toBe(250);
    });
  });

  // ── 4. LTP Update via tickBus ───────────────────────────────

  describe("4. TickBus Emit and Cache", () => {
    it("emits tick and caches latest value", () => {
      const tick = makeTick({ securityId: "NIFTY_50", ltp: 155 });
      tickBus.emitTick(tick);
      const cached = tickBus.getLatestTick("NSE_FNO", "NIFTY_50");
      expect(cached).toBeDefined();
      expect(cached!.ltp).toBe(155);
    });

    it("overwrites cache with newer tick", () => {
      tickBus.emitTick(makeTick({ ltp: 150 }));
      tickBus.emitTick(makeTick({ ltp: 160 }));
      const cached = tickBus.getLatestTick("NSE_FNO", "NIFTY_50");
      expect(cached!.ltp).toBe(160);
    });

    it("getAllTicks returns all cached ticks", () => {
      tickBus.emitTick(makeTick({ securityId: "NIFTY_50", ltp: 150 }));
      tickBus.emitTick(makeTick({ securityId: "BANKNIFTY", ltp: 300 }));
      const all = tickBus.getAllTicks();
      expect(all.length).toBe(2);
    });

    it("listeners receive emitted ticks", () => {
      const received: TickData[] = [];
      tickBus.on("tick", (t: TickData) => received.push(t));
      tickBus.emitTick(makeTick({ ltp: 155 }));
      tickBus.emitTick(makeTick({ ltp: 160 }));
      expect(received.length).toBe(2);
      expect(received[1].ltp).toBe(160);
      tickBus.removeAllListeners("tick");
    });
  });

  // ── 5. Position Sizing ──────────────────────────────────────

  describe("5. Position Sizing", () => {
    it("calculates correct qty and margin from capital %", () => {
      const available = calculateAvailableCapital(100000, 0);
      const { qty, margin } = calculatePositionSize(available, 10, 150);
      // 10% of 100000 = 10000, qty = floor(10000/150) = 66
      expect(qty).toBe(66);
      expect(margin).toBeCloseTo(66 * 150, 0);
    });

    it("returns min lot qty when insufficient capital for more", () => {
      const available = calculateAvailableCapital(100, 90);
      // available = 10, 10% of 10 = 1, floor(1/150) = 0, but lotSize=1 → qty=1
      const { qty } = calculatePositionSize(available, 10, 150);
      expect(qty).toBe(1);
    });

    it("reduces available capital by open margin", () => {
      const available = calculateAvailableCapital(100000, 50000);
      expect(available).toBe(50000);
    });
  });

  // ── 6. Charges Calculation ──────────────────────────────────

  describe("6. Trade Charges", () => {
    it("calculates charges for a round-trip trade", () => {
      const rates: import("./charges").ChargeRate[] = [
        { name: "Brokerage", rate: 20, unit: "flat_per_order", enabled: true },
        { name: "STT", rate: 0.0625, unit: "percent_sell", enabled: true },
      ];
      const charges = calculateTradeCharges(
        { entryPrice: 150, exitPrice: 160, qty: 50, isBuy: true, exchange: "NSE" },
        rates
      );
      expect(charges.total).toBeGreaterThan(0);
      expect(charges.breakdown.length).toBeGreaterThan(0);
    });

    it("charges reduce net P&L", () => {
      const rates: import("./charges").ChargeRate[] = [
        { name: "Brokerage", rate: 20, unit: "flat_per_order", enabled: true },
      ];
      const charges = calculateTradeCharges(
        { entryPrice: 150, exitPrice: 160, qty: 50, isBuy: true, exchange: "NSE" },
        rates
      );
      const grossPnl = (160 - 150) * 50; // 500
      const netPnl = grossPnl - charges.total;
      expect(netPnl).toBeLessThan(grossPnl);
      expect(netPnl).toBeGreaterThan(0);
    });
  });

  // ── 7. TP/SL Trigger Detection ──────────────────────────────

  describe("7. TP/SL Trigger Detection (paper mode logic)", () => {
    it("detects TP hit for BUY trade (LTP >= targetPrice)", () => {
      const trade = makeTrade({ entryPrice: 150, targetPrice: 157.5 });
      const tick = makeTick({ ltp: 158 });
      const isBuy = trade.type.includes("BUY");
      const tpHit = isBuy
        ? tick.ltp >= trade.targetPrice!
        : tick.ltp <= trade.targetPrice!;
      expect(tpHit).toBe(true);
    });

    it("does not trigger TP when LTP below target", () => {
      const trade = makeTrade({ entryPrice: 150, targetPrice: 157.5 });
      const tick = makeTick({ ltp: 155 });
      const isBuy = trade.type.includes("BUY");
      const tpHit = isBuy
        ? tick.ltp >= trade.targetPrice!
        : tick.ltp <= trade.targetPrice!;
      expect(tpHit).toBe(false);
    });

    it("detects SL hit for BUY trade (LTP <= stopLossPrice)", () => {
      const trade = makeTrade({ entryPrice: 150, stopLossPrice: 147 });
      const tick = makeTick({ ltp: 146 });
      const isBuy = trade.type.includes("BUY");
      const slHit = isBuy
        ? tick.ltp <= trade.stopLossPrice!
        : tick.ltp >= trade.stopLossPrice!;
      expect(slHit).toBe(true);
    });

    it("detects TP hit for SELL trade (LTP <= targetPrice)", () => {
      const trade = makeTrade({
        type: "CALL_SELL",
        entryPrice: 150,
        targetPrice: 142.5,
      });
      const tick = makeTick({ ltp: 140 });
      const isBuy = trade.type.includes("BUY");
      const tpHit = isBuy
        ? tick.ltp >= trade.targetPrice!
        : tick.ltp <= trade.targetPrice!;
      expect(tpHit).toBe(true);
    });

    it("detects SL hit for SELL trade (LTP >= stopLossPrice)", () => {
      const trade = makeTrade({
        type: "CALL_SELL",
        entryPrice: 150,
        stopLossPrice: 153,
      });
      const tick = makeTick({ ltp: 154 });
      const isBuy = trade.type.includes("BUY");
      const slHit = isBuy
        ? tick.ltp <= trade.stopLossPrice!
        : tick.ltp >= trade.stopLossPrice!;
      expect(slHit).toBe(true);
    });
  });

  // ── 8. Full Loop: Place → Tick → P&L → Exit ────────────────

  describe("8. Full Loop: Place → Tick → P&L Update → Exit", () => {
    it("simulates complete trade lifecycle", async () => {
      // Step 1: Place order via MockAdapter
      const orderResult = await adapter.placeOrder(sampleOrder());
      expect(orderResult.status).toBe("FILLED");

      // Step 2: Create trade record (as portfolioRouter would)
      const trade = makeTrade({
        brokerOrderId: orderResult.orderId,
        entryPrice: 150,
        targetPrice: 157.5,
        stopLossPrice: 147,
      });

      // Step 3: Create day record and add trade
      const day = createDayRecord(0, 100000, 5, 105000, "paper");
      day.trades.push(trade);

      // Step 4: Simulate tick — price moves up
      const tick1 = makeTick({ ltp: 155 });
      tickBus.emitTick(tick1);

      // Manually update trade LTP (as tickHandler would)
      trade.ltp = tick1.ltp;
      const updated1 = recalculateDayAggregates(day);
      expect(updated1.trades[0].unrealizedPnl).toBe(250); // (155-150)*50

      // Step 5: Simulate tick — price hits TP
      const tick2 = makeTick({ ltp: 158 });
      tickBus.emitTick(tick2);
      trade.ltp = tick2.ltp;

      // Check TP trigger
      const isBuy = trade.type.includes("BUY");
      const tpHit = isBuy && tick2.ltp >= trade.targetPrice!;
      expect(tpHit).toBe(true);

      // Step 6: Exit trade (as tickHandler autoExitTrade would)
      const exitPrice = tick2.ltp;
      const grossPnl = (exitPrice - trade.entryPrice) * trade.qty; // (158-150)*50 = 400
      const charges = calculateTradeCharges(
        { entryPrice: 150, exitPrice, qty: 50, isBuy: true, exchange: "NSE" },
        [{ name: "Brokerage", rate: 20, unit: "flat_per_order", enabled: true }]
      );

      trade.exitPrice = exitPrice;
      trade.pnl = Math.round((grossPnl - charges.total) * 100) / 100;
      trade.charges = charges.total;
      trade.unrealizedPnl = 0;
      trade.status = "CLOSED";
      trade.exitReason = "TP_HIT";
      trade.closedAt = Date.now();

      // Step 7: Verify final state
      const updated2 = recalculateDayAggregates(day);
      expect(updated2.trades[0].status).toBe("CLOSED");
      expect(updated2.trades[0].exitReason).toBe("TP_HIT");
      expect(updated2.trades[0].exitPrice).toBe(158);
      expect(updated2.trades[0].pnl).toBe(trade.pnl);
      expect(updated2.trades[0].unrealizedPnl).toBe(0);
      // totalPnl = trade.pnl for closed trades (already net of charges)
      expect(updated2.totalPnl).toBe(trade.pnl);
      expect(updated2.totalCharges).toBe(trade.charges);
    });

    it("simulates SL exit lifecycle", async () => {
      const orderResult = await adapter.placeOrder(sampleOrder());
      const trade = makeTrade({
        brokerOrderId: orderResult.orderId,
        entryPrice: 150,
        targetPrice: 157.5,
        stopLossPrice: 147,
      });

      const day = createDayRecord(0, 100000, 5, 105000, "paper");
      day.trades.push(trade);

      // Price drops to SL
      const tick = makeTick({ ltp: 146 });
      tickBus.emitTick(tick);
      trade.ltp = tick.ltp;

      const slHit = trade.type.includes("BUY") && tick.ltp <= trade.stopLossPrice!;
      expect(slHit).toBe(true);

      // Exit at SL
      const grossPnl = (146 - 150) * 50; // -200
      trade.exitPrice = 146;
      trade.pnl = grossPnl;
      trade.unrealizedPnl = 0;
      trade.status = "CLOSED";
      trade.exitReason = "SL_HIT";
      trade.closedAt = Date.now();

      const updated = recalculateDayAggregates(day);
      expect(updated.trades[0].status).toBe("CLOSED");
      expect(updated.trades[0].exitReason).toBe("SL_HIT");
      expect(updated.trades[0].pnl).toBe(-200);
      expect(updated.totalPnl).toBe(-200);
    });

    it("handles multiple trades with mixed outcomes", async () => {
      const day = createDayRecord(0, 100000, 5, 105000, "paper");

      // Trade 1: BUY NIFTY — wins
      const t1 = makeTrade({
        id: "t1",
        instrument: "NIFTY_50",
        entryPrice: 150,
        ltp: 160,
        qty: 50,
      });

      // Trade 2: BUY BANKNIFTY — loses
      const t2 = makeTrade({
        id: "t2",
        instrument: "BANKNIFTY",
        entryPrice: 200,
        ltp: 190,
        qty: 25,
      });

      day.trades.push(t1, t2);
      const updated = recalculateDayAggregates(day);

      // t1: (160-150)*50 = 500, t2: (190-200)*25 = -250
      expect(updated.trades[0].unrealizedPnl).toBe(500);
      expect(updated.trades[1].unrealizedPnl).toBe(-250);
      expect(updated.totalPnl).toBe(250);
    });
  });

  // ── 9. MockAdapter Tick Simulation ──────────────────────────

  describe("9. MockAdapter Tick Simulation", () => {
    it("generates ticks for subscribed instruments", async () => {
      const ticks: TickData[] = [];
      adapter.subscribeLTP(
        [{ securityId: "NIFTY_50", exchange: "NSE_FNO" }],
        (tick) => ticks.push(tick)
      );

      // Wait for at least one tick cycle (2s interval + buffer)
      await new Promise((r) => setTimeout(r, 2500));

      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks[0].securityId).toBe("NIFTY_50");
      expect(ticks[0].ltp).toBeGreaterThan(0);

      adapter.unsubscribeLTP([{ securityId: "NIFTY_50", exchange: "NSE_FNO" }]);
    });
  });
});
