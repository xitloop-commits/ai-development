/**
 * The expanded past-day trade row must line up with the desk's SIXTEEN-column
 * grid, in the same order today's rows use.
 *
 * It didn't: the row emitted seventeen cells with Charges and Points
 * transposed, so in every expanded past day the points sat under "Charges", the
 * charges under "Points", and the rating badge fell past the last column. jsdom
 * does no layout, so nothing about the misalignment was visible to a test that
 * only asserted content — the column ARITHMETIC is what has to be asserted.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { PastTradeRow } from "./PastTradeRow";
import type { TradeRecord } from "@/lib/tradeTypes";

// Real colour resolution goes through tRPC; stub it with the real style builder
// so InstrumentTag (which needs styleOf) renders exactly as it does in the app.
vi.mock("@/lib/useInstrumentColors", async () => {
  const { instrumentStyleFromHex } = await vi.importActual<typeof import("@/lib/tradeThemes")>(
    "@/lib/tradeThemes",
  );
  return {
    useInstrumentColors: () => ({
      hexOf: () => "#3b82f6",
      styleOf: () => instrumentStyleFromHex("#3b82f6"),
    }),
  };
});

/** The desk's colgroup — see TradingDesk's <col> list. */
const DESK_COLUMNS = 16;

function trade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: "T1", instrument: "NIFTY50", type: "CALL_BUY", strike: 23850, expiry: null,
    entryPrice: 100, exitPrice: 120, ltp: 120, qty: 650, lotSize: 65,
    pnl: 12_000, charges: 260, chargesBreakdown: [], status: "CLOSED",
    exitReason: "AI_EXIT", openedAt: 1_784_799_245_682, closedAt: 1_784_800_542_673,
    stopLossPrice: null, targetPrice: null, cohort: "ma_signal", exitStrategy: "glide",
    signalSeq: 7, contractSecurityId: "63933",
    ...overrides,
  } as unknown as TradeRecord;
}

function renderRow(t: TradeRecord = trade()) {
  const { container } = render(
    <table><tbody><PastTradeRow trade={t} showNet channel="paper" tradeNo={1} /></tbody></table>,
  );
  return container.querySelector("tr")!;
}

/** Cells a row occupies, counting colSpan — what actually decides alignment. */
function spannedColumns(row: HTMLTableRowElement): number {
  return Array.from(row.querySelectorAll("td"))
    .reduce((n, td) => n + (Number(td.getAttribute("colSpan") ?? td.getAttribute("colspan")) || 1), 0);
}

describe("PastTradeRow column alignment", () => {
  it("occupies exactly the desk's 16 columns", () => {
    expect(spannedColumns(renderRow())).toBe(DESK_COLUMNS);
  });

  it("puts Charges BEFORE Points, matching the header order", () => {
    // Header order is …Invested | Charges | Points | P&L… — the two were swapped,
    // which reads as a plausible row until you notice a ₹260 'points' move.
    const cells = Array.from(renderRow().querySelectorAll("td"));
    // colSpan-5 identity, Instrument, Entry, LTP, Lot, Invested → charges is #6.
    const charges = cells[6]!.textContent ?? "";
    const points = cells[7]!.textContent ?? "";
    expect(charges).toContain("260");
    expect(points).toContain("20.00"); // (120 − 100) points, not the charge
  });

  it("keeps the rating badge inside the last column", () => {
    const cells = Array.from(renderRow().querySelectorAll("td"));
    expect(cells[cells.length - 1]!.textContent).toBeTruthy();
  });
});

