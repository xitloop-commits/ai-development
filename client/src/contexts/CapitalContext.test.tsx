/**
 * G5 — CapitalContext
 *
 * Coverage scope:
 *   - `useCapital()` throws when used outside a provider (locked
 *     contract — components rely on this for fail-fast behaviour).
 *   - `StaticCapitalProvider` smoke — provider/consumer wiring works.
 *   - Channel state derivation in StaticCapitalProvider — setChannel
 *     updates what useCapital() returns.
 *
 * Out of scope: the production `CapitalProvider` is heavily wired to
 * tRPC mutations; mocking the entire @trpc surface for an integration
 * test is a multi-hour exercise that doesn't add proportional value
 * over verifying `StaticCapitalProvider` (which is the test seam the
 * codebase already uses for snapshot/Storybook scenarios).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useState } from "react";
import {
  StaticCapitalProvider,
  useCapital,
  useRefetchOnDayRollover,
  type CapitalContextValue,
} from "./CapitalContext";

function makeStaticValue(overrides: Partial<CapitalContextValue> = {}): CapitalContextValue {
  return {
    channel: "paper",
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
    injectPending: false,
    withdraw: vi.fn(),
    withdrawPending: false,
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

describe("useCapital — provider boundary", () => {
  it("throws a clear error when called outside a CapitalProvider", () => {
    function Naked() {
      useCapital();
      return null;
    }
    // Suppress React's noisy error logging for this expected throw.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Naked />)).toThrow(/must be used within a CapitalProvider/);
    errSpy.mockRestore();
  });
});

describe("StaticCapitalProvider — provider/consumer wiring", () => {
  it("makes the supplied value visible to children via useCapital()", () => {
    const value = makeStaticValue({ channel: "live" });
    function Child() {
      const ctx = useCapital();
      return <div data-testid="ch">{ctx.channel}</div>;
    }
    render(
      <StaticCapitalProvider value={value}>
        <Child />
      </StaticCapitalProvider>,
    );
    expect(screen.getByTestId("ch")).toHaveTextContent("live");
  });

  it("exposes the capital tradingPool to children", () => {
    const value = makeStaticValue({
      capital: { ...makeStaticValue().capital, tradingPool: 250_000 },
    });
    function Child() {
      const ctx = useCapital();
      return <div data-testid="pool">{ctx.capital.tradingPool}</div>;
    }
    render(
      <StaticCapitalProvider value={value}>
        <Child />
      </StaticCapitalProvider>,
    );
    expect(screen.getByTestId("pool")).toHaveTextContent("250000");
  });

  it("forwards setChannel calls to the provided handler (mutation invalidation seam)", () => {
    const setChannel = vi.fn();
    const value = makeStaticValue({ channel: "paper", setChannel });
    function Child() {
      const ctx = useCapital();
      return (
        <button onClick={() => ctx.setChannel("live")} data-testid="btn">
          go-live
        </button>
      );
    }
    render(
      <StaticCapitalProvider value={value}>
        <Child />
      </StaticCapitalProvider>,
    );
    act(() => {
      screen.getByTestId("btn").click();
    });
    expect(setChannel).toHaveBeenCalledWith("live");
  });

  it("re-renders children when the parent advances the value", () => {
    function Wrapper() {
      const [value, setValue] = useState(() =>
        makeStaticValue({ channel: "paper" }),
      );
      function Child() {
        const ctx = useCapital();
        return (
          <button
            data-testid="cycle"
            onClick={() => setValue(makeStaticValue({ channel: "live" }))}
          >
            {ctx.channel}
          </button>
        );
      }
      return (
        <StaticCapitalProvider value={value}>
          <Child />
        </StaticCapitalProvider>
      );
    }
    render(<Wrapper />);
    expect(screen.getByTestId("cycle")).toHaveTextContent("paper");
    act(() => {
      screen.getByTestId("cycle").click();
    });
    expect(screen.getByTestId("cycle")).toHaveTextContent("live");
  });

  it("propagates pending flags so consumers can disable mutating UI", () => {
    const value = makeStaticValue({ injectPending: true, placeTradePending: true });
    function Child() {
      const ctx = useCapital();
      return (
        <>
          <span data-testid="inject">{String(ctx.injectPending)}</span>
          <span data-testid="place">{String(ctx.placeTradePending)}</span>
          <span data-testid="exit">{String(ctx.exitTradePending)}</span>
        </>
      );
    }
    render(
      <StaticCapitalProvider value={value}>
        <Child />
      </StaticCapitalProvider>,
    );
    expect(screen.getByTestId("inject")).toHaveTextContent("true");
    expect(screen.getByTestId("place")).toHaveTextContent("true");
    expect(screen.getByTestId("exit")).toHaveTextContent("false");
  });
});

/**
 * Day-rollover refetch — the fix for "records vanish when the day cycle
 * finishes". PA advances currentDayIndex on completion, but the allDays query
 * doesn't poll, so without this the UI resolves `currentDay` by index into a
 * stale, empty FUTURE day and every record disappears until a manual refresh.
 */
describe("useRefetchOnDayRollover", () => {
  function Harness({ dayIndex, refetch }: { dayIndex: number; refetch: () => void }) {
    useRefetchOnDayRollover(dayIndex, refetch);
    return null;
  }

  it("does NOT refetch on first render (an initial index is not a rollover)", () => {
    const refetch = vi.fn();
    render(<Harness dayIndex={7} refetch={refetch} />);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("refetches once when the day index advances", () => {
    const refetch = vi.fn();
    const { rerender } = render(<Harness dayIndex={7} refetch={refetch} />);
    rerender(<Harness dayIndex={8} refetch={refetch} />);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT refetch when the index is unchanged across re-renders", () => {
    const refetch = vi.fn();
    const { rerender } = render(<Harness dayIndex={7} refetch={refetch} />);
    rerender(<Harness dayIndex={7} refetch={refetch} />);
    rerender(<Harness dayIndex={7} refetch={refetch} />);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("refetches again on a second rollover", () => {
    const refetch = vi.fn();
    const { rerender } = render(<Harness dayIndex={7} refetch={refetch} />);
    rerender(<Harness dayIndex={8} refetch={refetch} />);
    rerender(<Harness dayIndex={9} refetch={refetch} />);
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
