/**
 * upsertPosition — createdAt-conflict regression.
 *
 * The position mirror-write used to put `createdAt` in BOTH $set and
 * $setOnInsert, which MongoDB rejects ("would create a conflict at
 * 'createdAt'"). Every mirror silently failed, leaving position_state
 * empty. These tests pin the fixed behaviour: upsert succeeds on insert
 * AND on a subsequent update, and createdAt is set once and never
 * overwritten.
 *
 * Uses the per-file in-memory MongoDB from __tests__/setup.mongo.ts.
 */
import { describe, it, expect } from "vitest";
import { upsertPosition, getPosition, type PositionStateDoc } from "./storage";

function makeDoc(overrides: Partial<PositionStateDoc> = {}): PositionStateDoc {
  const now = Date.now();
  return {
    positionId: "POS-REGRESSION-1",
    tradeId: "TREGRESSION-1",
    channel: "my-paper",
    dayIndex: 1,
    instrument: "NATURAL GAS",
    type: "CALL_BUY",
    strike: 315,
    expiry: "2026-06-25",
    contractSecurityId: "568251",
    entryPrice: 17.9,
    exitPrice: null,
    ltp: 17.9,
    qty: 1250,
    lotSize: 1250,
    capitalPercent: 5,
    pnl: 0,
    unrealizedPnl: 0,
    charges: 0,
    chargesBreakdown: [],
    status: "OPEN",
    targetPrice: null,
    stopLossPrice: null,
    brokerOrderId: "MOCK-1",
    brokerId: "mock",
    openedAt: now,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("upsertPosition — createdAt conflict regression", () => {
  it("inserts a new position without throwing", async () => {
    const inserted = await upsertPosition(makeDoc());
    expect(inserted.positionId).toBe("POS-REGRESSION-1");
    expect(inserted.status).toBe("OPEN");
    expect(inserted.ltp).toBe(17.9);
  });

  it("updates the same position without a createdAt conflict, preserving createdAt", async () => {
    const first = await upsertPosition(makeDoc({ ltp: 17.9 }));
    const originalCreatedAt = first.createdAt;

    // Mirror-on-update path: a second upsert with a DIFFERENT createdAt in the
    // doc must NOT throw, must apply the new ltp, and must keep the original
    // createdAt (proves createdAt lives only in $setOnInsert).
    const updated = await upsertPosition(
      makeDoc({ ltp: 19.5, createdAt: originalCreatedAt + 5000 }),
    );
    expect(updated.ltp).toBe(19.5);
    expect(updated.createdAt).toBe(originalCreatedAt);

    const reread = await getPosition("POS-REGRESSION-1");
    expect(reread?.ltp).toBe(19.5);
    expect(reread?.createdAt).toBe(originalCreatedAt);
  });
});