describe("PastTradeRow look and feel", () => {
  it("shows the same identity as today's row — number, time, contract, cohort, strategy", () => {
    const row = renderRow();
    const identity = row.querySelector("td")!.textContent ?? "";
    expect(identity).toContain("#7");        // signal number
    expect(identity).toContain("23850");     // strike
    expect(identity).toContain("Long(CE)");  // direction + contract, one pill
    expect(identity.toLowerCase()).toContain("ma");     // cohort pill
    expect(identity.toLowerCase()).toContain("glide");  // strategy pill
  });

  it("leads with the number, not the timestamp", () => {
    // Partha, 2026-07-23: "trade no should come first everywhere" — it is how a
    // trade is referred to out loud. Pinned because it reads as a cosmetic
    // ordering detail that a later edit could reshuffle without noticing.
    const identity = renderRow().querySelector("td")!.textContent ?? "";
    expect(identity.indexOf("#7")).toBeLessThan(identity.indexOf("pm"));
  });

  it("falls back to the trade number when there is no signal (manual trades)", () => {
    const row = renderRow(trade({ signalSeq: null } as Partial<TradeRecord>));
    expect(row.querySelector("td")!.textContent).toContain("#1");
  });

  it("carries the instrument tint and the closed-trade dimming, not a flat grey", () => {
    const row = renderRow();
    // The old row used text-muted-foreground for EVERYTHING, which flattened the
    // P&L colours — the one thing you scan a past day for.
    expect(row.className).not.toContain("text-muted-foreground");
    expect(row.className).toContain("opacity-60"); // how today renders a closed trade
    expect(row.getAttribute("style")).toContain("background-color");
  });

  it("colours P&L by direction rather than greying it", () => {
    const win = renderRow();
    const loss = renderRow(trade({ pnl: -5_000, exitPrice: 80 } as Partial<TradeRecord>));
    expect(win.innerHTML).toContain("text-bullish");
    expect(loss.innerHTML).toContain("text-destructive");
  });

  it("offers exactly ONE action — the contract pill, which opens the chart", () => {
    // A settled trade cannot be exited or re-strategised, so those controls stay
    // absent; looking at what happened is the one thing still worth doing.
    // Fixture has no expiry, so the instrument is not a copy button here — the
    // chart pill is the only control.
    const buttons = Array.from(renderRow().querySelectorAll("button"));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe("Long(CE)");
    expect(buttons[0]!.getAttribute("title")).toContain("chart");
    // Reported: "cursor pointer is not up over the pill." Global CSS already
    // gives every enabled button a pointer, but the class is asserted here so a
    // refactor back to a <span> is caught rather than silently losing the hint.
    expect(buttons[0]!.className).toContain("cursor-pointer");
    expect(buttons[0]!.tagName).toBe("BUTTON");
  });

  it("makes the instrument itself the COPY button when the contract is nameable", () => {
    // This row shipped with the copy TOOLTIP but no handler — it advertised a
    // copy that never happened, and the cursor stayed an I-beam.
    const row = renderRow(trade({ expiry: "2026-07-24" } as Partial<TradeRecord>));
    const copyBtn = Array.from(row.querySelectorAll("button"))
      .find((b) => (b.getAttribute("title") ?? "").startsWith("Click to copy"));
    expect(copyBtn).toBeTruthy();
    expect(copyBtn!.getAttribute("title")).toContain("NIFTY 24 JUL 23850 CALL");
    expect(copyBtn!.className).toContain("cursor-pointer");
  });

  it("leaves the instrument un-clickable when there is nothing to copy", () => {
    // No expiry → contractCopyText returns null → no Dhan-search string exists.
    const row = renderRow(trade({ expiry: null } as Partial<TradeRecord>));
    const copyBtn = Array.from(row.querySelectorAll("button"))
      .find((b) => (b.getAttribute("title") ?? "").startsWith("Click to copy"));
    expect(copyBtn).toBeUndefined();
  });

  it("leaves the pill inert when the contract cannot be charted", () => {
    // No securityId → nothing to load. A button that opens nothing is worse
    // than no button, so it must fall back to a plain label.
    const row = renderRow(trade({ contractSecurityId: null } as Partial<TradeRecord>));
    expect(row.querySelectorAll("button")).toHaveLength(0);
    expect(row.querySelector("td")!.textContent).toContain("Long(CE)");
  });
});
