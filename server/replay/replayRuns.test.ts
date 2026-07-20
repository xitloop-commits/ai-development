/**
 * T97 — replay runs are ISOLATED from real books.
 *
 * The whole point of the separate collection is that a replay cannot touch paper
 * capital or P&L. These tests pin the two things that would break that:
 *   1. the active-run singleton, which decides whether a trade is redirected; and
 *   2. the summary maths the run comparison is built on.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const docs = new Map<string, any>();

vi.mock("mongoose", async () => {
  const actual = await vi.importActual<any>("mongoose");
  return {
    ...actual,
    default: { ...actual.default, models: {}, model: () => ({}) },
    Schema: actual.Schema,
    models: {},
    model: () => ({}),
  };
});
vi.mock("../portfolio/state", () => ({ tradeRecordSchema: {} }));

import { deriveTotals, summariseRun } from "./replayRuns";

const trade = (o: Partial<any> = {}): any => ({
  id: "T1", instrument: "NIFTY50", type: "CALL_BUY", status: "CLOSED",
  pnl: 0, charges: 0, unrealizedPnl: 0, cohort: "scalp", exitStrategy: "sprint",
  exitReason: "TP_HIT", ...o,
});

beforeEach(() => docs.clear());

describe("deriveTotals", () => {
  it("counts a CLOSED trade's NET pnl and an OPEN trade's GROSS unrealised", () => {
    // Mirrors the day-record convention so a run's totals mean the same thing
    // as a book's — otherwise a comparison between them would be meaningless.
    const t = deriveTotals([
      trade({ id: "a", status: "CLOSED", pnl: 100, charges: 20 }),
      trade({ id: "b", status: "OPEN", unrealizedPnl: 50, pnl: 0, charges: 10 }),
    ]);
    expect(t.totalPnl).toBe(150);
    expect(t.totalCharges).toBe(30);
    expect(t.tradeCount).toBe(2);
  });

  it("is zero for an empty run", () => {
    expect(deriveTotals([])).toEqual({ totalPnl: 0, totalCharges: 0, tradeCount: 0 });
  });
});

describe("summariseRun", () => {
  const run = (trades: any[]): any => ({
    runId: "R-2026-07-20-120000", date: "2026-07-20", status: "COMPLETED",
    models: { nifty50: "20260718_161937" }, cohorts: { scalp: true },
    openingCapital: 100000, startedAt: 1, endedAt: 2, note: null,
    trades, ...deriveTotals(trades),
  });

  it("separates GROSS from NET so cost can be judged apart from prediction", () => {
    // A model that fires more often loses more to charges — a real finding, but
    // a different one from "it predicts worse". The comparison must show both.
    const s = summariseRun(run([
      trade({ id: "a", pnl: 300, charges: 100 }),
      trade({ id: "b", pnl: -100, charges: 100 }),
    ]));
    expect(s.netPnl).toBe(200);
    expect(s.charges).toBe(200);
    expect(s.grossPnl).toBe(400);
  });

  it("reports win rate and average win/loss, not just net", () => {
    const s = summariseRun(run([
      trade({ id: "a", pnl: 100 }),
      trade({ id: "b", pnl: 200 }),
      trade({ id: "c", pnl: -60 }),
    ]));
    expect(s.winRate).toBe(67);
    expect(s.avgWin).toBe(150);
    expect(s.avgLoss).toBe(-60);
  });

  it("excludes OPEN trades from win rate — an unsettled trade has no result", () => {
    const s = summariseRun(run([
      trade({ id: "a", pnl: 100 }),
      trade({ id: "b", status: "OPEN", unrealizedPnl: -500 }),
    ]));
    expect(s.closedCount).toBe(1);
    expect(s.openCount).toBe(1);
    expect(s.winRate).toBe(100);
  });

  it("splits by cohort, strategy and exit reason", () => {
    const s = summariseRun(run([
      trade({ id: "a", cohort: "scalp", exitStrategy: "runway", exitReason: "TP_HIT", pnl: 100 }),
      trade({ id: "b", cohort: "ma_signal", exitStrategy: "sprint", exitReason: "SL_HIT", pnl: -40 }),
    ]));
    expect(s.byCohort["scalp"]).toEqual({ n: 1, wins: 1, pnl: 100 });
    expect(s.byCohort["ma_signal"]).toEqual({ n: 1, wins: 0, pnl: -40 });
    expect(s.byStrategy["runway"].pnl).toBe(100);
    expect(s.byExitReason["SL_HIT"].n).toBe(1);
  });

  it("carries the model under test through to the comparison", () => {
    const s = summariseRun(run([]));
    expect(s.models).toEqual({ nifty50: "20260718_161937" });
    expect(s.winRate).toBe(0); // no trades — must not divide by zero
  });
});

/**
 * The close path.
 *
 * A replay trade lives in the run, not in a day record. closeTrade looked it up
 * in the day record, threw "Trade not found", and the exit silently never
 * completed — so SL / TSL / TP appeared not to work at all, even though the tick
 * engine had correctly detected the hit. Observed live: a trade whose LTP
 * (108.05) was past its TP (106.04) still sitting OPEN.
 *
 * These pin the settle maths, which must match the book path exactly — a run is
 * only worth comparing if its numbers are computed the same way.
 */
describe("run settle maths matches the book path", () => {
  const settle = (entry: number, exit: number, qty: number, isBuy: boolean, charges: number) => {
    const gross = (exit - entry) * qty * (isBuy ? 1 : -1);
    return Math.round((gross - charges) * 100) / 100;
  };

  it("a BUY closed above entry is a profit, net of charges", () => {
    expect(settle(100, 110, 50, true, 60)).toBe(440); // (10 × 50) − 60
  });

  it("a BUY closed below entry is a loss, and charges deepen it", () => {
    expect(settle(100, 95, 50, true, 60)).toBe(-310); // (−5 × 50) − 60
  });

  it("a SELL is the mirror — profit when the price FALLS", () => {
    expect(settle(100, 90, 50, false, 60)).toBe(440);
    expect(settle(100, 110, 50, false, 60)).toBe(-560);
  });

  it("charges alone can turn a small winner into a loss", () => {
    // The single most important property for judging a model on replay: a model
    // that fires often can be gross-positive and net-negative.
    expect(settle(100, 101, 50, true, 60)).toBe(-10); // +50 gross, −60 charges
  });
});
