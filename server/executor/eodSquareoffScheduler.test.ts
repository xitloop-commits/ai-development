/**
 * T86 γ — EOD auto square-off.
 *
 * Two layers under test:
 *   1. runEodSquareoff — flattens the right trades (NSE vs MCX split, CNC held,
 *      holiday skip, failure accounting) via the normal exit path.
 *   2. checkOnce — the minute checker's config + IST-clock gate + once-per-day
 *      idempotency guard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { listOpenTradesMock, exitTradeMock, getSettingsMock, isTodayHolidayMock, aiSquareoffMock } = vi.hoisted(() => ({
  listOpenTradesMock: vi.fn(async (_channel: string) => [] as any[]),
  exitTradeMock: vi.fn(async () => ({ success: true, error: undefined }) as any),
  getSettingsMock: vi.fn(async () => ({
    eodSquareoffEnabled: true,
    eodSquareoffNseTime: "15:25",
    eodSquareoffMcxTime: "23:25",
  })),
  isTodayHolidayMock: vi.fn((_ex: string) => ({ isHoliday: false })),
  // Per-mode square-off: AI channels (paper/ai-live) read this; my-live uses
  // the executor settings above.
  aiSquareoffMock: vi.fn(() => ({ enabled: true, nseTime: "15:25", mcxTime: "23:25" })),
}));

vi.mock("../portfolio", () => ({
  portfolioAgent: { listOpenTrades: listOpenTradesMock },
}));
vi.mock("./tradeExecutor", () => ({
  tradeExecutor: { exitTrade: exitTradeMock },
}));
vi.mock("./settings", () => ({
  getExecutorSettings: getSettingsMock,
}));
vi.mock("../portfolio/aiModeConfig", () => ({
  aiModeForChannel: (ch: string) => (ch === "paper" ? "paper" : ch === "ai-live" ? "live" : null),
  getAiConfig: () => ({ squareoff: aiSquareoffMock() }),
}));
vi.mock("../holidays", () => ({
  isTodayHoliday: isTodayHolidayMock,
}));
vi.mock("../broker/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), important: vi.fn() }),
}));

import {
  runEodSquareoff,
  checkOnce,
  exchangeForInstrument,
  _resetEodSquareoffGuard,
} from "./eodSquareoffScheduler";

function trade(overrides: any = {}) {
  return {
    id: "T1",
    instrument: "BANKNIFTY",
    status: "OPEN",
    productType: undefined,
    ...overrides,
  };
}

/** Route each channel's open list through one map. */
function openBy(map: Record<string, any[]>) {
  listOpenTradesMock.mockImplementation(async (channel: string) => map[channel] ?? []);
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetEodSquareoffGuard();
  listOpenTradesMock.mockImplementation(async () => []);
  exitTradeMock.mockResolvedValue({ success: true, error: undefined } as any);
  getSettingsMock.mockResolvedValue({
    eodSquareoffEnabled: true,
    eodSquareoffNseTime: "15:25",
    eodSquareoffMcxTime: "23:25",
  } as any);
  isTodayHolidayMock.mockReturnValue({ isHoliday: false } as any);
  aiSquareoffMock.mockReturnValue({ enabled: true, nseTime: "15:25", mcxTime: "23:25" });
});

describe("exchangeForInstrument", () => {
  it("maps crude/natural gas to MCX, everything else to NSE", () => {
    expect(exchangeForInstrument("CRUDEOIL")).toBe("MCX");
    expect(exchangeForInstrument("NATURALGAS")).toBe("MCX");
    expect(exchangeForInstrument("BANKNIFTY")).toBe("NSE");
    expect(exchangeForInstrument("NIFTY_50")).toBe("NSE");
    expect(exchangeForInstrument("ICICIBANK")).toBe("NSE");
  });
});

