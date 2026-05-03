/**
 * F3 — PastRow / FutureRow memo equality.
 *
 * The plan calls for a 250-row render-counting test, which needs jsdom +
 * @testing-library/react (not currently installed). As a focused stand-in,
 * this exercises the equality predicates directly: a "capital tick" only
 * mutates today's row's day record, so equality should return TRUE for
 * every other row (memo skips re-render) and FALSE for today's row
 * (memo re-renders).
 */
import { describe, it, expect } from "vitest";
import { pastRowPropsEqual } from "./PastRow";
import { futureRowPropsEqual } from "./FutureRow";
import type { Channel, DayRecord } from "@/lib/tradeTypes";

function makeDay(overrides: Partial<DayRecord> = {}): DayRecord {
  return {
    dayIndex: 1,
    date: "2024-11-14",
    tradeCapital: 100_000,
    targetPercent: 1,
    targetAmount: 1_000,
    projCapital: 101_000,
    originalProjCapital: 101_000,
    actualCapital: 100_500,
    deviation: 500,
    trades: [],
    totalPnl: 0,
    totalCharges: 0,
    totalQty: 0,
    instruments: [],
    status: "OPEN",
    rating: "neutral",
    ...overrides,
  } as DayRecord;
}

describe("PastRow memo equality", () => {
  const channel: Channel = "ai-paper";

  it("returns true when the row is identical (skip re-render)", () => {
    const day = makeDay({ dayIndex: 5, totalPnl: 100 });
    expect(
      pastRowPropsEqual(
        { day, showNet: true, channel },
        { day, showNet: true, channel },
      ),
    ).toBe(true);
  });

  it("returns false when totalPnl changes (today's row on capital tick)", () => {
    const d1 = makeDay({ dayIndex: 5, totalPnl: 100 });
    const d2 = makeDay({ dayIndex: 5, totalPnl: 250 });
    expect(
      pastRowPropsEqual(
        { day: d1, showNet: true, channel },
        { day: d2, showNet: true, channel },
      ),
    ).toBe(false);
  });

  it("returns true for past days when only today's day mutates (250-row sim)", () => {
    // Simulate: capital tick changes today's row only. For past rows, both
    // prev.day and next.day are unchanged references, so memo returns true.
    const pastDays = Array.from({ length: 250 }, (_, i) => makeDay({ dayIndex: i + 1, totalPnl: i }));
    let skipped = 0;
    for (const day of pastDays) {
      // No mutation between prev/next — memo should skip.
      const eq = pastRowPropsEqual(
        { day, showNet: true, channel },
        { day, showNet: true, channel },
      );
      if (eq) skipped++;
    }
    expect(skipped).toBe(250);
  });

  it("returns false when showNet flips", () => {
    const day = makeDay({ dayIndex: 5 });
    expect(
      pastRowPropsEqual(
        { day, showNet: true, channel },
        { day, showNet: false, channel },
      ),
    ).toBe(false);
  });

  it("returns false when highlighted toggles", () => {
    const day = makeDay({ dayIndex: 5 });
    expect(
      pastRowPropsEqual(
        { day, showNet: true, channel, highlighted: false },
        { day, showNet: true, channel, highlighted: true },
      ),
    ).toBe(false);
  });
});

describe("FutureRow memo equality", () => {
  const channel: Channel = "ai-paper";

  it("returns true when day reference is identical", () => {
    const day = makeDay({ dayIndex: 100 });
    expect(
      futureRowPropsEqual(
        { day, isDay250: false, channel },
        { day, isDay250: false, channel },
      ),
    ).toBe(true);
  });

  it("returns false when projCapital changes (re-projection)", () => {
    const d1 = makeDay({ dayIndex: 100, projCapital: 200_000 });
    const d2 = makeDay({ dayIndex: 100, projCapital: 250_000 });
    expect(
      futureRowPropsEqual(
        { day: d1, isDay250: false, channel },
        { day: d2, isDay250: false, channel },
      ),
    ).toBe(false);
  });

  it("returns false when isDay250 toggles", () => {
    const day = makeDay({ dayIndex: 250 });
    expect(
      futureRowPropsEqual(
        { day, isDay250: false, channel },
        { day, isDay250: true, channel },
      ),
    ).toBe(false);
  });
});
