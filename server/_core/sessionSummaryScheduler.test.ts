/**
 * Session summary — pure-function tests.
 *
 * computeSummary aggregates closed trades into a single P&L digest;
 * formatSummary renders the Telegram HTML message. Both pure, no Mongo,
 * no Telegram side effects.
 */
import { describe, it, expect } from "vitest";
import { computeSummary, formatSummary } from "./sessionSummaryScheduler";
import type { TradeRecord } from "../portfolio/state";

function trade(partial: Partial<TradeRecord>): TradeRecord {
  return {
    id: "T1",
    instrument: "NIFTY 50",
    type: "CALL_BUY",
    strike: 24000,
    expiry: null,
    contractSecurityId: null,
    entryPrice: 100,
    exitPrice: 110,
    ltp: 110,
    qty: 75,
    capitalPercent: 5,
    pnl: 750,
    unrealizedPnl: 0,
    charges: 50,
    chargesBreakdown: [],
    brokerOrderId: null,
    brokerId: null,
    status: "CLOSED",
    openedAt: 0,
    closedAt: 0,
    ...partial,
  } as TradeRecord;
}

describe("sessionSummaryScheduler — computeSummary", () => {
  it("returns zeros when no trades", () => {
    const s = computeSummary([], 100_000, 100_000);
    expect(s.totalTrades).toBe(0);
    expect(s.netPnl).toBe(0);
    expect(s.netPnlPercent).toBe(0);
    expect(s.bestTrade).toBeNull();
    expect(s.worstTrade).toBeNull();
    expect(s.currentCapital).toBe(100_000);
  });

  it("ignores OPEN / PENDING trades", () => {
    const trades = [
      trade({ id: "T1", pnl: 500, status: "CLOSED" }),
      trade({ id: "T2", pnl: 999, status: "OPEN" }),
      trade({ id: "T3", pnl: 999, status: "PENDING" }),
    ];
    const s = computeSummary(trades, 100_000, 100_500);
    expect(s.totalTrades).toBe(1);
    expect(s.netPnl).toBe(500);
  });

  it("includes EXITED status alongside CLOSED", () => {
    const trades = [
      trade({ id: "T1", pnl: 500, status: "CLOSED" }),
      trade({ id: "T2", pnl: -200, status: "EXITED" as any }),
    ];
    const s = computeSummary(trades, 100_000, 100_300);
    expect(s.totalTrades).toBe(2);
    expect(s.netPnl).toBe(300);
  });

  it("computes wins / losses / breakevens by pnl sign", () => {
    const trades = [
      trade({ id: "T1", pnl: 500 }),
      trade({ id: "T2", pnl: -300 }),
      trade({ id: "T3", pnl: 0 }),
      trade({ id: "T4", pnl: 100 }),
    ];
    const s = computeSummary(trades, 100_000, 100_300);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.breakevens).toBe(1);
  });

  it("identifies best and worst trade", () => {
    const trades = [
      trade({ id: "T1", pnl: 500, instrument: "NIFTY 50" }),
      trade({ id: "T2", pnl: -1200, instrument: "BANK NIFTY" }),
      trade({ id: "T3", pnl: 2500, instrument: "NIFTY 50" }),
    ];
    const s = computeSummary(trades, 100_000, 101_800);
    expect(s.bestTrade?.id).toBe("T3");
    expect(s.bestTrade?.pnl).toBe(2500);
    expect(s.worstTrade?.id).toBe("T2");
    expect(s.worstTrade?.pnl).toBe(-1200);
  });

  it("netPnlPercent guards against zero starting capital", () => {
    const s = computeSummary([trade({ pnl: 500 })], 0, 500);
    expect(s.netPnlPercent).toBe(0);
  });
});

describe("sessionSummaryScheduler — formatSummary", () => {
  it("uses green emoji + plus sign for positive P&L", () => {
    const summary = computeSummary([trade({ pnl: 1500 })], 100_000, 101_500);
    const msg = formatSummary("NSE", summary);
    expect(msg).toContain("🟢");
    expect(msg).toContain("NSE session summary");
    expect(msg).toContain("+₹1,500");
  });

  it("uses red emoji + leading minus for negative P&L", () => {
    const summary = computeSummary([trade({ pnl: -800 })], 100_000, 99_200);
    const msg = formatSummary("MCX", summary);
    expect(msg).toContain("🔴");
    expect(msg).toContain("MCX session summary");
    expect(msg).toContain("-₹800");
  });

  it("includes best + worst trade lines when distinct", () => {
    const trades = [
      trade({ id: "A", pnl: 500, instrument: "NIFTY 50" }),
      trade({ id: "B", pnl: -300, instrument: "BANK NIFTY" }),
    ];
    const summary = computeSummary(trades, 100_000, 100_200);
    const msg = formatSummary("NSE", summary);
    expect(msg).toContain("Best: NIFTY 50");
    expect(msg).toContain("Worst: BANK NIFTY");
  });

  it("collapses Best/Worst when only one trade", () => {
    const summary = computeSummary([trade({ id: "A", pnl: 500 })], 100_000, 100_500);
    const msg = formatSummary("NSE", summary);
    expect(msg).toContain("Best:");
    // single trade → best === worst → worst line omitted
    expect(msg).not.toContain("Worst:");
  });
});
