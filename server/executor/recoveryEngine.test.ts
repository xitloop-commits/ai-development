/**
 * Reconciler (event-driven, no polling).
 *
 * The reconciler is TEA's backstop for "broker filled/rejected the order but
 * the WS event never arrived because we were down/disconnected". It runs once
 * on each order-WS (re)connect — NOT on a timer. Coverage:
 *
 *   1. PENDING + broker says FILLED → emit a synthetic OrderUpdate on tickBus
 *   2. PENDING + broker says REJECTED/CANCELLED/EXPIRED → emit (with reason)
 *   3. PENDING + broker STILL PENDING → no emit (let the WS deliver it)
 *   4. brokerId mismatch → channel skipped entirely
 *   5. same orderId reconciled twice inside the throttle window → polled once
 *   6. no brokerOrderId → skipped
 *   7. broker error → swallowed, no throw
 *   8. start() subscribes to the orderWsConnected event
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ──────────────────────────────────────────────

const getPendingPositionsMock = vi.fn();
const getAdapterMock = vi.fn();
const emitOrderUpdateMock = vi.fn();
const onMock = vi.fn();
const offMock = vi.fn();

vi.mock("../portfolio/storage", () => ({
  getPendingPositions: (...args: any[]) => getPendingPositionsMock(...args),
}));

vi.mock("../broker/brokerService", () => ({
  getAdapter: (...args: any[]) => getAdapterMock(...args),
}));

vi.mock("../broker/tickBus", () => ({
  tickBus: {
    emitOrderUpdate: (...args: any[]) => emitOrderUpdateMock(...args),
    on: (...args: any[]) => onMock(...args),
    off: (...args: any[]) => offMock(...args),
  },
}));

// ─── SUT ─────────────────────────────────────────────────────────

import { recoveryEngine } from "./recoveryEngine";

function makePosition(overrides: any = {}) {
  return {
    tradeId: "T-1",
    brokerOrderId: "ORD-1",
    status: "PENDING",
    ...overrides,
  };
}

function makeAdapter(orderStatus: any, brokerId = "dhan-primary-ac") {
  return {
    brokerId,
    getOrderStatus: vi.fn(async () => orderStatus),
  };
}

/** Return the given positions only for one channel (so a single order isn't
 *  swept once per live channel served by the same broker). */
function pendingFor(channel: string, positions: any[]) {
  getPendingPositionsMock.mockImplementation(async (ch: string) =>
    ch === channel ? positions : [],
  );
}

describe("Reconciler — reconcile-on-WS-connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // start()+stop() resets the throttle map between tests.
    recoveryEngine.start();
    recoveryEngine.stop();
    getPendingPositionsMock.mockResolvedValue([]);
  });

  it("start() subscribes to the orderWsConnected event", () => {
    recoveryEngine.start();
    expect(onMock).toHaveBeenCalledWith("orderWsConnected", expect.any(Function));
    recoveryEngine.stop();
    expect(offMock).toHaveBeenCalledWith("orderWsConnected", expect.any(Function));
  });

  it("emits a synthetic OrderUpdate when the broker reports FILLED", async () => {
    pendingFor("live", [makePosition()]);
    getAdapterMock.mockReturnValue(
      makeAdapter({ status: "FILLED", filledQuantity: 75, averagePrice: 102.5 }),
    );

    await recoveryEngine.reconcileNow("dhan-primary-ac");

    expect(emitOrderUpdateMock).toHaveBeenCalledTimes(1);
    expect(emitOrderUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerId: "dhan-primary-ac",
        orderId: "ORD-1",
        status: "FILLED",
        filledQuantity: 75,
        averagePrice: 102.5,
      }),
    );
  });

  it("emits REJECTED with the broker reason carried through", async () => {
    pendingFor("live", [makePosition({ brokerOrderId: "ORD-REJ" })]);
    getAdapterMock.mockReturnValue(
      makeAdapter({ status: "REJECTED", filledQuantity: 0, averagePrice: 0, reason: "Insufficient funds" }),
    );

    await recoveryEngine.reconcileNow("dhan-primary-ac");

    expect(emitOrderUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "REJECTED", reason: "Insufficient funds" }),
    );
  });

  it("emits for CANCELLED / EXPIRED too", async () => {
    for (const status of ["CANCELLED", "EXPIRED"] as const) {
      vi.clearAllMocks();
      recoveryEngine.stop();
      pendingFor("live", [makePosition({ brokerOrderId: `ORD-${status}` })]);
      getAdapterMock.mockReturnValue(makeAdapter({ status, filledQuantity: 0, averagePrice: 0 }));

      await recoveryEngine.reconcileNow("dhan-primary-ac");

      expect(emitOrderUpdateMock).toHaveBeenCalledWith(expect.objectContaining({ status }));
    }
  });

  it("does NOT emit when broker still reports PENDING (let WS deliver the fill)", async () => {
    pendingFor("live", [makePosition()]);
    getAdapterMock.mockReturnValue(
      makeAdapter({ status: "PENDING", filledQuantity: 0, averagePrice: 0 }),
    );

    await recoveryEngine.reconcileNow("dhan-primary-ac");

    expect(emitOrderUpdateMock).not.toHaveBeenCalled();
  });

  it("skips channels served by a different broker", async () => {
    pendingFor("live", [makePosition()]);
    getAdapterMock.mockReturnValue(makeAdapter({ status: "FILLED" }, "dhan-primary-ac"));

    // Reconcile for the secondary broker — primary's channels must be skipped.
    await recoveryEngine.reconcileNow("dhan-secondary-ac");

    expect(getPendingPositionsMock).not.toHaveBeenCalled();
    expect(emitOrderUpdateMock).not.toHaveBeenCalled();
  });

  it("skips positions without a brokerOrderId", async () => {
    pendingFor("live", [makePosition({ brokerOrderId: undefined })]);
    getAdapterMock.mockReturnValue(makeAdapter({ status: "FILLED" }));

    await recoveryEngine.reconcileNow("dhan-primary-ac");

    expect(emitOrderUpdateMock).not.toHaveBeenCalled();
  });

  it("does not re-poll the same orderId inside the throttle window", async () => {
    pendingFor("live", [makePosition()]);
    const adapter = makeAdapter({ status: "PENDING", filledQuantity: 0, averagePrice: 0 });
    getAdapterMock.mockReturnValue(adapter);

    await recoveryEngine.reconcileNow("dhan-primary-ac");
    await recoveryEngine.reconcileNow("dhan-primary-ac");

    expect(adapter.getOrderStatus).toHaveBeenCalledTimes(1);
  });

  it("survives broker errors without throwing (best-effort backstop)", async () => {
    pendingFor("live", [makePosition()]);
    getAdapterMock.mockReturnValue({
      brokerId: "dhan-primary-ac",
      getOrderStatus: vi.fn(async () => {
        throw new Error("broker 503");
      }),
    });

    await expect(recoveryEngine.reconcileNow("dhan-primary-ac")).resolves.toBeUndefined();
    expect(emitOrderUpdateMock).not.toHaveBeenCalled();
  });
});
