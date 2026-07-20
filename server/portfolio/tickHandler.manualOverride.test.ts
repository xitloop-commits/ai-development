/**
 * Manual SL/TP overrides must survive the strategy's per-tick recompute.
 *
 * The bug: making the strategy the sole source of SL/TSL/TP also made it
 * authoritative over the OPERATOR. Runway/Anchor rewrote both levels from config
 * every tick, so a manual edit was gone on the very next tick.
 *
 * The agreed behaviour: a manual level is honoured immediately and becomes the
 * new floor; the strategy may still ratchet it FURTHER in the operator's favour,
 * but never resets it. Manual widening must stick — which is why the staged stop
 * (an absolute recompute from entry) is suppressed while only the genuine
 * trailing phase is allowed through.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getCapitalStateMock = vi.fn();
const getDayRecordMock = vi.fn();
const upsertDayRecordMock = vi.fn();
const getActiveBrokerConfigMock = vi.fn();
const aiSprint: Record<string, any> = {};
const runway = { coolingSec: 300, defaultSlPct: 25, cooledSlPct: 12.5, breakevenAtFrac: 0.5, nearTargetFrac: 0.9, trailPct: 15, defaultTargetPct: 10 };

vi.mock("./state", async () => {
  const actual = await vi.importActual<typeof import("./state")>("./state");
  return {
    ...actual,
    getCapitalState: (...a: any[]) => getCapitalStateMock(...a),
    getDayRecord: (...a: any[]) => getDayRecordMock(...a),
    upsertDayRecord: (...a: any[]) => upsertDayRecordMock(...a),
  };
});
vi.mock("../broker/brokerConfig", () => ({ getActiveBrokerConfig: () => getActiveBrokerConfigMock() }));
vi.mock("../portfolio/aiModeConfig", () => ({
  aiModeForChannel: () => null,
  modeForChannel: (ch: string) => (ch === "paper" ? "paper" : "live"),
  getExitConfig: () => ({ sprint: aiSprint, runway, anchor: runway }),
  getAiConfig: () => ({ strategies: {}, sizing: { perInstrument: {} } }),
}));
vi.mock("../broker/tickBus", () => ({ tickBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));
vi.mock("../broker/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), important: vi.fn() }),
}));
vi.mock("./compounding", () => ({ recalculateDayAggregates: (d: any) => d }));

import { tickHandler } from "./tickHandler";
import type { TickData } from "../broker/types";

const tick = (ltp: number): TickData =>
  ({ exchange: "NSE", securityId: "NIFTY_50", ltp, timestamp: Date.now() } as TickData);

function trade(overrides: Partial<any> = {}): any {
  return {
    id: "T-1", instrument: "NIFTY_50", type: "BUY", strike: null, expiry: null,
    contractSecurityId: null, entryPrice: 100, exitPrice: null, ltp: 100, qty: 1,
    status: "OPEN", targetPrice: null, stopLossPrice: 95, breakevenPrice: 100,
    // Opened well outside the cooling window so the staged stop is live.
    openedAt: Date.now() - 30 * 60_000,
    lastTickAt: null, unrealizedPnl: 0, ...overrides,
  };
}

async function push(t: any, ltp: number) {
  getDayRecordMock.mockImplementation((channel: string) =>
    Promise.resolve({ dayIndex: 1, date: "2024-11-14", trades: channel === "paper" ? [t] : [], totalPnl: 0 }),
  );
  tickHandler.clearStateCache();
  const h = tickHandler as any;
  const tk = tick(ltp);
  h.pendingUpdates.set(`${tk.exchange}:${tk.securityId}`, tk);
  await h.processPendingUpdates();
}

beforeEach(() => {
  vi.clearAllMocks();
  tickHandler.clearStateCache();
  for (const m of ["peakPrices", "tslArmedAt", "tslActivated", "exitingTrades"]) {
    (tickHandler as any)[m].clear();
  }
  Object.assign(aiSprint, {
    defaultSL: 2, defaultTP: 5, trailingStopEnabled: false, trailingStopPercent: 2,
    trailingDistanceSource: "config", trailingActivationGatePercent: 0,
    trailingActivationHoldSeconds: 0, tpTrailPercent: 1.5,
  });
  getCapitalStateMock.mockResolvedValue({ tradingPool: 100000, currentDayIndex: 1 });
  getActiveBrokerConfigMock.mockResolvedValue({ settings: {} });
  upsertDayRecordMock.mockResolvedValue(undefined);
});

describe("Runway/Anchor — a manual level is not reset by the strategy", () => {
  it("WITHOUT an override the strategy owns the stop (baseline)", async () => {
    const t = trade({ exitStrategy: "runway", stopLossPrice: 80 });
    await push(t, 101);
    // Past cooling, no profit yet → staged 'wide' stop = entry − 12.5% = 87.5
    expect(t.stopLossPrice).toBeCloseTo(87.5, 2);
  });

  it("honours a manually WIDENED stop instead of snapping it back", async () => {
    const t = trade({ exitStrategy: "runway", stopLossPrice: 80, slOverridden: true });
    await push(t, 101);
    expect(t.stopLossPrice).toBe(80); // staged 87.5 suppressed
  });

  it("honours a manually TIGHTENED stop", async () => {
    const t = trade({ exitStrategy: "runway", stopLossPrice: 97, slOverridden: true });
    await push(t, 101);
    expect(t.stopLossPrice).toBe(97);
  });

  it("still ratchets an overridden stop UP once the trailing phase engages", async () => {
    // gain = 10% of 100 = 10; trailing starts at peak >= entry + 0.9*gain = 109.
    // At peak 130: trail = max(entry+0.5*gain=105, 130*0.85=110.5) = 110.5.
    const t = trade({ exitStrategy: "runway", stopLossPrice: 80, slOverridden: true });
    await push(t, 130);
    expect(t.stopLossPrice).toBeCloseTo(110.5, 2); // trailing beats the manual 80
  });

  it("does NOT let trailing pull an overridden stop back DOWN", async () => {
    // Manual stop above what trailing would compute → manual wins.
    const t = trade({ exitStrategy: "runway", stopLossPrice: 120, slOverridden: true });
    await push(t, 130);
    expect(t.stopLossPrice).toBe(120);
  });

  it("leaves a manual target alone", async () => {
    const t = trade({ exitStrategy: "runway", targetPrice: 140, tpOverridden: true });
    await push(t, 101);
    expect(t.targetPrice).toBe(140); // config target (110) suppressed
  });

  it("still drives the target from config when NOT overridden", async () => {
    const t = trade({ exitStrategy: "runway", targetPrice: 140 });
    await push(t, 101);
    expect(t.targetPrice).toBeCloseTo(110, 2); // entry + 10%
  });

  it("applies the same rules to Anchor", async () => {
    const t = trade({ exitStrategy: "anchor", stopLossPrice: 80, slOverridden: true });
    await push(t, 101);
    expect(t.stopLossPrice).toBe(80);
  });
});

describe("Sprint — already ratchet-only, so a manual level survives as a floor", () => {
  it("trailing never pulls a manual stop back down", async () => {
    Object.assign(aiSprint, { trailingStopEnabled: true, trailingStopPercent: 2 });
    const t = trade({ exitStrategy: "sprint", stopLossPrice: 99, slOverridden: true, tslMode: "auto" });
    await push(t, 100); // trail would be 98 — below the manual 99
    expect(t.stopLossPrice).toBe(99);
  });

  it("trailing still improves a manual stop when price runs", async () => {
    Object.assign(aiSprint, { trailingStopEnabled: true, trailingStopPercent: 2 });
    const t = trade({ exitStrategy: "sprint", stopLossPrice: 99, slOverridden: true, tslMode: "auto" });
    await push(t, 120); // trail = 120 * 0.98 = 117.6
    expect(t.stopLossPrice).toBeCloseTo(117.6, 2);
  });
});
