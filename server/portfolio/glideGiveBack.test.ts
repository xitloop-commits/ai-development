/**
 * T124 — Glide's give-back guard, driven through the REAL tick loop.
 *
 * Glide has no stop, no target and no trailing: it waits for MA-Signal's leg-end
 * EXIT. That exit routinely arrives long after the move is over. Across
 * 2026-07-22/23 its 22 trades reached ₹4,56,745 of peak unrealised profit and
 * booked ₹1,33,824 — 69% handed back — and six trades that were in profit
 * finished as losses. The worst peaked at +₹8,775 and closed at −₹51,550.
 *
 * The guard is deliberately NOT a stop-loss, and every test here exists to hold
 * that line: it can only fire on a trade that HAS worked. A Glide trade that
 * never gets up by `giveBackArmPct` is untouched and still rides to the MA EXIT,
 * so the strategy keeps its character for every trade that has not yet earned
 * anything.
 *
 * Driven through `tickHandler` itself rather than a mirrored copy of the maths —
 * a mirror would keep passing if the real check were deleted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getCapitalStateMock = vi.fn();
const getDayRecordMock = vi.fn();
const upsertDayRecordMock = vi.fn();
const glideCfg: Record<string, number> = {};

vi.mock("./state", async () => {
  const actual = await vi.importActual<typeof import("./state")>("./state");
  return {
    ...actual,
    getCapitalState: (...a: any[]) => getCapitalStateMock(...a),
    getDayRecord: (...a: any[]) => getDayRecordMock(...a),
    upsertDayRecord: (...a: any[]) => upsertDayRecordMock(...a),
  };
});

vi.mock("../broker/brokerConfig", () => ({
  getActiveBrokerConfig: async () => ({ brokerId: "test", settings: {} }),
}));

vi.mock("../portfolio/aiModeConfig", () => ({
  aiModeForChannel: () => null,
  modeForChannel: () => "paper",
  getExitConfig: () => ({
    sprint: {
      trailingStopEnabled: true, trailingStopPercent: 1.5,
      trailingDistanceSource: "config", trailingActivationGatePercent: 2,
      trailingActivationHoldSeconds: 0, tpTrailPercent: 1.5,
    },
    runway: {}, anchor: {},
    glide: glideCfg,
    lubasManagedExit: true,
  }),
  getAiConfig: () => ({ strategies: {}, sizing: { perInstrument: {} } }),
}));

vi.mock("../broker/tickBus", () => ({ tickBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));
vi.mock("../broker/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), important: vi.fn() }),
}));
vi.mock("./compounding", () => ({ recalculateDayAggregates: (d: any) => d }));

import { tickHandler } from "./tickHandler";
import type { TickData } from "../broker/types";

function glideTrade(overrides: Partial<any> = {}): any {
  return {
    id: "T-GLIDE", instrument: "NIFTY_50", type: "CALL_BUY",
    // contractSecurityId stays NULL so the trade matches the tick key
    // ("NSE:NIFTY_50"); a real securityId would route the tick elsewhere and the
    // trade would never be evaluated — the test would pass by not running.
    strike: 23850, expiry: "2026-07-28", contractSecurityId: null,
    entryPrice: 100, exitPrice: null, ltp: 100, qty: 65, status: "OPEN",
    // Glide's defining shape: no levels, and every auto-exit below the guard
    // switched off.
    targetPrice: null, stopLossPrice: null, manualExitOnly: true,
    exitStrategy: "glide", breakevenPrice: 100,
    lastTickAt: null, unrealizedPnl: 0,
    ...overrides,
  };
}

async function tick(trade: any, ltp: number): Promise<void> {
  getDayRecordMock.mockImplementation((channel: string) =>
    Promise.resolve(
      channel === "paper"
        ? { dayIndex: 1, date: "2026-07-23", trades: [trade], totalPnl: 0 }
        : { dayIndex: 1, date: "2026-07-23", trades: [], totalPnl: 0 },
    ),
  );
  tickHandler.clearStateCache();
  const h = tickHandler as any;
  h.pendingUpdates.set("NSE:NIFTY_50", { exchange: "NSE", securityId: "NIFTY_50", ltp, timestamp: Date.now() } as TickData);
  await h.processPendingUpdates();
}

/** Run a price path and report whether the guard closed the trade. */
async function run(trade: any, path: number[]): Promise<{ exited: boolean; at: number | null }> {
  let exit: any = null;
  const onExit = (e: any) => { if (!exit) exit = e; };
  tickHandler.on("autoExitDetected", onExit);
  try {
    for (const p of path) { await tick(trade, p); if (exit) break; }
  } finally {
    tickHandler.off("autoExitDetected", onExit);
  }
  return { exited: !!exit, at: exit?.exitPrice ?? null };
}

