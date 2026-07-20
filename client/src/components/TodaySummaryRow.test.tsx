/**
 * The day summary is STICKY to the bottom of the desk's scroll container, so on
 * a heavy day it stays visible instead of sitting below 100+ trade rows.
 *
 * jsdom does no layout, so stickiness itself can't be asserted — but the two
 * things that silently break it can be:
 *   1. the sticky classes being dropped, and
 *   2. the background going translucent again, which lets trade rows scroll
 *      visibly THROUGH the pinned row.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { TodaySummaryRow } from "./TodaySummaryRow";
import type { DayRecord, TradeRecord } from "@/lib/tradeTypes";

function day(overrides: Partial<DayRecord> = {}): DayRecord {
  return {
    dayIndex: 1, date: "2026-07-20", tradeCapital: 200_000, targetPercent: 5,
    targetAmount: 10_000, projCapital: 210_000, originalProjCapital: 210_000,
    actualCapital: 200_000, deviation: 0, totalPnl: 0, totalCharges: 0,
    totalQty: 0, instruments: [], trades: [], status: "ACTIVE", rating: "future",
    ...overrides,
  } as DayRecord;
}

function renderRow(d: DayRecord, totalPnl = 0) {
  const { container } = render(
    <table><tbody>
      <TodaySummaryRow
        day={d} trades={[] as TradeRecord[]} totalPnl={totalPnl} totalCharges={0}
        showNet canManageTrades={false} openTradeCount={0} cycleDateLabel="Today"
        summaryBorder="border-border" lastClosedTrade={null}
        onExitAll={vi.fn()} onRepeatLastOrder={vi.fn()}
      />
    </tbody></table>,
  );
  return container.querySelector("tr")!;
}

describe("TodaySummaryRow — pinned to the bottom", () => {
  it("is sticky to the bottom and above the trade rows", () => {
    const cls = renderRow(day()).className;
    expect(cls).toContain("sticky");
    expect(cls).toContain("bottom-0");
    expect(cls).toMatch(/\bz-\d+/); // must out-stack the rows scrolling under it
  });

  it("uses an OPAQUE background so trades can't show through", () => {
    // A translucent tint (bg-*/15) would let rows scroll visibly through the
    // pinned summary. Each state composites its tint against the card instead.
    for (const d of [
      day(),                                  // neutral
      day({ targetAmount: 10_000 }),          // target hit  (totalPnl below)
      day({ targetAmount: 10_000 }),          // heavy loss  (totalPnl below)
    ]) {
      for (const pnl of [0, 12_000, -12_000]) {
        const cls = renderRow(d, pnl).className;
        expect(cls).not.toMatch(/bg-\w+\/\d+/);
      }
    }
  });

  it("still tints green on a target hit and red on a heavy loss", () => {
    expect(renderRow(day({ targetAmount: 10_000 }), 12_000).className).toContain("bullish");
    expect(renderRow(day({ targetAmount: 10_000 }), -12_000).className).toContain("destructive");
  });
});
