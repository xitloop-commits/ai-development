/**
 * G6 — disciplineRouter zod schema validation.
 *
 * The full tRPC procedure surface is already exercised end-to-end by
 * `discipline/routes.test.ts` (REST adapters) + `discipline.test.ts`
 * (rule pipeline). This file fills the remaining gap: the
 * `disciplineSettingsUpdateSchema` zod boundaries — the bounds in the
 * spec (DisciplineAgent_Spec_v1.4) need to be enforced at the API
 * boundary so a bad PATCH can't quietly disable a safety rule.
 */
import { describe, it, expect } from "vitest";
import { disciplineSettingsUpdateSchema } from "./disciplineRouter";

describe("disciplineSettingsUpdateSchema — bounds enforcement", () => {
  it("accepts a partial update (single module)", () => {
    const r = disciplineSettingsUpdateSchema.safeParse({
      dailyLossLimit: { enabled: true, thresholdPercent: 2.5 },
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown top-level keys — outer schema is strict (typo-guard)", () => {
    // Catches typos like `dailyLOSSlimit` instead of `dailyLossLimit`,
    // which would otherwise silently no-op a safety rule.
    const r = disciplineSettingsUpdateSchema.safeParse({
      dailyLossLimit: { enabled: true, thresholdPercent: 2.5 },
      newTopLevelField: 123,
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown sub-keys inside a strict module (footgun guard)", () => {
    const r = disciplineSettingsUpdateSchema.safeParse({
      dailyLossLimit: {
        enabled: true,
        thresholdPercent: 2.5,
        sneakyDisable: true, // not in the spec
      },
    });
    expect(r.success).toBe(false);
  });

  it("rejects thresholdPercent above 100 (spec bound)", () => {
    const r = disciplineSettingsUpdateSchema.safeParse({
      dailyLossLimit: { enabled: true, thresholdPercent: 150 },
    });
    expect(r.success).toBe(false);
  });

  it("rejects negative thresholdPercent", () => {
    const r = disciplineSettingsUpdateSchema.safeParse({
      dailyLossLimit: { enabled: true, thresholdPercent: -1 },
    });
    expect(r.success).toBe(false);
  });

  it("accepts maxConsecutiveLosses at the maxLosses 1..20 boundaries", () => {
    expect(
      disciplineSettingsUpdateSchema.safeParse({
        maxConsecutiveLosses: { enabled: true, maxLosses: 1, cooldownMinutes: 0 },
      }).success,
    ).toBe(true);
    expect(
      disciplineSettingsUpdateSchema.safeParse({
        maxConsecutiveLosses: { enabled: true, maxLosses: 20, cooldownMinutes: 720 },
      }).success,
    ).toBe(true);
  });

  it("rejects maxLosses = 0 (no zero-tolerance circuit)", () => {
    const r = disciplineSettingsUpdateSchema.safeParse({
      maxConsecutiveLosses: { enabled: true, maxLosses: 0, cooldownMinutes: 30 },
    });
    expect(r.success).toBe(false);
  });

  it("rejects cooldownMinutes > 720 (12 hours — covers any single trading session)", () => {
    const r = disciplineSettingsUpdateSchema.safeParse({
      maxConsecutiveLosses: { enabled: true, maxLosses: 3, cooldownMinutes: 1000 },
    });
    expect(r.success).toBe(false);
  });

  it("rejects maxTradesPerDay above 100 (spec ceiling)", () => {
    const r = disciplineSettingsUpdateSchema.safeParse({
      maxTradesPerDay: { enabled: true, limit: 250 },
    });
    expect(r.success).toBe(false);
  });

  it("accepts noTradingAfterOpen with both NSE + MCX windows set", () => {
    const r = disciplineSettingsUpdateSchema.safeParse({
      noTradingAfterOpen: { enabled: true, nseMinutes: 15, mcxMinutes: 5 },
    });
    expect(r.success).toBe(true);
  });

  it("rejects nseMinutes > 60 (one-hour cap)", () => {
    const r = disciplineSettingsUpdateSchema.safeParse({
      noTradingAfterOpen: { enabled: true, nseMinutes: 120, mcxMinutes: 5 },
    });
    expect(r.success).toBe(false);
  });

  it("accepts an empty patch (no-op update)", () => {
    const r = disciplineSettingsUpdateSchema.safeParse({});
    expect(r.success).toBe(true);
  });
});
