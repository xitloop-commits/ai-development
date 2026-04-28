/**
 * Tests for Discipline Agent Module 8 — Capital Protection.
 *
 * Pure-evaluator tests + scheduler math. Mongo / cron / TEA wiring is
 * covered separately in integration tests.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateCapitalProtection,
  applyVerdict,
  applySessionHalt,
  clearSessionHalt,
  getSessionHaltFor,
  runCarryForwardEvaluation,
  parseHHmm,
  getCarryForwardEvalTime,
  type CarryForwardPositionInput,
} from "./capitalProtection";
import { msToNextIstHHmm } from "./capitalProtectionScheduler";
import {
  createDefaultState,
  DEFAULT_DISCIPLINE_AGENT_SETTINGS,
  type DisciplineAgentSettings,
} from "./types";

function makeSettings(overrides: Partial<DisciplineAgentSettings["capitalProtection"]> = {}): DisciplineAgentSettings {
  return {
    userId: "1",
    updatedAt: new Date(),
    ...DEFAULT_DISCIPLINE_AGENT_SETTINGS,
    history: [],
    capitalProtection: {
      ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection,
      ...overrides,
    },
  } as DisciplineAgentSettings;
}

const NOW = new Date("2026-04-28T05:00:00Z"); // 10:30 IST — mid-NSE-session

// ─── Cap evaluation ───────────────────────────────────────────────

describe("evaluateCapitalProtection — caps disabled", () => {
  it("returns OK when both caps are disabled", () => {
    const state = createDefaultState("1", "2026-04-28");
    const settings = makeSettings({
      profitCap: { enabled: false, percent: 5 },
      lossCap: { enabled: false, percent: 2 },
    });
    expect(evaluateCapitalProtection(state, settings, 50, NOW).status).toBe("OK");
    expect(evaluateCapitalProtection(state, settings, -50, NOW).status).toBe("OK");
  });
});

describe("evaluateCapitalProtection — profit cap", () => {
  const settings = makeSettings({
    profitCap: { enabled: true, percent: 5 },
    lossCap: { enabled: false, percent: 2 },
    gracePeriodSeconds: 60,
  });

  it("OK below cap", () => {
    const state = createDefaultState("1", "2026-04-28");
    const v = evaluateCapitalProtection(state, settings, 4.99, NOW);
    expect(v.status).toBe("OK");
    expect(v.halts).toBeUndefined();
  });

  it("PROFIT_CAP_HIT exactly at threshold", () => {
    const state = createDefaultState("1", "2026-04-28");
    const v = evaluateCapitalProtection(state, settings, 5, NOW);
    expect(v.status).toBe("PROFIT_CAP_HIT");
    expect(v.halts?.nse?.triggered).toBe(true);
    expect(v.halts?.mcx?.triggered).toBe(true);
    expect(v.halts?.nse?.source).toBe("PROFIT_CAP");
    expect(v.signal).toBe("BLOCK_NEW_ENTRIES");
    expect(v.grace).toBeDefined();
    expect(v.grace?.deadline.getTime() - v.grace!.startedAt.getTime()).toBe(60 * 1000);
  });

  it("PROFIT_CAP_HIT well above threshold", () => {
    const state = createDefaultState("1", "2026-04-28");
    const v = evaluateCapitalProtection(state, settings, 12, NOW);
    expect(v.status).toBe("PROFIT_CAP_HIT");
    expect(v.reason).toContain("+12.00%");
  });

  it("uses operator-tunable percent (no hardcoded 5)", () => {
    const tighter = makeSettings({ profitCap: { enabled: true, percent: 2 }, gracePeriodSeconds: 30 });
    const state = createDefaultState("1", "2026-04-28");
    expect(evaluateCapitalProtection(state, tighter, 1.99, NOW).status).toBe("OK");
    expect(evaluateCapitalProtection(state, tighter, 2.0, NOW).status).toBe("PROFIT_CAP_HIT");
  });
});

describe("evaluateCapitalProtection — loss cap", () => {
  const settings = makeSettings({
    profitCap: { enabled: false, percent: 5 },
    lossCap: { enabled: true, percent: 2 },
    gracePeriodSeconds: 60,
  });

  it("OK above (less negative than) cap", () => {
    const state = createDefaultState("1", "2026-04-28");
    const v = evaluateCapitalProtection(state, settings, -1.99, NOW);
    expect(v.status).toBe("OK");
  });

  it("LOSS_CAP_HIT exactly at threshold", () => {
    const state = createDefaultState("1", "2026-04-28");
    const v = evaluateCapitalProtection(state, settings, -2, NOW);
    expect(v.status).toBe("LOSS_CAP_HIT");
    expect(v.halts?.nse?.triggered).toBe(true);
    expect(v.halts?.mcx?.triggered).toBe(true);
    expect(v.halts?.nse?.source).toBe("LOSS_CAP");
  });

  it("LOSS_CAP_HIT well below threshold", () => {
    const state = createDefaultState("1", "2026-04-28");
    const v = evaluateCapitalProtection(state, settings, -7, NOW);
    expect(v.status).toBe("LOSS_CAP_HIT");
    expect(v.reason).toContain("-7.00%");
  });
});

describe("evaluateCapitalProtection — grace handling", () => {
  const settings = makeSettings({
    profitCap: { enabled: true, percent: 5 },
    lossCap: { enabled: true, percent: 2 },
    gracePeriodSeconds: 60,
  });

  it("session already halted with active grace — BLOCK_NEW_ENTRIES until deadline", () => {
    const state = createDefaultState("1", "2026-04-28");
    state.sessionHalts.nse = { triggered: true, source: "PROFIT_CAP", reason: "x" };
    state.capGrace = {
      startedAt: NOW,
      deadline: new Date(NOW.getTime() + 30 * 1000),
      source: "PROFIT_CAP",
      acknowledged: false,
      userAction: null,
    };
    const v = evaluateCapitalProtection(state, settings, 6, NOW);
    expect(v.status).toBe("SESSION_HALTED");
    expect(v.signal).toBe("BLOCK_NEW_ENTRIES");
  });

  it("session halted with EXPIRED grace — fires EXIT_ALL", () => {
    const state = createDefaultState("1", "2026-04-28");
    state.sessionHalts.nse = { triggered: true, source: "PROFIT_CAP", reason: "x" };
    state.capGrace = {
      startedAt: new Date(NOW.getTime() - 90 * 1000),
      deadline: new Date(NOW.getTime() - 30 * 1000), // already passed
      source: "PROFIT_CAP",
      acknowledged: false,
      userAction: null,
    };
    const v = evaluateCapitalProtection(state, settings, 6, NOW);
    expect(v.status).toBe("SESSION_HALTED");
    expect(v.signal).toBe("EXIT_ALL");
    expect(v.reason).toContain("grace expired");
  });

  it("session halted, no grace — BLOCK_NEW_ENTRIES (no auto-exit)", () => {
    const state = createDefaultState("1", "2026-04-28");
    state.sessionHalts.mcx = { triggered: true, source: "MANUAL", reason: "operator" };
    state.capGrace = null;
    const v = evaluateCapitalProtection(state, settings, 0, NOW);
    expect(v.status).toBe("SESSION_HALTED");
    expect(v.signal).toBe("BLOCK_NEW_ENTRIES");
    expect(v.reason).toBe("operator");
  });
});

// ─── applyVerdict / state mutations ──────────────────────────────

describe("applyVerdict + manual halt control", () => {
  it("applyVerdict copies halt + grace into state", () => {
    const state = createDefaultState("1", "2026-04-28");
    const settings = makeSettings({ profitCap: { enabled: true, percent: 5 }, gracePeriodSeconds: 60 });
    const v = evaluateCapitalProtection(state, settings, 6, NOW);
    applyVerdict(state, v);
    expect(state.sessionHalts.nse.triggered).toBe(true);
    expect(state.sessionHalts.mcx.triggered).toBe(true);
    expect(state.capGrace?.source).toBe("PROFIT_CAP");
  });

  it("applySessionHalt + clearSessionHalt are per-exchange", () => {
    const state = createDefaultState("1", "2026-04-28");
    applySessionHalt(state, "NSE", "manual NSE", "MANUAL", NOW);
    expect(state.sessionHalts.nse.triggered).toBe(true);
    expect(state.sessionHalts.mcx.triggered).toBe(false);

    clearSessionHalt(state, "NSE");
    expect(state.sessionHalts.nse.triggered).toBe(false);
    expect(state.sessionHalts.mcx.triggered).toBe(false);
  });

  it("getSessionHaltFor returns null when not halted", () => {
    const state = createDefaultState("1", "2026-04-28");
    expect(getSessionHaltFor(state, "NSE")).toBeNull();
    applySessionHalt(state, "MCX", "x", "MANUAL", NOW);
    expect(getSessionHaltFor(state, "NSE")).toBeNull();
    expect(getSessionHaltFor(state, "MCX")?.reason).toBe("x");
  });
});

// ─── Carry-forward evaluation ────────────────────────────────────

describe("runCarryForwardEvaluation", () => {
  const settings = makeSettings({
    carryForward: {
      enabled: true,
      nseEvalTime: "15:15",
      mcxEvalTime: "23:15",
      autoExit: true,
      exitDelayMinutes: 5,
      minProfitPercent: 15,
      minMomentumScore: 70,
      minDte: 2,
      ivCondition: "fair",
    },
  });

  const goodPos: CarryForwardPositionInput = {
    tradeId: "T1",
    profitPercent: 20,
    momentumScore: 80,
    dte: 5,
    ivLabel: "fair",
  };

  it("NO_OPEN_POSITIONS when nothing to evaluate", () => {
    const r = runCarryForwardEvaluation([], settings);
    expect(r.outcome).toBe("NO_OPEN_POSITIONS");
    expect(r.tradesToExit).toEqual([]);
  });

  it("PASS when all 4 conditions met", () => {
    const r = runCarryForwardEvaluation([goodPos], settings);
    expect(r.outcome).toBe("PASS");
    expect(r.tradesToExit).toEqual([]);
    expect(r.evalRecord.positions[0].decision).toBe("CARRY");
  });

  it("FAIL when profitPercent below threshold", () => {
    const r = runCarryForwardEvaluation([{ ...goodPos, profitPercent: 10 }], settings);
    expect(r.outcome).toBe("FAIL");
    expect(r.tradesToExit).toEqual(["T1"]);
    expect(r.evalRecord.positions[0].failedConditions[0]).toContain("profitPercent");
  });

  it("FAIL when momentum below threshold", () => {
    const r = runCarryForwardEvaluation([{ ...goodPos, momentumScore: 50 }], settings);
    expect(r.outcome).toBe("FAIL");
    expect(r.evalRecord.positions[0].failedConditions[0]).toContain("momentumScore");
  });

  it("FAIL when DTE below threshold", () => {
    const r = runCarryForwardEvaluation([{ ...goodPos, dte: 1 }], settings);
    expect(r.outcome).toBe("FAIL");
    expect(r.evalRecord.positions[0].failedConditions[0]).toContain("dte");
  });

  it("FAIL when IV does not match required condition", () => {
    const r = runCarryForwardEvaluation([{ ...goodPos, ivLabel: "expensive" }], settings);
    expect(r.outcome).toBe("FAIL");
    expect(r.evalRecord.positions[0].failedConditions.some(s => s.includes("iv"))).toBe(true);
  });

  it("ivCondition='any' lets any IV through", () => {
    const lax = makeSettings({
      carryForward: { ...settings.capitalProtection.carryForward, ivCondition: "any" },
    });
    const r = runCarryForwardEvaluation([{ ...goodPos, ivLabel: "expensive" }], lax);
    expect(r.outcome).toBe("PASS");
  });

  it("mixed batch — PASS some, FAIL others; tradesToExit lists only FAIL", () => {
    const r = runCarryForwardEvaluation(
      [
        { ...goodPos, tradeId: "T1" },
        { ...goodPos, tradeId: "T2", dte: 0 },
        { ...goodPos, tradeId: "T3" },
      ],
      settings,
    );
    expect(r.outcome).toBe("FAIL");
    expect(r.tradesToExit).toEqual(["T2"]);
  });
});

describe("parseHHmm", () => {
  it("parses valid HH:mm", () => {
    expect(parseHHmm("00:00")).toBe(0);
    expect(parseHHmm("15:15")).toBe(15 * 60 + 15);
    expect(parseHHmm("23:59")).toBe(23 * 60 + 59);
  });
  it("throws on invalid input", () => {
    expect(() => parseHHmm("xyz")).toThrow();
    expect(() => parseHHmm("25:00")).toThrow();
    expect(() => parseHHmm("12:60")).toThrow();
  });
});

describe("getCarryForwardEvalTime", () => {
  const settings = makeSettings({
    carryForward: {
      ...DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection.carryForward,
      nseEvalTime: "15:15",
      mcxEvalTime: "23:15",
    },
  });
  it("returns NSE eval time for NSE", () => {
    expect(getCarryForwardEvalTime(settings, "NSE")).toBe("15:15");
  });
  it("returns MCX eval time for MCX", () => {
    expect(getCarryForwardEvalTime(settings, "MCX")).toBe("23:15");
  });
});

// ─── Scheduler math ───────────────────────────────────────────────

describe("msToNextIstHHmm", () => {
  // 10:30 IST today = 05:00 UTC
  const noonIst = new Date("2026-04-28T06:30:00Z"); // 12:00 IST

  it("computes ms to a future-today time", () => {
    // 12:00 IST → 15:15 IST = 3h 15min = 195 min
    const ms = msToNextIstHHmm("15:15", noonIst);
    expect(ms).toBeGreaterThanOrEqual(195 * 60_000 - 1000);
    expect(ms).toBeLessThanOrEqual(195 * 60_000 + 1000);
  });

  it("computes ms to a past-today time as next-day", () => {
    // 12:00 IST → 09:15 IST tomorrow = 21h 15min = 1275 min
    const ms = msToNextIstHHmm("09:15", noonIst);
    expect(ms).toBeGreaterThanOrEqual(1275 * 60_000 - 1000);
    expect(ms).toBeLessThanOrEqual(1275 * 60_000 + 1000);
  });

  it("MCX eval (23:15 IST) from afternoon (15:00 IST) = 8h 15min", () => {
    const afternoonIst = new Date("2026-04-28T09:30:00Z"); // 15:00 IST
    const ms = msToNextIstHHmm("23:15", afternoonIst);
    expect(ms).toBeGreaterThanOrEqual(495 * 60_000 - 1000);
    expect(ms).toBeLessThanOrEqual(495 * 60_000 + 1000);
  });
});
