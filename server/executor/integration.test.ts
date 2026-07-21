/**
 * End-to-end integration test for the AI loop.
 *
 * Unit tests in tradeExecutor.test.ts mock everything below TEA.
 * This test mocks only at the storage boundary (state.ts +
 * storage.ts CRUD replaced with in-memory Maps) and exercises real
 * PA + TEA + the audit / metrics / drawdown wiring.
 *
 * Catches:
 *   - Broken hand-off between TEA → PA's appendTrade / closeTrade
 *   - position_state dual-write drift
 *   - portfolio_events audit gaps
 *   - portfolio_metrics rollup mistakes
 *   - drawdown computation off-by-one
 *
 * Doesn't catch:
 *   - Real Mongo schema validation failures (use unit + dev runs)
 *   - WebSocket / broker network behaviour (use the smoke test)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── In-memory storage shared across mocks ──────────────────────

const portfolioStateStore = new Map<string, any>();
const dayRecordsStore = new Map<string, any>();          // key: `${channel}|${dayIndex}`
const positionsStore = new Map<string, any>();           // key: positionId
const eventsStore: any[] = [];
const metricsStore = new Map<string, any>();             // key: channel

function dayKey(channel: string, dayIndex: number) {
  return `${channel}|${dayIndex}`;
}

// ─── Module mocks ───────────────────────────────────────────────

vi.mock("../broker/brokerService", () => ({
  getAdapter: vi.fn(),
  getActiveBroker: vi.fn(() => null),
  isChannelKillSwitchActive: vi.fn(() => false),
}));

vi.mock("../broker/tickBus", () => ({
  tickBus: { emitTick: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock("./tradeResolution", () => ({
  resolveLotSize: vi.fn(async () => 75),
}));

// Option trades are validated against the real scrip master with NO fallback —
// an unknown securityId is rejected outright. This test's contracts are
// synthetic, so the master must be mocked or every option submit here fails on
// a data-loading concern that has nothing to do with the wiring under test.
vi.mock("../broker/adapters/dhan/scripMaster", () => ({
  getScripBySecurityId: vi.fn((id: string) =>
    id?.startsWith("INT-")
      ? { securityId: id, optionType: id.includes("-PE-") ? "PE" : "CE", lotSize: 15, expiryDateOnly: null }
      : null,
  ),
}));

vi.mock("./settings", () => ({
  getExecutorSettings: vi.fn(async () => ({
    userId: "1",
    rcaMaxAgeMs: 30 * 60 * 1000,
    rcaStaleTickMs: 5 * 60 * 1000,
    rcaVolThreshold: 0.7,
    updatedAt: 0,
  })),
  updateExecutorSettings: vi.fn(),
}));

vi.mock("../discipline", () => ({
  disciplineAgent: {
    validateTrade: vi.fn(async () => ({
      allowed: true,
      blockedBy: [],
      warnings: [],
      adjustments: [],
      details: {},
    })),
    recordTradeOutcome: vi.fn(async () => undefined),
  },
}));

vi.mock("../userSettings", () => ({
  getUserSettings: vi.fn(async () => ({
    charges: { rates: [] },
  })),
}));

vi.mock("../broker/brokerConfig", () => ({
  getActiveBrokerConfig: vi.fn(async () => null),
}));

// PA's compounding helpers — use the real implementations except for
// the few that touch system state we don't have. We import the actual
// module by NOT mocking it (importOriginal pattern would be heavier).

// state.ts — replace CRUD with in-memory Maps. Mongoose models still
// referenced as types but we never call them.
vi.mock("../portfolio/state", async () => {
  const real = await vi.importActual<any>("../portfolio/state");
  return {
    ...real,
    getCapitalState: vi.fn(async (channel: string) => {
      if (!portfolioStateStore.has(channel)) {
        portfolioStateStore.set(channel, {
          channel,
          tradingPool: 75000,
          reservePool: 25000,
          initialFunding: 100000,
          currentDayIndex: 1,
          targetPercent: 5,
          profitHistory: [],
          cumulativePnl: 0,
          cumulativeCharges: 0,
          sessionTradeCount: 0,
          sessionPnl: 0,
          sessionDate: "2026-04-25",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      return portfolioStateStore.get(channel);
    }),
    updateCapitalState: vi.fn(async (channel: string, updates: any) => {
      const existing = portfolioStateStore.get(channel) ?? {};
      const next = { ...existing, ...updates, updatedAt: Date.now() };
      portfolioStateStore.set(channel, next);
      return next;
    }),
    getDayRecord: vi.fn(async (channel: string, dayIndex: number) => {
      return dayRecordsStore.get(dayKey(channel, dayIndex)) ?? null;
    }),
    getDayRecords: vi.fn(async (_channel: string) => Array.from(dayRecordsStore.values())),
    upsertDayRecord: vi.fn(async (channel: string, record: any) => {
      const next = { ...record, channel };
      dayRecordsStore.set(dayKey(channel, record.dayIndex), next);
      return next;
    }),
    deleteDayRecordsFrom: vi.fn(async () => 0),
    deleteAllDayRecords: vi.fn(async () => 0),
    replaceCapitalState: vi.fn(async (channel: string, state: any) => {
      const next = { ...state, channel, updatedAt: Date.now() };
      portfolioStateStore.set(channel, next);
      return next;
    }),
  };
});

// storage.ts — same in-memory replacements for the Phase 2 collections.
vi.mock("../portfolio/storage", async () => {
  const real = await vi.importActual<any>("../portfolio/storage");
  return {
    ...real,
    upsertPosition: vi.fn(async (position: any) => {
      positionsStore.set(position.positionId, { ...position });
      return position;
    }),
    getPosition: vi.fn(async (positionId: string) => positionsStore.get(positionId) ?? null),
    getPositionByTradeId: vi.fn(async (tradeId: string) =>
      Array.from(positionsStore.values()).find((p) => p.tradeId === tradeId) ?? null,
    ),
    getOpenPositions: vi.fn(async (channel: string) =>
      Array.from(positionsStore.values()).filter((p) => p.channel === channel && p.status === "OPEN"),
    ),
    getPositionsByDay: vi.fn(async () => []),
    getMetrics: vi.fn(async (channel: string) => metricsStore.get(channel) ?? null),
    upsertMetrics: vi.fn(async (m: any) => {
      metricsStore.set(m.channel, m);
      return m;
    }),
    appendEvent: vi.fn(async (event: any) => {
      const e = { ...event, eventId: `EVT-${Date.now()}-${Math.random().toString(36).slice(2)}` };
      eventsStore.push(e);
      return e;
    }),
    getEvents: vi.fn(async () => [...eventsStore]),
    PositionStateModel: {
      find: () => ({
        lean: async () =>
          Array.from(positionsStore.values()).filter(
            (p) => p.status !== "OPEN" && p.status !== "PENDING" && p.status !== "CANCELLED",
          ),
      }),
    },
  };
});

// ─── SUT imports (after all mocks) ──────────────────────────────

import { tradeExecutor } from "./tradeExecutor";

const fillingAdapter = {
  brokerId: "mock-ai",
  displayName: "Paper",
  placeOrder: vi.fn(async () => ({
    orderId: `ORD-${Date.now()}`,
    status: "FILLED" as const,
    timestamp: Date.now(),
  })),
  modifyOrder: vi.fn(async () => ({ orderId: "X", status: "FILLED" as const, timestamp: Date.now() })),
};

import { getAdapter } from "../broker/brokerService";

beforeEach(() => {
  portfolioStateStore.clear();
  dayRecordsStore.clear();
  positionsStore.clear();
  eventsStore.length = 0;
  metricsStore.clear();
  vi.clearAllMocks();
  (getAdapter as any).mockReturnValue(fillingAdapter);
});

// ─── Tests ──────────────────────────────────────────────────────

describe("AI loop integration — paper trade lifecycle", () => {
  it("submit → close traces through every wiring point", async () => {
    // ── Submit ──
    const submit = await tradeExecutor.submitTrade({
      executionId: "int-1",
      channel: "ai-paper",
      origin: "AI",
      instrument: "BANK NIFTY",
      direction: "BUY",
      quantity: 15,
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      orderType: "MARKET",
      productType: "INTRADAY",
      optionType: "CE",
      strike: 56400,
      contractSecurityId: "INT-CE-1",
      timestamp: Date.now(),
    });
    expect(submit.success).toBe(true);
    expect(submit.tradeId).toMatch(/^T/);

    // Day record has the trade nested inside
    const day = dayRecordsStore.get(dayKey("ai-paper", 1));
    expect(day).toBeDefined();
    expect(day.trades).toHaveLength(1);
    expect(day.trades[0].id).toBe(submit.tradeId);

    // position_state has the dual-write
    expect(positionsStore.size).toBe(1);
    const pos = positionsStore.get(submit.positionId);
    expect(pos).toBeDefined();
    expect(pos.status).toBe("OPEN");

    // portfolio_events has TRADE_PLACED
    const placedEvents = eventsStore.filter((e) => e.eventType === "TRADE_PLACED");
    expect(placedEvents).toHaveLength(1);
    expect(placedEvents[0].tradeId).toBe(submit.tradeId);

    // ── Exit ──
    const exit = await tradeExecutor.exitTrade({
      executionId: "int-1-exit",
      positionId: submit.positionId,
      channel: "ai-paper",
      exitType: "MARKET",
      exitPrice: 105,
      reason: "MANUAL",
      triggeredBy: "USER",
      timestamp: Date.now(),
    });
    expect(exit.success).toBe(true);
    expect(exit.realizedPnl).toBe((105 - 100) * 15); // 75

    // Day record's trade now closed
    const dayAfter = dayRecordsStore.get(dayKey("ai-paper", 1));
    expect(dayAfter.trades[0].status).toBe("CLOSED");
    expect(dayAfter.trades[0].exitReason).toBe("MANUAL");
    expect(dayAfter.trades[0].exitPrice).toBe(105);

    // position_state mirrored the close
    const posAfter = positionsStore.get(submit.positionId);
    expect(posAfter.status).toBe("CLOSED");

    // portfolio_events has TRADE_CLOSED
    const closedEvents = eventsStore.filter((e) => e.eventType === "TRADE_CLOSED");
    expect(closedEvents).toHaveLength(1);

    // capital state advanced (cumulativePnl bumped, peakCapital tracked)
    const finalState = portfolioStateStore.get("ai-paper");
    expect(finalState.cumulativePnl).toBe(75);
    // Drawdown is 0 because we just made profit (capital > peak).
    expect(finalState.drawdownPercent).toBe(0);
    expect(finalState.peakCapital).toBeGreaterThanOrEqual(100000);
  });

  it("rejected broker order leaves no trace except TRADE_REJECTED audit", async () => {
    (getAdapter as any).mockReturnValue({
      ...fillingAdapter,
      placeOrder: vi.fn(async () => ({
        orderId: "",
        status: "REJECTED" as const,
        message: "Insufficient margin",
        timestamp: Date.now(),
      })),
    });

    const resp = await tradeExecutor.submitTrade({
      executionId: "int-rej",
      channel: "ai-paper",
      origin: "AI",
      instrument: "BANK NIFTY",
      direction: "BUY",
      quantity: 15,
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      orderType: "MARKET",
      productType: "INTRADAY",
      optionType: "CE",
      strike: 56400,
      timestamp: Date.now(),
    });
    expect(resp.success).toBe(false);

    // No day record (TEA short-circuits before appendTrade) and no position.
    expect(positionsStore.size).toBe(0);

    // Audit captured the reject
    const rejected = eventsStore.filter((e) => e.eventType === "TRADE_REJECTED");
    expect(rejected).toHaveLength(1);
  });
});

/**
 * The exit strategy the CALLER asked for must reach the stored trade.
 *
 * `submitTrade` falls back to "sprint" when no strategy arrives. That fallback
 * is fine as a default, but `placeTradeUiSchema` had no `exitStrategy` field at
 * all, so the fallback fired on EVERY manual trade — a book configured for
 * Runway silently ran Sprint, and the AI menu's strategy pills were decorative.
 * Nothing failed loudly; the trades just used the wrong exit rules.
 */
