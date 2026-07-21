/**
 * Pool passbooks (T104) — unit tests for the pure book builder.
 *
 * buildPoolBooks turns the single capital-event stream into two account-book
 * views (Trading pool / Reserve pool), each row Dr / Cr / Balance, grouped by
 * IST day. No MongoDB involved — rows are fed in directly.
 */
import { describe, expect, it } from "vitest";
import { buildPoolBooks, istDay, type LedgerRow } from "./capitalLedger";

/** 2026-07-21 10:00 IST. */
const T0 = Date.UTC(2026, 6, 21, 4, 30);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let seq = 0;
function row(over: Partial<LedgerRow>): LedgerRow {
  return {
    eventId: `EVT-${++seq}`,
    timestamp: T0,
    type: "CAPITAL_INJECTED",
    amount: 0,
    tradingPoolAfter: 0,
    reservePoolAfter: 0,
    tradingDelta: null,
    reserveDelta: null,
    note: "",
    detail: {},
    ...over,
  };
}

describe("buildPoolBooks", () => {
  it("routes each movement to the pool it touched, with Dr/Cr split", () => {
    const books = buildPoolBooks([
      row({ type: "CAPITAL_SEEDED", timestamp: T0, tradingPoolAfter: 100000, tradingDelta: 100000, reserveDelta: 0 }),
      row({ type: "CAPITAL_WITHDRAWN", timestamp: T0 + HOUR, tradingPoolAfter: 90000, tradingDelta: -10000, reserveDelta: 0 }),
    ]);

    expect(books.reserve).toHaveLength(0);
    expect(books.trading).toHaveLength(1);
    const rows = books.trading[0].rows;
    expect(rows).toHaveLength(2);
    // Credit row: money in.
    expect(rows[0]).toMatchObject({ cr: 100000, dr: 0, balance: 100000 });
    // Debit row: money out.
    expect(rows[1]).toMatchObject({ cr: 0, dr: 10000, balance: 90000 });
    expect(books.trading[0].closing).toBe(90000);
  });

  it("a transfer lands in BOTH books — Dr one side, Cr the other", () => {
    const books = buildPoolBooks([
      row({ type: "CAPITAL_SEEDED", tradingPoolAfter: 50000, tradingDelta: 50000, reserveDelta: 0 }),
      row({
        type: "CAPITAL_TRANSFERRED", timestamp: T0 + HOUR,
        tradingPoolAfter: 40000, reservePoolAfter: 10000,
        tradingDelta: -10000, reserveDelta: 10000,
      }),
    ]);

    expect(books.trading[0].rows[1]).toMatchObject({ dr: 10000, cr: 0, balance: 40000 });
    expect(books.reserve[0].rows[0]).toMatchObject({ dr: 0, cr: 10000, balance: 10000 });
  });

  it("day close credits both pools per the profit split", () => {
    const books = buildPoolBooks([
      row({ type: "CAPITAL_SEEDED", tradingPoolAfter: 100000, tradingDelta: 100000, reserveDelta: 0 }),
      row({
        type: "DAY_COMPLETED", timestamp: T0 + 6 * HOUR, amount: 5000,
        tradingPoolAfter: 103750, reservePoolAfter: 1250,
        tradingDelta: 3750, reserveDelta: 1250,
      }),
    ]);

    expect(books.trading[0].rows[1]).toMatchObject({ cr: 3750, balance: 103750 });
    expect(books.reserve[0].rows[0]).toMatchObject({ cr: 1250, balance: 1250 });
  });

  it("falls back to balance differencing for pre-T104 rows without deltas", () => {
    const books = buildPoolBooks([
      row({ type: "CAPITAL_SEEDED", tradingPoolAfter: 100000 }),
      row({ type: "CAPITAL_TRANSFERRED", timestamp: T0 + HOUR, tradingPoolAfter: 75000, reservePoolAfter: 25000 }),
    ]);

    expect(books.trading[0].rows[0]).toMatchObject({ cr: 100000, balance: 100000 });
    expect(books.trading[0].rows[1]).toMatchObject({ dr: 25000, balance: 75000 });
    expect(books.reserve[0].rows[0]).toMatchObject({ cr: 25000, balance: 25000 });
  });

  it("groups day-wise with per-day closing balance, newest day first", () => {
    const books = buildPoolBooks([
      row({ type: "CAPITAL_SEEDED", timestamp: T0, tradingPoolAfter: 100000, tradingDelta: 100000, reserveDelta: 0 }),
      row({ type: "CAPITAL_INJECTED", timestamp: T0 + DAY, amount: 20000, tradingPoolAfter: 120000, tradingDelta: 20000, reserveDelta: 0 }),
      row({ type: "CAPITAL_WITHDRAWN", timestamp: T0 + DAY + HOUR, tradingPoolAfter: 115000, tradingDelta: -5000, reserveDelta: 0 }),
    ]);

    expect(books.trading).toHaveLength(2);
    // Newest day first…
    expect(books.trading[0].day).toBe(istDay(T0 + DAY));
    expect(books.trading[0].rows).toHaveLength(2);
    expect(books.trading[0].closing).toBe(115000);
    // …older day after, closing at its own last balance.
    expect(books.trading[1].day).toBe(istDay(T0));
    expect(books.trading[1].closing).toBe(100000);
  });

  it("prefers the stored tradeDay over deriving from the timestamp", () => {
    const books = buildPoolBooks([
      row({
        type: "CAPITAL_SEEDED", tradingPoolAfter: 1000, tradingDelta: 1000, reserveDelta: 0,
        detail: { tradeDay: "2026-07-19" },
      }),
    ]);
    expect(books.trading[0].day).toBe("2026-07-19");
  });

  it("zero-movement rows are skipped — a passbook only shows money moving", () => {
    const books = buildPoolBooks([
      row({ type: "CAPITAL_SEEDED", tradingPoolAfter: 1000, tradingDelta: 1000, reserveDelta: 0 }),
      row({ type: "CAPITAL_ADJUSTED", timestamp: T0 + HOUR, tradingPoolAfter: 1000, tradingDelta: 0, reserveDelta: 0 }),
    ]);
    expect(books.trading[0].rows).toHaveLength(1);
    expect(books.reserve).toHaveLength(0);
  });

  it("clawback shows as a Dr in the trading book only", () => {
    const books = buildPoolBooks([
      row({ type: "CAPITAL_SEEDED", tradingPoolAfter: 81000, reservePoolAfter: 2000, tradingDelta: 81000, reserveDelta: 2000 }),
      row({
        type: "CLAWBACK", timestamp: T0 + HOUR, amount: -5000,
        tradingPoolAfter: 76000, reservePoolAfter: 2000,
        tradingDelta: -5000, reserveDelta: 0,
      }),
    ]);
    expect(books.trading[0].rows[1]).toMatchObject({ dr: 5000, cr: 0, balance: 76000 });
    expect(books.reserve[0].rows).toHaveLength(1); // only the seed row
  });
});