describe("runEodSquareoff", () => {
  it("flattens only NSE, non-CNC open trades — across all channels", async () => {
    openBy({
      paper: [
        trade({ id: "T1", instrument: "BANKNIFTY" }),               // NSE option → flatten
        trade({ id: "T2", instrument: "CRUDEOIL" }),                // MCX → skip on NSE run
        trade({ id: "T3", instrument: "ICICIBANK", productType: "CNC" }), // delivery → held
      ],
      "ai-live": [trade({ id: "T4", instrument: "NIFTY_50" })],     // NSE → flatten
      "my-live": [],
    });

    const res = await runEodSquareoff("NSE", "2026-07-20");

    expect(res).toEqual({ exited: 2, failed: 0, heldCnc: 1 });
    expect(exitTradeMock).toHaveBeenCalledTimes(2);
    const ids = exitTradeMock.mock.calls.map((c) => c[0].positionId);
    expect(ids).toContain("POS-1"); // T1
    expect(ids).toContain("POS-4"); // T4
    // Correct request shape on the first call.
    expect(exitTradeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "EOD-paper-T1-2026-07-20",
        positionId: "POS-1",
        channel: "paper",
        exitType: "MARKET",
        reason: "EOD_SQUAREOFF",
        triggeredBy: "PA",
      }),
    );
  });

  it("MCX run flattens only the commodity trades", async () => {
    openBy({
      paper: [
        trade({ id: "T1", instrument: "BANKNIFTY" }),  // NSE → skip on MCX run
        trade({ id: "T2", instrument: "CRUDEOIL" }),   // MCX → flatten
      ],
      "ai-live": [],
      "my-live": [],
    });

    const res = await runEodSquareoff("MCX", "2026-07-20");

    expect(res).toEqual({ exited: 1, failed: 0, heldCnc: 0 });
    expect(exitTradeMock).toHaveBeenCalledTimes(1);
    expect(exitTradeMock).toHaveBeenCalledWith(
      expect.objectContaining({ positionId: "POS-2", reason: "EOD_SQUAREOFF" }),
    );
  });

  it("does nothing on a market holiday", async () => {
    isTodayHolidayMock.mockReturnValue({ isHoliday: true } as any);
    openBy({ paper: [trade({ id: "T1", instrument: "BANKNIFTY" })] });

    const res = await runEodSquareoff("NSE", "2026-07-20");

    expect(res).toEqual({ exited: 0, failed: 0, heldCnc: 0 });
    expect(exitTradeMock).not.toHaveBeenCalled();
    expect(listOpenTradesMock).not.toHaveBeenCalled();
  });

  it("counts a failed exit without throwing", async () => {
    openBy({ paper: [trade({ id: "T1", instrument: "BANKNIFTY" })] });
    exitTradeMock.mockResolvedValueOnce({ success: false, error: "broker desync" } as any);

    const res = await runEodSquareoff("NSE", "2026-07-20");

    expect(res).toEqual({ exited: 0, failed: 1, heldCnc: 0 });
  });

  it("skips a trade that is no longer OPEN (defensive re-check)", async () => {
    openBy({ paper: [trade({ id: "T1", instrument: "BANKNIFTY", status: "CLOSED" })] });

    const res = await runEodSquareoff("NSE", "2026-07-20");

    expect(res).toEqual({ exited: 0, failed: 0, heldCnc: 0 });
    expect(exitTradeMock).not.toHaveBeenCalled();
  });
});

describe("checkOnce — config + IST-clock gate + once-per-day guard", () => {
  it("does not fire before the configured NSE time", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-20T09:54:00Z")); // 15:24 IST — one min early
      openBy({ paper: [trade({ id: "T1", instrument: "BANKNIFTY" })] });

      await checkOnce();

      expect(exitTradeMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires once when the NSE time is reached, and never twice the same day", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-20T09:55:00Z")); // 15:25 IST exactly
      openBy({ paper: [trade({ id: "T1", instrument: "BANKNIFTY" })] });

      await checkOnce();
      expect(exitTradeMock).toHaveBeenCalledTimes(1);
      expect(exitTradeMock).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "EOD_SQUAREOFF", channel: "paper" }),
      );

      // A minute later the time is still "reached" but the day-guard blocks a re-fire.
      vi.setSystemTime(new Date("2026-07-20T09:56:00Z"));
      await checkOnce();
      expect(exitTradeMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire when the feature is disabled", async () => {
    vi.useFakeTimers();
    try {
      aiSquareoffMock.mockReturnValue({ enabled: false, nseTime: "15:25", mcxTime: "23:25" });
      vi.setSystemTime(new Date("2026-07-20T09:55:00Z")); // 15:25 IST
      openBy({ paper: [trade({ id: "T1", instrument: "BANKNIFTY" })] });

      await checkOnce();

      expect(exitTradeMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours a configured NSE time change (config re-read each pass)", async () => {
    vi.useFakeTimers();
    try {
      aiSquareoffMock.mockReturnValue({ enabled: true, nseTime: "15:10", mcxTime: "23:25" }); // earlier than default
      vi.setSystemTime(new Date("2026-07-20T09:41:00Z")); // 15:11 IST — past 15:10
      openBy({ paper: [trade({ id: "T1", instrument: "BANKNIFTY" })] });

      await checkOnce();

      expect(exitTradeMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
