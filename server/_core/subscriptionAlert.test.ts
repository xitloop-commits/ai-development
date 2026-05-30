import { describe, it, expect } from "vitest";
import { getDueAlerts, type SubscriptionConfig } from "./subscriptionAlert";

const CONFIG: SubscriptionConfig = {
  leadDays: 5,
  accounts: [
    { brokerId: "dhan-primary-ac", label: "primary", renewalDayOfMonth: 30, autopayBank: "ICICI" },
    { brokerId: "dhan-secondary-ac", label: "secondary", renewalDayOfMonth: 24, autopayBank: "ICICI" },
  ],
};

// Month index: 4 = May (31 days), 1 = Feb (2026 = 28 days, non-leap).
const may = (d: number) => new Date(2026, 4, d, 9, 0, 0);
const feb = (d: number) => new Date(2026, 1, d, 9, 0, 0);

function due(now: Date) {
  return getDueAlerts(now, CONFIG).map((a) => ({ id: a.account.brokerId, daysUntil: a.daysUntil }));
}

describe("getDueAlerts", () => {
  it("returns nothing with a null config", () => {
    expect(getDueAlerts(may(30), null)).toEqual([]);
  });

  it("primary (30th) fires across its 5-day window only", () => {
    expect(due(may(24))).toEqual([{ id: "dhan-secondary-ac", daysUntil: 0 }]); // 24 is secondary's day
    expect(due(may(25))).toEqual([{ id: "dhan-primary-ac", daysUntil: 5 }]);
    expect(due(may(30))).toEqual([{ id: "dhan-primary-ac", daysUntil: 0 }]);
  });

  it("secondary (24th) fires across its own 5-day window", () => {
    expect(due(may(19))).toEqual([{ id: "dhan-secondary-ac", daysUntil: 5 }]);
    expect(due(may(23))).toEqual([{ id: "dhan-secondary-ac", daysUntil: 1 }]);
  });

  it("is silent outside both windows", () => {
    expect(due(may(18))).toEqual([]);
    expect(due(may(31))).toEqual([]); // past primary's 30th, before next month
  });

  it("clamps a renewal day past the month's end (Feb 28 for a 30th renewal)", () => {
    expect(due(feb(28))).toEqual([{ id: "dhan-primary-ac", daysUntil: 0 }]); // 30 clamped to 28
    // Both due on Feb 23; accounts iterate primary-first.
    expect(due(feb(23))).toEqual([
      { id: "dhan-primary-ac", daysUntil: 5 }, // primary clamped 28, window 23-28: 28-23=5
      { id: "dhan-secondary-ac", daysUntil: 1 }, // secondary 24th: 24-23=1
    ]);
    // Feb 22 is still inside secondary's 19-24 window, but before primary's (clamped) 23-28.
    expect(due(feb(22))).toEqual([{ id: "dhan-secondary-ac", daysUntil: 2 }]);
  });
});
