/**
 * Tests for B4-followup — RCA's per-channel BROKER_DESYNC kill switch.
 *
 * Scenario coverage:
 *   - notifyDesync increments the per-channel sliding-window counter
 *   - timestamps outside `windowSeconds` are evicted
 *   - per-channel isolation: a desync on live doesn't trip live
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
  (["live", "paper"] as const).forEach(
    (c) => rcaMonitor.clearDesyncCounter(c),
  );
  settingsMock.desyncKillSwitchEnabled = true;
  settingsMock.desyncKillSwitchThreshold = 3;
  settingsMock.desyncKillSwitchWindowSeconds = 600;
});

describe("rcaMonitor desync kill switch", () => {
  it("increments per-channel counter on each notify", async () => {
    await rcaMonitor.notifyDesync("paper", "T1", "exch-down");
    await rcaMonitor.notifyDesync("paper", "T2", "exch-down");
    expect(rcaMonitor.getDesyncCount("paper")).toBe(2);
    expect(toggleKillSwitch).not.toHaveBeenCalled();
  });

  it("trips kill switch + fires telegram on threshold breach", async () => {
    await rcaMonitor.notifyDesync("live", "T1", "boom");
    await rcaMonitor.notifyDesync("live", "T2", "boom");
    await rcaMonitor.notifyDesync("live", "T3", "boom");
    // Two calls, one per workspace — T126 halts the whole book (see below).
    expect(toggleKillSwitch).toHaveBeenCalledTimes(2);
    expect(toggleKillSwitch).toHaveBeenCalledWith("ai", "ACTIVATE");
    expect(toggleKillSwitch).toHaveBeenCalledWith("my", "ACTIVATE");
    expect(telegramMock).toHaveBeenCalledTimes(1);
    expect(telegramMock.mock.calls[0][0]).toContain("BROKER_DESYNC");
  });

  it("isolates counters per channel — a live trip does not touch paper", async () => {
    await rcaMonitor.notifyDesync("live", "T1", "x");
    await rcaMonitor.notifyDesync("live", "T2", "y");
    await rcaMonitor.notifyDesync("paper", "T3", "x");
    expect(rcaMonitor.getDesyncCount("live")).toBe(2);
    expect(rcaMonitor.getDesyncCount("paper")).toBe(1);
    expect(toggleKillSwitch).not.toHaveBeenCalled();
  });

  it("evicts timestamps outside the window", async () => {
    settingsMock.desyncKillSwitchWindowSeconds = 1; // 1 second window
    await rcaMonitor.notifyDesync("paper", "T1", "old");
    await rcaMonitor.notifyDesync("paper", "T2", "old");
    expect(rcaMonitor.getDesyncCount("paper")).toBe(2);
    // Wait past the window.
    await new Promise((r) => setTimeout(r, 1100));
    await rcaMonitor.notifyDesync("paper", "T3", "fresh");
    // The two old timestamps should have been evicted.
    expect(rcaMonitor.getDesyncCount("paper")).toBe(1);
  });

  it("suppresses duplicate trips until clearDesyncCounter", async () => {
    await rcaMonitor.notifyDesync("live", "T1", "x");
    await rcaMonitor.notifyDesync("live", "T2", "x");
    await rcaMonitor.notifyDesync("live", "T3", "x");
    expect(toggleKillSwitch).toHaveBeenCalledTimes(2); // one per workspace
    // 4th + 5th desync — already tripped, must not re-fire.
    await rcaMonitor.notifyDesync("live", "T4", "x");
    await rcaMonitor.notifyDesync("live", "T5", "x");
    expect(toggleKillSwitch).toHaveBeenCalledTimes(2); // still just the first trip
    expect(telegramMock).toHaveBeenCalledTimes(1);

    // Operator clears the trip after reconcile — next breach re-fires.
    rcaMonitor.clearDesyncCounter("live");
    await rcaMonitor.notifyDesync("live", "T6", "x");
    await rcaMonitor.notifyDesync("live", "T7", "x");
    await rcaMonitor.notifyDesync("live", "T8", "x");
    expect(toggleKillSwitch).toHaveBeenCalledTimes(4); // second trip, both workspaces
    expect(telegramMock).toHaveBeenCalledTimes(2);
  });

  it("no-op when disabled in settings", async () => {
    settingsMock.desyncKillSwitchEnabled = false;
    await rcaMonitor.notifyDesync("live", "T1", "x");
    await rcaMonitor.notifyDesync("live", "T2", "x");
    await rcaMonitor.notifyDesync("live", "T3", "x");
    expect(rcaMonitor.getDesyncCount("live")).toBe(0);
    expect(toggleKillSwitch).not.toHaveBeenCalled();
    expect(telegramMock).not.toHaveBeenCalled();
  });

  it("halts BOTH streams — a desync is a book-level fault, not an AI or manual one", async () => {
    // T126: one live book, one Dhan account, two streams trading it. If the
    // app's record disagrees with the broker, both streams are unsafe. Tripping
    // only one workspace (which is what the old channel→workspace mapping did)
    // would have left half the book still placing orders into the disagreement.
    await rcaMonitor.notifyDesync("live", "T1", "x");
    await rcaMonitor.notifyDesync("live", "T2", "x");
    await rcaMonitor.notifyDesync("live", "T3", "x");

    expect(toggleKillSwitch).toHaveBeenCalledWith("ai", "ACTIVATE");
    expect(toggleKillSwitch).toHaveBeenCalledWith("my", "ACTIVATE");
  });
});