describe("exit strategy reaches the stored trade", () => {
  const submitWith = async (id: string, exitStrategy?: "sprint" | "runway" | "anchor") => {
    const r = await tradeExecutor.submitTrade({
      executionId: id, channel: "ai-paper", origin: "MANUAL", instrument: "BANK NIFTY",
      direction: "BUY", quantity: 15, entryPrice: 100, stopLoss: 95, takeProfit: 110,
      orderType: "MARKET", productType: "INTRADAY", optionType: "CE", strike: 56400,
      contractSecurityId: "INT-CE-1", exitStrategy, timestamp: Date.now(),
    });
    expect(r.success).toBe(true);
    const day = dayRecordsStore.get(dayKey("ai-paper", 1));
    return day.trades.find((t: any) => t.id === r.tradeId);
  };

  it("stores runway when runway was requested", async () => {
    expect((await submitWith("es-runway", "runway")).exitStrategy).toBe("runway");
  });

  it("stores anchor when anchor was requested", async () => {
    expect((await submitWith("es-anchor", "anchor")).exitStrategy).toBe("anchor");
  });

  it("resolves from the AI menu when the caller sends nothing", async () => {
    // With no config file loaded this suite sees the DEFAULT manual block,
    // whose first enabled pill is sprint — so the value here is sprint. That is
    // the default's doing, NOT a hardcoded fallback: the routing itself is
    // pinned in resolveExitStrategy.test.ts, which drives the config directly.
    expect((await submitWith("es-none")).exitStrategy).toBe("sprint");
  });
});

