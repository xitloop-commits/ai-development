import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the SEA store (no Mongo in unit tests). `find` is reset per test in
// beforeEach; default returns no rows → "detector has not flipped".
vi.mock("../seaSignalStore", () => ({
  SeaSignalModel: { find: () => ({ select: () => ({ lean: async () => [] as any[] }) }) },
}));
const NO_FLIP = () => ({ select: () => ({ lean: async () => [] as any[] }) });
// Mock the portfolio agent — default: nothing already open on either book.
const listOpenTrades = vi.fn(async () => [] as any[]);
vi.mock("../portfolio", () => ({ portfolioAgent: { listOpenTrades } }));

import { armReentryOnTrend, _resetReentryState } from "./reentryOnTrend";
import { updateCommonConfig } from "./aiModeConfig";

function trade(over: Partial<any> = {}): any {
  return {
    id: "T1", instrument: "banknifty", type: "CALL_BUY", strike: 52000,
    contractSecurityId: "SEC1", entryPrice: 120, qty: 15, cohort: "sma5_signal",
    source: "ai", expiry: "2026-08-07", ...over,
  };
}

describe("reentryOnTrend — arming guards", () => {
  let fetchMock: any;
  beforeEach(async () => {
    _resetReentryState();
    const { SeaSignalModel } = await import("../seaSignalStore");
    (SeaSignalModel.find as any) = NO_FLIP;
    listOpenTrades.mockResolvedValue([]);
    updateCommonConfig({ reentryOnTrend: { enabled: true, windowSec: 30, maxReentries: 3 } });
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, tradeId: "T2" }) }));
    (globalThis as any).fetch = fetchMock;
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); _resetReentryState(); });

  it("re-enters the SAME direction after the window on an SL_HIT", async () => {
    armReentryOnTrend(trade(), "paper", "SL_HIT");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.optionType).toBe("CE");
    expect(body.origin).toBe("AI");
    expect(body.instrument).toBe("banknifty");
    expect(body.strike).toBe(52000);
  });

  it("does NOT arm on the model's own exit (AI_EXIT)", async () => {
    armReentryOnTrend(trade(), "paper", "AI_EXIT");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT arm for a non-signal cohort", async () => {
    armReentryOnTrend(trade({ cohort: "scalp" }), "paper", "SL_HIT");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT arm for a hand-placed (my) trade", async () => {
    armReentryOnTrend(trade({ source: "my" }), "paper", "SL_HIT");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT arm when the feature is off", async () => {
    updateCommonConfig({ reentryOnTrend: { enabled: false, windowSec: 30, maxReentries: 3 } });
    armReentryOnTrend(trade(), "paper", "SL_HIT");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stands down when the detector has FLIPPED in the window", async () => {
    const { SeaSignalModel } = await import("../seaSignalStore");
    (SeaSignalModel.find as any) = () => ({
      select: () => ({ lean: async () => [{ action: "LONG_PE", instrument: "BANKNIFTY" }] }),
    });
    armReentryOnTrend(trade(), "paper", "SL_HIT");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips when a same-side position is already open", async () => {
    listOpenTrades.mockResolvedValue([{ instrument: "banknifty", cohort: "sma5_signal", type: "CALL_BUY" }]);
    armReentryOnTrend(trade(), "paper", "SL_HIT");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps re-entries per leg at maxReentries", async () => {
    updateCommonConfig({ reentryOnTrend: { enabled: true, windowSec: 30, maxReentries: 2 } });
    // 1st + 2nd re-entries place; 3rd is capped.
    for (let i = 0; i < 3; i++) {
      armReentryOnTrend(trade(), "paper", "SL_HIT");
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
