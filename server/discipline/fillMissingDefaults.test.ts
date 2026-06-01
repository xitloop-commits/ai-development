/**
 * Tests for fillMissingDefaults — the read-path backfill that protects
 * legacy discipline_settings records missing newer sub-documents
 * (e.g. Module 8 capitalProtection). See getDisciplineSettings.
 */
import { describe, it, expect } from "vitest";
import { fillMissingDefaults } from "./disciplineModel";
import { DEFAULT_DISCIPLINE_AGENT_SETTINGS } from "./types";

describe("fillMissingDefaults", () => {
  it("backfills capitalProtection when a legacy record lacks it", () => {
    // Simulate an old record saved before Module 8 existed.
    const legacy: any = {
      userId: "1",
      dailyLossLimit: { enabled: true, thresholdPercent: 3 },
      history: [],
    };
    const filled = fillMissingDefaults(legacy, DEFAULT_DISCIPLINE_AGENT_SETTINGS);

    expect(filled.capitalProtection).toBeDefined();
    expect(filled.capitalProtection.profitCap).toEqual(
      DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection.profitCap,
    );
  });

  it("never overwrites values the record already has", () => {
    const legacy: any = {
      userId: "1",
      dailyLossLimit: { enabled: false, thresholdPercent: 99 },
    };
    const filled = fillMissingDefaults(legacy, DEFAULT_DISCIPLINE_AGENT_SETTINGS);

    expect(filled.dailyLossLimit).toEqual({ enabled: false, thresholdPercent: 99 });
  });

  it("fills a missing nested key while keeping the present sibling", () => {
    const legacy: any = {
      capitalProtection: {
        // profitCap present (tweaked), lossCap absent → should be backfilled.
        profitCap: { enabled: false, percent: 12 },
      },
    };
    const filled = fillMissingDefaults(legacy, DEFAULT_DISCIPLINE_AGENT_SETTINGS);

    expect(filled.capitalProtection.profitCap).toEqual({ enabled: false, percent: 12 });
    expect(filled.capitalProtection.lossCap).toEqual(
      DEFAULT_DISCIPLINE_AGENT_SETTINGS.capitalProtection.lossCap,
    );
  });

  it("does not mutate the shared DEFAULT_* object", () => {
    const before = JSON.stringify(DEFAULT_DISCIPLINE_AGENT_SETTINGS);
    fillMissingDefaults({}, DEFAULT_DISCIPLINE_AGENT_SETTINGS);
    expect(JSON.stringify(DEFAULT_DISCIPLINE_AGENT_SETTINGS)).toBe(before);
  });
});