/**
 * Lot size must reach the stored trade.
 *
 * The router resolved it to compute qty, then dropped it on the way to
 * submitTrade, so every trade persisted lotSize: null. The desk's lot tooltip
 * then fell back to 1/1 and displayed "Lots 1 · Lot Size 1 · Total Units 650"
 * for a 10-lot NIFTY position — three mutually contradictory numbers.
 */
describe("lot size is recorded on the trade", () => {
  const submitLots = async (id: string, lotSize?: number) => {
    const r = await tradeExecutor.submitTrade({
      executionId: id, channel: "ai-paper", origin: "USER", instrument: "BANK NIFTY",
      direction: "BUY", quantity: 30, entryPrice: 100, stopLoss: 95, takeProfit: 110,
      orderType: "MARKET", productType: "INTRADAY", optionType: "CE", strike: 56400,
      contractSecurityId: "INT-CE-1", lotSize, timestamp: Date.now(),
    });
    expect(r.success).toBe(true);
    return dayRecordsStore.get(dayKey("ai-paper", 1)).trades.find((t: any) => t.id === r.tradeId);
  };

  it("stores the caller's lot size", async () => {
    expect((await submitLots("lot-explicit", 15)).lotSize).toBe(15);
  });

  it("falls back to the scrip master when the caller omits it", async () => {
    // The fallback lives in buildTradeRecord so paths that never learned to
    // send it — the RCA fan-out, any future caller — record it anyway.
    expect((await submitLots("lot-fallback")).lotSize).toBe(15); // mocked master
  });

  it("records a size that divides qty into whole lots", async () => {
    const t = await submitLots("lot-whole", 15);
    expect(t.qty % t.lotSize).toBe(0);
    expect(t.qty / t.lotSize).toBe(2);
  });
});
