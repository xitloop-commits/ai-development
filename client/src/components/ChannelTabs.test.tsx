/**
 * UI-119 — ChannelTabs.
 *
 * Locked behaviours:
 *
 *   1. Three workspace tabs render (AI / My / Testing) with the current
 *      workspace marked active.
 *   2. A live-mode active tab shows the green pulse dot.
 *   3. Clicking the active tab is a no-op (no confirm popover).
 *   4. Clicking a non-active tab opens a confirm popover; cancelling
 *      keeps the channel; confirming calls setChannel with the target
 *      derived from the workspace's `lastModeForWs` entry.
 *   5. Last-used mode memory: switching from `ai-live` to `my` then
 *      back to `ai` lands on `ai-live` again (not `ai-paper`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ChannelTabs, TAB_DEFS, lastModeForWs } from "./ChannelTabs";
import {
  StaticCapitalProvider,
  type CapitalContextValue,
} from "@/contexts/CapitalContext";

function makeCtx(channel: any, setChannel = vi.fn()): CapitalContextValue {
  return {
    channel,
    setChannel,
    capital: {} as any,
    capitalLoading: false,
    capitalReady: true,
    allDays: [],
    currentDay: null,
    allDaysLoading: false,
    stateData: null,
    allDaysData: null,
    inject: vi.fn(),
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
  };
}

function renderWith(channel: any, setChannel = vi.fn()) {
  const ctx = makeCtx(channel, setChannel);
  const result = render(
    <StaticCapitalProvider value={ctx}>
      <ChannelTabs />
    </StaticCapitalProvider>,
  );
  return { ...result, setChannel };
}

describe("ChannelTabs — render", () => {
  beforeEach(() => {
    // Reset module memory so tests don't leak state into each other.
    lastModeForWs.ai = "paper";
    lastModeForWs.my = "paper";
    lastModeForWs.testing = "sandbox";
  });

  it("renders the three workspace tab labels in TAB_DEFS order", () => {
    renderWith("ai-paper");
    const labels = screen.getAllByRole("button").map((b) => b.textContent?.trim());
    // The labels include the green dot suffix when live, but the
    // base label is always present at the start.
    for (const def of TAB_DEFS) {
      expect(labels.some((l) => l?.includes(def.label))).toBe(true);
    }
  });

  it("does not render the live pulse dot for paper / sandbox channels", () => {
    const { container } = renderWith("ai-paper");
    const dots = container.querySelectorAll(".animate-pulse");
    expect(dots.length).toBe(0);
  });

  it("renders the live pulse dot only on the active live tab", () => {
    const { container } = renderWith("my-live");
    const dots = container.querySelectorAll(".animate-pulse");
    expect(dots.length).toBe(1);
  });
});

describe("ChannelTabs — switch confirmation", () => {
  beforeEach(() => {
    lastModeForWs.ai = "paper";
    lastModeForWs.my = "paper";
    lastModeForWs.testing = "sandbox";
  });

  it("clicking the active tab is a no-op (no confirm shown)", () => {
    const setChannel = vi.fn();
    renderWith("ai-paper", setChannel);

    const aiButton = screen.getByText(/AI Trades/);
    act(() => { aiButton.click(); });

    expect(setChannel).not.toHaveBeenCalled();
    expect(screen.queryByText(/Switch from/)).not.toBeInTheDocument();
  });

  it("clicking a non-active tab opens a confirm popover", () => {
    renderWith("ai-paper");
    const myButton = screen.getByText(/My Trades/);
    act(() => { myButton.click(); });

    expect(screen.getByText(/Switch from ai-paper to my-paper/)).toBeInTheDocument();
  });

  it("confirming the popover calls setChannel with the target channel", () => {
    const setChannel = vi.fn();
    renderWith("ai-paper", setChannel);

    act(() => { screen.getByText(/My Trades/).click(); });
    act(() => { screen.getByText(/Confirm/).click(); });

    expect(setChannel).toHaveBeenCalledWith("my-paper");
  });

  it("cancel hides the popover and does not switch", () => {
    const setChannel = vi.fn();
    renderWith("ai-paper", setChannel);

    act(() => { screen.getByText(/My Trades/).click(); });
    act(() => { screen.getByText(/Cancel/).click(); });

    expect(setChannel).not.toHaveBeenCalled();
    expect(screen.queryByText(/Switch from/)).not.toBeInTheDocument();
  });

  it("uses lastModeForWs to pick the target mode (not always 'paper')", () => {
    // Pretend the user previously visited `my-live`; that mode should
    // be remembered when switching back to the My workspace from AI.
    lastModeForWs.my = "live";
    const setChannel = vi.fn();
    renderWith("ai-paper", setChannel);

    act(() => { screen.getByText(/My Trades/).click(); });
    act(() => { screen.getByText(/Confirm/).click(); });

    expect(setChannel).toHaveBeenCalledWith("my-live");
  });

  it("targets testing-sandbox for testing workspace by default (not testing-paper which doesn't exist)", () => {
    const setChannel = vi.fn();
    renderWith("my-paper", setChannel);

    act(() => { screen.getByText(/Testing/).click(); });
    expect(screen.getByText(/Switch from my-paper to testing-sandbox/)).toBeInTheDocument();
  });
});

describe("ChannelTabs — last-mode memory mirror", () => {
  beforeEach(() => {
    lastModeForWs.ai = "paper";
    lastModeForWs.my = "paper";
    lastModeForWs.testing = "sandbox";
  });

  it("updates lastModeForWs[ai] when the active channel is ai-live", () => {
    renderWith("ai-live");
    // useEffect synchronously runs after render under jsdom.
    expect(lastModeForWs.ai).toBe("live");
  });

  it("updates lastModeForWs[testing] when the active channel is testing-sandbox", () => {
    renderWith("testing-sandbox");
    expect(lastModeForWs.testing).toBe("sandbox");
  });

  it("updates lastModeForWs[my] when the active channel is my-paper", () => {
    renderWith("my-paper");
    expect(lastModeForWs.my).toBe("paper");
  });
});