beforeEach(() => {
  vi.clearAllMocks();
  tickHandler.clearStateCache();
  (tickHandler as any).peakPrices.clear();
  (tickHandler as any).exitingTrades.clear();
  (tickHandler as any).tslArmedAt.clear();
  (tickHandler as any).tslActivated.clear();
  for (const k of Object.keys(glideCfg)) delete glideCfg[k];
  // Shipping defaults: arm once up 10% of entry, exit on giving back half.
  Object.assign(glideCfg, { disasterSlPct: 50, giveBackArmPct: 10, giveBackPct: 50 });
  getCapitalStateMock.mockResolvedValue({
    channel: "paper", tradingPool: 100_000, reservePool: 0, initialFunding: 100_000,
    currentDayIndex: 1, targetPercent: 1, profitHistory: [],
    cumulativePnl: 0, cumulativeCharges: 0, sessionTradeCount: 0,
  });
});

describe("Glide give-back guard", () => {
  it("closes a trade that ran up and then handed half the gain back", async () => {
    // Peak 130 = +30 gain (armed, 30 >= 10). Back to 114 keeps 14/30 = 47% < 50%.
    const t = glideTrade();
    const r = await run(t, [100, 130, 114]);
    expect(r.exited).toBe(true);
    expect(r.at).toBe(114);
  });

  it("leaves a trade alone while it is still holding most of its gain", async () => {
    // 124 keeps 24/30 = 80%.
    const r = await run(glideTrade(), [100, 130, 124]);
    expect(r.exited).toBe(false);
  });

  it("NEVER fires on a trade that has not yet earned anything — Glide keeps its character", async () => {
    // Straight down from entry, never up. This is the case a stop-loss would
    // catch and the guard must NOT: peak gain never reaches the arm threshold,
    // so the trade rides on to the MA EXIT exactly as Glide promises.
    const r = await run(glideTrade(), [100, 95, 88, 80, 72, 60]);
    expect(r.exited).toBe(false);
  });

  it("does not arm on a gain below giveBackArmPct, even if all of it is given back", async () => {
    // Peak 105 = +5, under the +10 arm threshold. Back to 100 gives back 100%
    // and still must not fire — that would make it a stop-loss by the back door.
    const r = await run(glideTrade(), [100, 105, 100, 99]);
    expect(r.exited).toBe(false);
  });

  it("still lets the DISASTER stop fire on a collapse that never armed the guard", async () => {
    // 49 breaches the 50% disaster stop. The two protections are independent:
    // the guard covers give-back, the disaster stop covers a never-worked trade.
    const r = await run(glideTrade(), [100, 95, 49]);
    expect(r.exited).toBe(true);
    expect(r.at).toBe(49);
  });

  it("mirrors for a SHORT — a sold option gains as the premium FALLS", async () => {
    // Without the mirror the guard reads the loss as the gain and closes winners.
    const t = glideTrade({ id: "T-GLIDE-S", type: "PUT_SELL", entryPrice: 100 });
    const r = await run(t, [100, 70, 86]); // peak gain 30, back to 14 kept = 47%
    expect(r.exited).toBe(true);
    expect(r.at).toBe(86);
  });

  it("is OFF when giveBackPct is 0 — the setting can restore pure Glide", async () => {
    // Anyone who wants the old behaviour must be able to ask for it rather than
    // edit code.
    Object.assign(glideCfg, { giveBackPct: 0 });
    const r = await run(glideTrade(), [100, 130, 101]); // gave back 97%
    expect(r.exited).toBe(false);
  });

  it("tracks the configured give-back percentage", async () => {
    Object.assign(glideCfg, { giveBackPct: 20 }); // tighter: exit on giving back a fifth
    const r = await run(glideTrade(), [100, 130, 123]); // keeps 23/30 = 77% < 80%
    expect(r.exited).toBe(true);
  });

  it("only fires on Glide — a Sprint trade is untouched by it", async () => {
    // The guard is Glide's substitute for having no stop at all. Sprint already
    // has SL/TP/trailing; applying it there would double up.
    const t = glideTrade({ id: "T-SPRINT", exitStrategy: "sprint", manualExitOnly: false, stopLossPrice: null, targetPrice: null });
    const r = await run(t, [100, 130, 101]);
    expect(r.exited).toBe(false);
  });
});
