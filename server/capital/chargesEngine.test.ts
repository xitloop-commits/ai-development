/**
 * Charges Engine — Unit Tests
 *
 * Tests the pure charge calculation functions without MongoDB.
 * Covers all 5 charge unit types and round-trip vs single-leg scenarios.
 */
import { describe, expect, it } from "vitest";
import {
  calculateTradeCharges,
  estimateSingleLegCharges,
  type ChargeRate,
  type TradeParams,
} from "./chargesEngine";

// ─── Default Rates (mirrors DEFAULT_CHARGES from userSettings) ──

const DEFAULT_RATES: ChargeRate[] = [
  { name: "Brokerage", rate: 20, unit: "flat_per_order", enabled: true },
  { name: "STT", rate: 0.0625, unit: "percent_sell", enabled: true },
  { name: "Exchange Txn Charges", rate: 0.053, unit: "percent", enabled: true },
  { name: "GST", rate: 18, unit: "percent_on_brokerage", enabled: true },
  { name: "SEBI Charges", rate: 0.0001, unit: "percent", enabled: true },
  { name: "Stamp Duty", rate: 0.003, unit: "percent_buy", enabled: true },
];

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Round-Trip Charges ─────────────────────────────────────────

describe("calculateTradeCharges — Round Trip", () => {
  it("should calculate all charge types for a buy trade", () => {
    const trade: TradeParams = {
      entryPrice: 150,
      exitPrice: 170,
      qty: 50,
      isBuy: true,
      exchange: "NSE",
    };

    const result = calculateTradeCharges(trade, DEFAULT_RATES);

    expect(result.total).toBeGreaterThan(0);
    expect(result.breakdown.length).toBeGreaterThan(0);

    // Verify brokerage: flat_per_order * 2 (entry + exit)
    const brokerage = result.breakdown.find((b) => b.name === "Brokerage");
    expect(brokerage?.amount).toBe(40); // 20 * 2

    // Verify STT: percent_sell on sell turnover
    // Sell turnover for BUY trade = exitPrice * qty = 170 * 50 = 8500
    const stt = result.breakdown.find((b) => b.name === "STT");
    expect(stt?.amount).toBe(round(8500 * 0.0625 / 100));
  });

  it("should calculate charges for a sell trade", () => {
    const trade: TradeParams = {
      entryPrice: 170,
      exitPrice: 150,
      qty: 50,
      isBuy: false,
      exchange: "NSE",
    };

    const result = calculateTradeCharges(trade, DEFAULT_RATES);

    // For SELL trade: sell turnover = entryPrice * qty = 170 * 50 = 8500
    const stt = result.breakdown.find((b) => b.name === "STT");
    expect(stt?.amount).toBe(round(8500 * 0.0625 / 100));
  });

  it("should calculate GST on brokerage + exchange txn", () => {
    const trade: TradeParams = {
      entryPrice: 200,
      exitPrice: 220,
      qty: 100,
      isBuy: true,
      exchange: "NSE",
    };

    const result = calculateTradeCharges(trade, DEFAULT_RATES);

    // Brokerage = 40 (flat * 2)
    // Total turnover = (200*100) + (220*100) = 42000
    // Exchange Txn = 42000 * 0.053% = 22.26
    // GST = (40 + 22.26) * 18% = 11.21
    const gst = result.breakdown.find((b) => b.name === "GST");
    expect(gst).toBeDefined();
    expect(gst!.amount).toBeGreaterThan(0);

    // Verify GST is calculated on brokerage + exchange txn
    const brokerage = result.breakdown.find((b) => b.name === "Brokerage")!.amount;
    const exchangeTxn = result.breakdown.find((b) => b.name === "Exchange Txn Charges")!.amount;
    const expectedGst = round((brokerage + exchangeTxn) * 18 / 100);
    expect(gst!.amount).toBe(expectedGst);
  });

  it("should handle stamp duty on buy side only", () => {
    const trade: TradeParams = {
      entryPrice: 200,
      exitPrice: 220,
      qty: 100,
      isBuy: true,
      exchange: "NSE",
    };

    const result = calculateTradeCharges(trade, DEFAULT_RATES);

    // Buy turnover = 200 * 100 = 20000
    const stamp = result.breakdown.find((b) => b.name === "Stamp Duty");
    expect(stamp?.amount).toBe(round(20000 * 0.003 / 100));
  });

  it("should skip disabled charges", () => {
    const rates: ChargeRate[] = [
      { name: "Brokerage", rate: 20, unit: "flat_per_order", enabled: true },
      { name: "STT", rate: 0.0625, unit: "percent_sell", enabled: false },
    ];

    const trade: TradeParams = {
      entryPrice: 150,
      exitPrice: 170,
      qty: 50,
      isBuy: true,
      exchange: "NSE",
    };

    const result = calculateTradeCharges(trade, rates);
    const stt = result.breakdown.find((b) => b.name === "STT");
    expect(stt).toBeUndefined();
  });

  it("should return zero for empty rates", () => {
    const trade: TradeParams = {
      entryPrice: 150,
      exitPrice: 170,
      qty: 50,
      isBuy: true,
      exchange: "NSE",
    };

    const result = calculateTradeCharges(trade, []);
    expect(result.total).toBe(0);
    expect(result.breakdown.length).toBe(0);
  });
});

