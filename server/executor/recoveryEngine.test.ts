/**
 * G6 — recoveryEngine.
 *
 * The engine is TEA's backstop for "broker filled the order but the
 * WebSocket event never arrived" scenarios — without it, a trade can
 * sit in PENDING forever while a real position is open at the broker.
 * Coverage targets the 4 behavioural contracts:
 *
 *   1. PENDING + age < threshold → no broker poll (don't hammer the
 *      broker on every freshly-placed order)
 *   2. PENDING + age >= threshold + broker says FILLED → emit a
 *      synthetic OrderUpdate on tickBus (orderSync's existing handler
 *      will reconcile)
 *   3. PENDING + broker says STILL PENDING → no emit (let WS deliver
 *      the eventual fill)
 *   4. Same orderId polled twice within TICK_INTERVAL → second poll
 *      short-circuits (lastPollAt cache)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ──────────────────────────────────────────────

const getOpenPositionsMock = vi.fn();
const getAdapterMock = vi.fn();
const emitOrderUpdateMock = vi.fn();
const getExecutorSettingsMock = vi.fn(async () => ({
  rcaMaxAgeMs: 30 * 60_000,
  rcaStaleTickMs: 5 * 60_000,
  rcaVolThreshold: 0.7,
  rcaChannels: [],
  recoveryStuckMs: 60_000,
  recoveryChannels: [],
  aiLiveLotCap: 1,
}));

vi.mock("../portfolio/storage", () => ({
  getOpenPositions: (...args: any[]) => getOpenPositionsMock(...args),
}));

vi.mock("../broker/brokerService", () => ({
  getAdapter: (...args: any[]) => getAdapterMock(...args),
}));

vi.mock("../broker/tickBus", () => ({
  tickBus: {
    emitOrderUpdate: (...args: any[]) => emitOrderUpdateMock(...args),
  },
}));

vi.mock("./settings", () => ({
  getExecutorSettings: (...args: any[]) => getExecutorSettingsMock(...args),
}));

// ─── SUT ─────────────────────────────────────────────────────────

import { recoveryEngine } from "./recoveryEngine";

function makePosition(overrides: any = {}) {
  return {
    tradeId: "T-1",
    brokerOrderId: "ORD-1",
    status: "PENDING",
    openedAt: Date.now() - 120_000, // 2 min ago by default → past threshold
    ...overrides,
  };
}

function makeAdapter(orderStatus: any) {
  return {
    brokerId: "dhan",
    getOrderStatus: vi.fn(async () => orderStatus),
  };
}

describe("recoveryEngine — stuck PENDING reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restart the singleton between tests so lastPollAt cache is fresh.
    recoveryEngine.stop();
    recoveryEngine.start({ stuckThresholdMs: 60_000, channels: ["my-live"] });
  });

  it("ignores PENDING positions younger than the stuck threshold", async () => {
    const fresh = makePosition({ openedAt: Date.now() - 10_000 }); // 10s old
    getOpenPositionsMock.mockResolvedValue([fresh]);

    await (recoveryEngine as any).tick();

    expect(getAdapterMock).not.toHaveBeenCalled();
    expect(emitOrderUpdateMock).not.toHaveBeenCalled();
  });

  it("emits a synthetic OrderUpdate when the broker reports FILLED", async () => {
    getOpenPositionsMock.mockResolvedValue([makePosition()]);
    getAdapterMock.mockReturnValue(
      makeAdapter({ status: "FILLED", filledQuantity: 75, averagePrice: 102.5 }),
    );

    await (recoveryEngine as any).tick();

    expect(emitOrderUpdateMock).toHaveBeenCalledTimes(1);
    expect(emitOrderUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerId: "dhan",
        orderId: "ORD-1",
        status: "FILLED",
        filledQuantity: 75,
        averagePrice: 102.5,
      }),
    );
  });

  it("emits when broker reports CANCELLED / REJECTED / EXPIRED too", async () => {
    for (const status of ["CANCELLED", "REJECTED", "EXPIRED"] as const) {
      vi.clearAllMocks();
      recoveryEngine.stop();
      recoveryEngine.start({ stuckThresholdMs: 60_000, channels: ["my-live"] });

      getOpenPositionsMock.mockResolvedValue([
        makePosition({ brokerOrderId: `ORD-${status}` }),
      ]);
      getAdapterMock.mockReturnValue(
        makeAdapter({ status, filledQuantity: 0, averagePrice: 0 }),
      );

      await (recoveryEngine as any).tick();

      expect(emitOrderUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({ status }),
      );
    }
  });

  it("does NOT emit when broker still reports PENDING (let WS deliver the fill)", async () => {
    getOpenPositionsMock.mockResolvedValue([makePosition()]);
    getAdapterMock.mockReturnValue(
      makeAdapter({ status: "PENDING", filledQuantity: 0, averagePrice: 0 }),
    );

    await (recoveryEngine as any).tick();

    expect(emitOrderUpdateMock).not.toHaveBeenCalled();
  });

  it("skips positions without a brokerOrderId (paper-only / not yet routed)", async () => {
    const noBrokerId = makePosition({ brokerOrderId: undefined });
    getOpenPositionsMock.mockResolvedValue([noBrokerId]);

    await (recoveryEngine as any).tick();

    expect(getAdapterMock).not.toHaveBeenCalled();
    expect(emitOrderUpdateMock).not.toHaveBeenCalled();
  });

  it("skips non-PENDING positions (already reconciled)", async () => {
    const open = makePosition({ status: "OPEN" });
    getOpenPositionsMock.mockResolvedValue([open]);

    await (recoveryEngine as any).tick();

    expect(getAdapterMock).not.toHaveBeenCalled();
  });

  it("does not poll the same orderId twice inside one TICK_INTERVAL window", async () => {
    const stuck = makePosition();
    getOpenPositionsMock.mockResolvedValue([stuck]);
    const adapter = makeAdapter({
      status: "PENDING",
      filledQuantity: 0,
      averagePrice: 0,
    });
    getAdapterMock.mockReturnValue(adapter);

    await (recoveryEngine as any).tick();
    await (recoveryEngine as any).tick();

    // Adapter polled once across two ticks because lastPollAt deduped.
    expect(adapter.getOrderStatus).toHaveBeenCalledTimes(1);
  });

  it("survives broker errors without throwing (best-effort backstop)", async () => {
    getOpenPositionsMock.mockResolvedValue([makePosition()]);
    const adapter = {
      brokerId: "dhan",
      getOrderStatus: vi.fn(async () => {
        throw new Error("broker 503");
      }),
    };
    getAdapterMock.mockReturnValue(adapter);

    // Throwing here would crash the polling timer; the engine must
    // swallow per-position failures.
    await expect((recoveryEngine as any).tick()).resolves.toBeUndefined();
    expect(emitOrderUpdateMock).not.toHaveBeenCalled();
  });
});
