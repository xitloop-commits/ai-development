/**
 * G5 — TradingDesk
 *
 * The component is a slim container that fans out to two custom hooks
 * (useTradingDeskData / useTradingDeskHandlers) plus a tree of presentational
 * children. Locking the three top-level render branches:
 *
 *   1. capitalLoading → renders the skeleton shell.
 *   2. !capitalReady (load failed) → renders the error state with retry.
 *   3. ready + allDays.length === 0 → renders the "no capital" empty state.
 *   4. ready + days populated → renders the table with the today P&L bar
 *      and the expected per-day rows.
 *
 * The two custom hooks are mocked so we don't need a tRPC harness and
 * a feed subscriber to render the component.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock the tRPC client surface used by TradingDesk's child components
// (TodaySection calls executor.updateTrade.useMutation, etc.). Bare-
// minimum stubs that return the shape react-query consumers expect.
const noopMutation = {
  mutate: vi.fn(),
  mutateAsync: vi.fn(async () => undefined),
  isPending: false,
  isLoading: false,
  isError: false,
  isSuccess: false,
  error: null,
  data: undefined,
  reset: vi.fn(),
};
vi.mock("@/lib/trpc", () => ({
  trpc: {
    executor: {
      updateTrade: { useMutation: () => noopMutation },
      placeTrade: { useMutation: () => noopMutation },
      exitTrade: { useMutation: () => noopMutation },
    },
    portfolio: {
      updateLtp: { useMutation: () => noopMutation },
      clearWorkspace: { useMutation: () => noopMutation }, // CLEAR moved into the desk (T130)
    },
    // TodaySection reads the shared exit config for the cooling-window countdown.
    trading: {
      aiConfig: { useQuery: () => ({ data: undefined }) },
    },
    // TradingDesk queries the selected replay run (T97); none selected here.
    replay: {
      run: { useQuery: () => ({ data: undefined }) },
      runs: { useQuery: () => ({ data: [] }) },
      compare: { useQuery: () => ({ data: undefined }) },
      deleteRun: { useMutation: () => noopMutation },
    },
    broker: {
      config: { get: { useQuery: () => ({ data: undefined }) } },
      feed: {
        subscribe: { useMutation: () => noopMutation },
        unsubscribe: { useMutation: () => noopMutation },
        state: { useQuery: () => ({ data: undefined }) },
        snapshot: { useQuery: () => ({ data: undefined }) },
      },
    },
    useUtils: () => ({
      portfolio: {
        state: { invalidate: vi.fn(async () => undefined) },
        currentDay: { invalidate: vi.fn(async () => undefined) },
        allDays: { invalidate: vi.fn(async () => undefined) },
        futureDays: { invalidate: vi.fn(async () => undefined) },
      },
    }),
  },
}));

// Mock the two custom hooks BEFORE importing the component. These hooks
// otherwise reach into tRPC + feed subscriptions, which we don't need
// for branch-level rendering tests.
vi.mock("@/hooks/useTradingDeskData", () => ({
  useTradingDeskData: () => ({
    getLiveLtp: vi.fn(() => 0),
    subscribeOptionFeed: vi.fn(),
  }),
}));

vi.mock("@/hooks/useTradingDeskHandlers", () => ({
  useTradingDeskHandlers: () => ({
    confirmDialog: { isOpen: false },
    closeConfirmDialog: vi.fn(),
    highlightedDay: null,
    handlePlaceTrade: vi.fn(),
    handleExitTrade: vi.fn(),
    handleExitAll: vi.fn(),
    scrollToDay: vi.fn(),
  }),
}));

import TradingDesk from "./TradingDesk";
import {
  StaticCapitalProvider,
  type CapitalContextValue,
  type DayRecord,
} from "@/contexts/CapitalContext";

function makeDay(overrides: Partial<DayRecord> = {}): DayRecord {
  return {
    dayIndex: 1,
    date: "2026-04-01",
    tradeCapital: 100_000,
    targetPercent: 5,
    targetAmount: 5_000,
    projCapital: 105_000,
    originalProjCapital: 105_000,
    actualCapital: 100_000,
    deviation: 0,
    totalPnl: 0,
    totalCharges: 0,
    totalQty: 0,
    instruments: [],
    trades: [],
    status: "FUTURE",
    rating: "future",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<CapitalContextValue> = {}): CapitalContextValue {
  return {
    // live → AI workspace: read-only desk (no manual-controls stack), so these
    // branch-render tests stay lean (paper would pull the whole order-entry tree).
    channel: "live",
    setChannel: vi.fn(),
    capital: {
      tradingPool: 100_000,
      reservePool: 0,
      currentDayIndex: 1,
      targetPercent: 5,
      availableCapital: 100_000,
      netWorth: 100_000,
      cumulativePnl: 0,
      cumulativeCharges: 0,
      todayPnl: 0,
      todayTarget: 5_000,
      initialFunding: 100_000,
      openPositionMargin: 0,
      quarterlyProjection: null,
      allQuarterlyProjections: [],
    },
    capitalLoading: false,
    capitalReady: true,
    allDays: [],
    currentDay: null,
    allDaysLoading: false,
    stateData: null,
    allDaysData: null,
    inject: vi.fn(),
    withdraw: vi.fn(),
    withdrawPending: false,
    injectPending: false,
    placeTrade: vi.fn(),
    placeTradePending: false,
    exitTrade: vi.fn(),
    exitTradePending: false,
    updateLtp: vi.fn(),
    syncDailyTarget: vi.fn(),
    syncDailyTargetPending: false,
    resetCapital: vi.fn(),
    resetCapitalPending: false,
    transferFunds: vi.fn(),
    transferFundsPending: false,
    refetchAll: vi.fn(),
    ...overrides,
  };
}

function renderWith(ctx: CapitalContextValue) {
  return render(
    <StaticCapitalProvider value={ctx}>
      <TradingDesk />
    </StaticCapitalProvider>,
  );
}

describe("TradingDesk — render branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the loading skeleton while capitalLoading is true", () => {
    const ctx = makeCtx({ capitalLoading: true, capitalReady: false });
    const { container } = renderWith(ctx);
    // The skeleton emits an animate-pulse element class. Use container
    // queries instead of role/text since the skeleton is purely visual.
    expect(container.querySelector('[class*="pulse"], [class*="skeleton"], [aria-busy]')).toBeTruthy();
  });

  it("renders the error state with retry when !capitalReady", () => {
    const refetchAll = vi.fn();
    const ctx = makeCtx({ capitalReady: false, refetchAll });
    renderWith(ctx);
    // The error message comes from TradingDesk's literal string.
    expect(screen.getByText(/Failed to load capital data/i)).toBeInTheDocument();
  });

  it("renders the no-capital empty state when ready but allDays is empty", () => {
    const ctx = makeCtx({ allDays: [] });
    const { container } = renderWith(ctx);
    // No table is rendered when allDays is empty.
    expect(container.querySelector("table")).toBeNull();
  });

  it("renders the table with day rows when allDays is populated", () => {
    const days: DayRecord[] = [
      makeDay({ dayIndex: 1, status: "ACTIVE", date: "2026-04-01" }),
      makeDay({ dayIndex: 2, status: "FUTURE", date: "2026-04-02" }),
      makeDay({ dayIndex: 3, status: "FUTURE", date: "2026-04-03" }),
    ];
    const ctx = makeCtx({
      allDays: days,
      currentDay: days[0],
      capital: { ...makeCtx().capital, currentDayIndex: 1 },
    });
    const { container } = renderWith(ctx);

    expect(container.querySelector("table")).toBeInTheDocument();
    // Day 1 row exists (FutureRow / TodaySection / PastRow all set data-day).
    expect(container.querySelector('[data-day="1"]')).toBeInTheDocument();
    expect(container.querySelector('[data-day="2"]')).toBeInTheDocument();
    expect(container.querySelector('[data-day="3"]')).toBeInTheDocument();
  });

  it("renders the column header set the spec calls for", () => {
    const days: DayRecord[] = [makeDay({ dayIndex: 1, status: "ACTIVE" })];
    const ctx = makeCtx({ allDays: days, currentDay: days[0] });
    renderWith(ctx);

    // Column headers are uppercase in the DOM but text matchers normalise.
    for (const label of ["Day", "Date", "Capital", "Instrument", "Entry", "LTP", "Lot", "Invested", "Points", "Rating"]) {
      expect(screen.getAllByText(new RegExp(`^${label}$`, "i"))[0]).toBeInTheDocument();
    }
  });

  /**
   * The desk is a real <table>: the colgroup, the header and every body row must
   * agree on the column count or the whole grid shifts — cells land under the
   * wrong headers and nothing errors. The previous header test asserted only
   * that a handful of labels existed, so dropping a column passed silently.
   */
  it("colgroup and header agree on the column count", () => {
    const days: DayRecord[] = [makeDay({ dayIndex: 1, status: "ACTIVE" })];
    const { container } = renderWith(makeCtx({ allDays: days, currentDay: days[0] }));

    const cols = container.querySelectorAll("colgroup col");
    const ths = container.querySelectorAll("thead th");
    expect(cols.length).toBe(ths.length);
    expect(ths.length).toBe(16);
  });

  it("no longer renders the Dev. column (its width went to Instrument)", () => {
    const days: DayRecord[] = [makeDay({ dayIndex: 1, status: "ACTIVE" })];
    renderWith(makeCtx({ allDays: days, currentDay: days[0] }));

    expect(screen.queryByText(/^Dev\.?$/i)).toBeNull();
  });
});