// ─── Single Leg Estimation ──────────────────────────────────────

describe("estimateSingleLegCharges", () => {
  it("should estimate buy-side charges", () => {
    const result = estimateSingleLegCharges(200, 100, true, DEFAULT_RATES);

    // Brokerage: 20 (flat per order, single leg)
    const brokerage = result.breakdown.find((b) => b.name === "Brokerage");
    expect(brokerage?.amount).toBe(20);

    // STT: percent_sell — should be 0 for buy side
    const stt = result.breakdown.find((b) => b.name === "STT");
    expect(stt).toBeUndefined(); // STT is sell-only, so 0 → not included

    // Stamp Duty: percent_buy — should be present
    const stamp = result.breakdown.find((b) => b.name === "Stamp Duty");
    expect(stamp?.amount).toBe(round(20000 * 0.003 / 100));
  });

  it("should estimate sell-side charges", () => {
    const result = estimateSingleLegCharges(200, 100, false, DEFAULT_RATES);

    // STT: percent_sell — should be present for sell side
    const stt = result.breakdown.find((b) => b.name === "STT");
    expect(stt?.amount).toBe(round(20000 * 0.0625 / 100));

    // Stamp Duty: percent_buy — should be 0 for sell side
    const stamp = result.breakdown.find((b) => b.name === "Stamp Duty");
    expect(stamp).toBeUndefined(); // buy-only, so 0 → not included
  });

  it("should be roughly half of round-trip charges", () => {
    const buyLeg = estimateSingleLegCharges(200, 100, true, DEFAULT_RATES);
    const sellLeg = estimateSingleLegCharges(200, 100, false, DEFAULT_RATES);
    const roundTrip = calculateTradeCharges(
      { entryPrice: 200, exitPrice: 200, qty: 100, isBuy: true, exchange: "NSE" },
      DEFAULT_RATES
    );

    // Single legs combined should be close to round-trip
    // (Not exact because GST base differs slightly)
    const combined = buyLeg.total + sellLeg.total;
    expect(Math.abs(combined - roundTrip.total)).toBeLessThan(roundTrip.total * 0.15);
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────

describe("Edge Cases", () => {
  it("should handle zero quantity", () => {
    const trade: TradeParams = {
      entryPrice: 200,
      exitPrice: 220,
      qty: 0,
      isBuy: true,
      exchange: "NSE",
    };

    const result = calculateTradeCharges(trade, DEFAULT_RATES);
    // Only brokerage (flat) should be non-zero
    const brokerage = result.breakdown.find((b) => b.name === "Brokerage");
    expect(brokerage?.amount).toBe(40);
  });

  it("should handle very large trades", () => {
    const trade: TradeParams = {
      entryPrice: 50000,
      exitPrice: 51000,
      qty: 1000,
      isBuy: true,
      exchange: "NSE",
    };

    const result = calculateTradeCharges(trade, DEFAULT_RATES);
    expect(result.total).toBeGreaterThan(0);
    expect(result.breakdown.length).toBeGreaterThan(0);
  });

  it("should handle MCX exchange", () => {
    const trade: TradeParams = {
      entryPrice: 6000,
      exitPrice: 6100,
      qty: 100,
      isBuy: true,
      exchange: "MCX",
    };

    // Currently rates are the same for both exchanges
    const result = calculateTradeCharges(trade, DEFAULT_RATES);
    expect(result.total).toBeGreaterThan(0);
  });

  it("should handle unknown charge unit gracefully", () => {
    const rates: ChargeRate[] = [
      { name: "Unknown", rate: 5, unit: "unknown_unit", enabled: true },
    ];

    const trade: TradeParams = {
      entryPrice: 200,
      exitPrice: 220,
      qty: 100,
      isBuy: true,
      exchange: "NSE",
    };

    const result = calculateTradeCharges(trade, rates);
    // Unknown unit should produce 0
    expect(result.total).toBe(0);
  });
});
