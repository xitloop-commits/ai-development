/**
 * T141 — master SL / TP applies to EVERY instrument.
 *
 * The master block loops over open trades with no instrument filter, so it must
 * fire identically on NIFTY and BANKNIFTY (and any other). This pins that: the
 * same master config closes a NIFTY trade and a BANKNIFTY trade at the same
 * relative level. Guards a future instrument-specific branch from silently
 * exempting one book.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getCapitalStateMock = vi.fn();
const getDayRecordMock = vi.fn();
const upsertDayRecordMock = vi.fn();
const patchTradeInDayMock = vi.fn();
const patchDayAggregatesMock = vi.fn();

vi.mock("./state", async () => {
  const actual = await vi.importActual<typeof import("./state")>("./state");
  return {
    ...actual,
    getCapitalState: (...a: any[]) => getCapitalStateMock(...a),
    getDayRecord: (...a: any[]) => getDayRecordMock(...a),
    upsertDayRecord: (...a: any[]) => upsertDayRecordMock(...a),
    patchTradeInDay: (...a: any[]) => patchTradeInDayMock(...a),
    patchDayAggregates: (...a: any[]) => patchDayAggregatesMock(...a),
  };
});

// Mutable master config the tests flip per-case.
const master: any = {
  tp: { enabled: false, mode: "percent", value: 10 },
  sl: { enabled: false, mode: "percent", value: 10 },
  tsl: { enabled: false, mode: "percent", value: 3 },
};
// Sprint block with % SL/TP modes so resolveNetRsExit returns null (strategy
// not in ₹ mode) — the master is the only thing under test here.
const sprintExit = {
  trailingStopEnabled: false, trailingStopPercent: 2, trailingDistanceSource: "config",
  trailingActivationGatePercent: 2, trailingActivationHoldSeconds: 0, tpTrailPercent: 1.5,
  slMode: "percent", tpMode: "percent", defaultSL: 10, defaultTP: 10, dailyTargetPercent: 5,
};
vi.mock("./aiModeConfig", () => ({
  getExitConfig: () => ({
    sprint: sprintExit, runway: {}, anchor: {},
    glide: { tpEnabled: false, tpMode: "percent", tp: 25, disasterSlPct: 50, giveBackArmPct: 10, giveBackPct: 50 },
  }),
  getCommonConfig: () => ({ lubasManagedExit: true, masterExits: master }),
  getAiConfig: () => ({ strategies: {}, sizing: { perInstrument: {} } }),
}));

vi.mock("../broker/brokerConfig", () => ({ getActiveBrokerConfig: () => Promise.resolve(null) }));
vi.mock("../broker/tickBus", () => ({ tickBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));
vi.mock("../broker/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), important: vi.fn() }),
}));
vi.mock("./compounding", () => ({ recalculateDayAggregates: (d: any) => d }));

import { tickHandler } from "./tickHandler";
import type { TickData } from "../broker/types";

function trade(instrument: string): any {
  return {
    id: `T-${instrument}`, instrument, type: instrument.includes("BANK") ? "PUT_BUY" : "CALL_BUY",
    strike: 100, expiry: "2026-07-28", contractSecurityId: null,
    entryPrice: 100, exitPrice: null, ltp: 100, qty: instrument.includes("BANK") ? 30 : 65,
    status: "OPEN", exitStrategy: "sprint",
    // Benign strategy levels so ONLY the master can close it.
    targetPrice: 500, stopLossPrice: 1, breakevenPrice: 100,
    tslMode: "manual", lastTickAt: null, unrealizedPnl: 0,
  };
}

async function tick(t: any, ltp: number) {
  getDayRecordMock.mockImplementation((ch: string) =>
    Promise.resolve(ch === "paper"
      ? { dayIndex: 1, date: "2026-07-27", trades: [t], totalPnl: 0 }
      : { dayIndex: 1, date: "2026-07-27", trades: [], totalPnl: 0 }),
  );
  tickHandler.clearStateCache();
  const h = tickHandler as any;
  const sid = t.contractSecurityId ?? t.instrument;
  h.pendingUpdates.set(`NSE:${sid}`, { exchange: "NSE", securityId: sid, ltp, timestamp: Date.now() } as TickData);
  await h.processPendingUpdates();
}

async function run(t: any, path: number[]): Promise<{ exited: boolean; reason: string | null; at: number | null }> {
  let ev: any = null;
  const on = (e: any) => { if (!ev) ev = e; };
  tickHandler.on("autoExitDetected", on);
  try { for (const p of path) { await tick(t, p); if (ev) break; } }
  finally { tickHandler.off("autoExitDetected", on); }
  return { exited: !!ev, reason: ev?.reason ?? null, at: ev?.exitPrice ?? null };
}

beforeEach(() => {
  vi.clearAllMocks();
  tickHandler.clearStateCache();
  (tickHandler as any).peakPrices.clear();
  (tickHandler as any).exitingTrades.clear();
  master.tp = { enabled: false, mode: "percent", value: 10 };
  master.sl = { enabled: false, mode: "percent", value: 10 };
  master.tsl = { enabled: false, mode: "percent", value: 3 };
  getCapitalStateMock.mockResolvedValue({
    channel: "paper", tradingPool: 100_000, reservePool: 0, initialFunding: 100_000,
    currentDayIndex: 1, targetPercent: 1, profitHistory: [], cumulativePnl: 0, cumulativeCharges: 0, sessionTradeCount: 0,
  });
});

describe("master exits apply to every instrument", () => {
  for (const inst of ["NIFTY_50", "BANKNIFTY"]) {
    it(`master SL (%) closes a ${inst} trade at the master level`, async () => {
      master.sl.enabled = true; master.sl.value = 10; // long → stop at 90
      const isBuy = !inst.includes("BANK");
      // long stop = 90 (breach below); the BANKNIFTY trade here is a PUT_BUY so
      // still "isBuy" premium-wise — both are BUYs, so both stop below 90.
      const r = await run(trade(inst), isBuy ? [100, 89] : [100, 89]);
      expect(r.exited).toBe(true);
      expect(r.reason).toBe("SL_HIT");
    });

    it(`master TP (%) closes a ${inst} trade at the master level`, async () => {
      master.tp.enabled = true; master.tp.value = 10; // target at 110
      const r = await run(trade(inst), [100, 111]);
      expect(r.exited).toBe(true);
      expect(r.reason).toBe("TP_HIT");
    });
  }

  it("does NOT close either instrument when master is OFF and strategy levels are far", async () => {
    const nifty = await run(trade("NIFTY_50"), [100, 95, 92]);
    const bank = await run(trade("BANKNIFTY"), [100, 95, 92]);
    expect(nifty.exited).toBe(false);
    expect(bank.exited).toBe(false);
  });
});
