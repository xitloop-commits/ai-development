/**
 * Tests for B4-followup — RCA's per-channel BROKER_DESYNC kill switch.
 *
 * Scenario coverage:
 *   - notifyDesync increments the per-channel sliding-window counter
 *   - timestamps outside `windowSeconds` are evicted
 *   - per-channel isolation: a desync on ai-live doesn't trip my-live
 *   - threshold breach trips toggleWorkspaceKillSwitch + telegram alert
 *   - re-trip suppression: once tripped, subsequent desyncs don't
 *     re-fire alerts until clearDesyncCounter is called
 *   - disabled flag short-circuits everything
 *
 * Mocks the surrounding agents so the suite runs without Mongo / broker.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Mocks (hoisted) ────────────────────────────────────────────

vi.mock("../executor/tradeExecutor", () => ({
  tradeExecutor: { submitTrade: vi.fn(), exitTrade: vi.fn(), modifyOrder: vi.fn() },
}));

vi.mock("../portfolio", () => ({
  portfolioAgent: { getPositions: vi.fn(async () => []) },
}));

vi.mock("../broker/tickBus", () => ({
  tickBus: { emitTick: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock("../seaSignals", () => ({ getSEASignals: vi.fn(() => []) }));

const settingsMock = {
  desyncKillSwitchEnabled: true,
  desyncKillSwitchThreshold: 3,
  desyncKillSwitchWindowSeconds: 600,
  rcaMaxAgeMs: 30 * 60_000,
  rcaStaleTickMs: 5 * 60_000,
  rcaVolThreshold: 0.7,
  rcaChannels: [],
};

vi.mock("../executor/settings", () => ({
  getExecutorSettings: vi.fn(async () => settingsMock),
}));

const toggleKillSwitch = vi.fn(async () => ({ status: "OK", workspace: "ai", active: true }));
vi.mock("../broker/brokerService", () => ({
  toggleWorkspaceKillSwitch: (...args: any[]) => toggleKillSwitch(...args),
}));

const telegramMock = vi.fn(async () => undefined);
vi.mock("../_core/telegram", () => ({
  notifyTelegram: (...args: any[]) => telegramMock(...args),
}));

// ─── SUT ─────────────────────────────────────────────────────────

import { rcaMonitor } from "./index";

beforeEach(() => {
  vi.clearAllMocks();
  // Reset every channel's counter so tests don't bleed state.
  (["ai-live", "ai-paper", "my-live", "my-paper", "testing-live", "testing-sandbox"] as const).forEach(
    (c) => rcaMonitor.clearDesyncCounter(c),
  );
  settingsMock.desyncKillSwitchEnabled = true;
  settingsMock.desyncKillSwitchThreshold = 3;
  settingsMock.desyncKillSwitchWindowSeconds = 600;
});

describe("rcaMonitor desync kill switch", () => {
  it("increments per-channel counter on each notify", async () => {
    await rcaMonitor.notifyDesync("ai-paper", "T1", "exch-down");
    await rcaMonitor.notifyDesync("ai-paper", "T2", "exch-down");
    expect(rcaMonitor.getDesyncCount("ai-paper")).toBe(2);
    expect(toggleKillSwitch).not.toHaveBeenCalled();
  });

  it("trips kill switch + fires telegram on threshold breach", async () => {
    await rcaMonitor.notifyDesync("ai-live", "T1", "boom");
    await rcaMonitor.notifyDesync("ai-live", "T2", "boom");
    await rcaMonitor.notifyDesync("ai-live", "T3", "boom");
    expect(toggleKillSwitch).toHaveBeenCalledTimes(1);
    expect(toggleKillSwitch).toHaveBeenCalledWith("ai", "ACTIVATE");
    expect(telegramMock).toHaveBeenCalledTimes(1);
    expect(telegramMock.mock.calls[0][0]).toContain("BROKER_DESYNC");
  });

  it("isolates counters per channel — ai-live trip does not touch my-live", async () => {
    await rcaMonitor.notifyDesync("ai-live", "T1", "x");
    await rcaMonitor.notifyDesync("my-live", "T2", "y");
    await rcaMonitor.notifyDesync("ai-live", "T3", "x");
    expect(rcaMonitor.getDesyncCount("ai-live")).toBe(2);
    expect(rcaMonitor.getDesyncCount("my-live")).toBe(1);
    expect(toggleKillSwitch).not.toHaveBeenCalled();
  });

  it("evicts timestamps outside the window", async () => {
    settingsMock.desyncKillSwitchWindowSeconds = 1; // 1 second window
    await rcaMonitor.notifyDesync("ai-paper", "T1", "old");
    await rcaMonitor.notifyDesync("ai-paper", "T2", "old");
    expect(rcaMonitor.getDesyncCount("ai-paper")).toBe(2);
    // Wait past the window.
    await new Promise((r) => setTimeout(r, 1100));
    await rcaMonitor.notifyDesync("ai-paper", "T3", "fresh");
    // The two old timestamps should have been evicted.
    expect(rcaMonitor.getDesyncCount("ai-paper")).toBe(1);
  });

  it("suppresses duplicate trips until clearDesyncCounter", async () => {
    await rcaMonitor.notifyDesync("ai-live", "T1", "x");
    await rcaMonitor.notifyDesync("ai-live", "T2", "x");
    await rcaMonitor.notifyDesync("ai-live", "T3", "x");
    expect(toggleKillSwitch).toHaveBeenCalledTimes(1);
    // 4th + 5th desync — already tripped, must not re-fire.
    await rcaMonitor.notifyDesync("ai-live", "T4", "x");
    await rcaMonitor.notifyDesync("ai-live", "T5", "x");
    expect(toggleKillSwitch).toHaveBeenCalledTimes(1);
    expect(telegramMock).toHaveBeenCalledTimes(1);

    // Operator clears the trip after reconcile — next breach re-fires.
    rcaMonitor.clearDesyncCounter("ai-live");
    await rcaMonitor.notifyDesync("ai-live", "T6", "x");
    await rcaMonitor.notifyDesync("ai-live", "T7", "x");
    await rcaMonitor.notifyDesync("ai-live", "T8", "x");
    expect(toggleKillSwitch).toHaveBeenCalledTimes(2);
    expect(telegramMock).toHaveBeenCalledTimes(2);
  });

  it("no-op when disabled in settings", async () => {
    settingsMock.desyncKillSwitchEnabled = false;
    await rcaMonitor.notifyDesync("ai-live", "T1", "x");
    await rcaMonitor.notifyDesync("ai-live", "T2", "x");
    await rcaMonitor.notifyDesync("ai-live", "T3", "x");
    expect(rcaMonitor.getDesyncCount("ai-live")).toBe(0);
    expect(toggleKillSwitch).not.toHaveBeenCalled();
    expect(telegramMock).not.toHaveBeenCalled();
  });

  it("maps channel → workspace correctly", async () => {
    await rcaMonitor.notifyDesync("my-paper", "T1", "x");
    await rcaMonitor.notifyDesync("my-paper", "T2", "x");
    await rcaMonitor.notifyDesync("my-paper", "T3", "x");
    expect(toggleKillSwitch).toHaveBeenCalledWith("my", "ACTIVATE");

    rcaMonitor.clearDesyncCounter("my-paper");
    toggleKillSwitch.mockClear();

    await rcaMonitor.notifyDesync("testing-live", "T1", "x");
    await rcaMonitor.notifyDesync("testing-live", "T2", "x");
    await rcaMonitor.notifyDesync("testing-live", "T3", "x");
    expect(toggleKillSwitch).toHaveBeenCalledWith("testing", "ACTIVATE");
  });
});
