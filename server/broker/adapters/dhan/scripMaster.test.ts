/**
 * Vitest tests for Dhan Scrip Master
 *
 * Tests CSV parsing, security ID lookup, expiry list,
 * MCX FUTCOM resolution, and cache management.
 * Uses _loadRecordsForTesting() to inject test data without HTTP.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  lookupSecurityId,
  lookupMultiple,
  getExpiryDates,
  resolveMCXFutcom,
  getScripMasterStatus,
  getRecordsByExchange,
  getRecordsBySymbol,
  needsRefresh,
  _loadRecordsForTesting,
  _resetForTesting,
  type ScripRecord,
} from "./scripMaster";

// ─── Test Data ────────────────────────────────────────────────

function makeRecord(overrides: Partial<ScripRecord>): ScripRecord {
  return {
    exchange: "NSE",
    segment: "D",
    securityId: "10000",
    instrumentName: "OPTIDX",
    expiryCode: "W",
    tradingSymbol: "NIFTY-Apr2026-24500-CE",
    lotSize: 25,
    customSymbol: "NIFTY 26 APR 24500 CALL",
    expiryDate: "2026-04-03 14:30:00",
    strikePrice: 24500,
    optionType: "CE",
    tickSize: 0.05,
    expiryFlag: "W",
    exchInstrType: "OP",
    series: "",
    symbolName: "",
    underlyingSymbol: "NIFTY",
    expiryDateOnly: "2026-04-03",
    ...overrides,
  };
}

const NIFTY_CE_24500_APR03 = makeRecord({
  securityId: "50001",
  tradingSymbol: "NIFTY-Apr2026-24500-CE",
  customSymbol: "NIFTY 26 APR 24500 CALL",
  expiryDate: "2026-04-03 14:30:00",
  expiryDateOnly: "2026-04-03",
  strikePrice: 24500,
  optionType: "CE",
});

const NIFTY_PE_24500_APR03 = makeRecord({
  securityId: "50002",
  tradingSymbol: "NIFTY-Apr2026-24500-PE",
  customSymbol: "NIFTY 26 APR 24500 PUT",
  expiryDate: "2026-04-03 14:30:00",
  expiryDateOnly: "2026-04-03",
  strikePrice: 24500,
  optionType: "PE",
});

const NIFTY_CE_24600_APR03 = makeRecord({
  securityId: "50003",
  tradingSymbol: "NIFTY-Apr2026-24600-CE",
  customSymbol: "NIFTY 26 APR 24600 CALL",
  expiryDate: "2026-04-03 14:30:00",
  expiryDateOnly: "2026-04-03",
  strikePrice: 24600,
  optionType: "CE",
});

const NIFTY_CE_24500_APR10 = makeRecord({
  securityId: "50004",
  tradingSymbol: "NIFTY-Apr2026-24500-CE",
  customSymbol: "NIFTY 26 APR 24500 CALL",
  expiryDate: "2026-04-10 14:30:00",
  expiryDateOnly: "2026-04-10",
  strikePrice: 24500,
  optionType: "CE",
});

const NIFTY_FUT_APR = makeRecord({
  securityId: "50005",
  instrumentName: "FUTIDX",
  tradingSymbol: "NIFTY-Apr2026-FUT",
  customSymbol: "NIFTY 26 APR FUT",
  expiryDate: "2026-04-24 14:30:00",
  expiryDateOnly: "2026-04-24",
  strikePrice: 0,
  optionType: "XX",
  expiryFlag: "M",
  exchInstrType: "FUT",
});

const BANKNIFTY_CE_52000_APR03 = makeRecord({
  securityId: "60001",
  tradingSymbol: "BANKNIFTY-Apr2026-52000-CE",
  customSymbol: "BANKNIFTY 26 APR 52000 CALL",
  expiryDate: "2026-04-03 14:30:00",
  expiryDateOnly: "2026-04-03",
  strikePrice: 52000,
  optionType: "CE",
  underlyingSymbol: "BANKNIFTY",
});

const CRUDEOIL_FUTCOM_APR = makeRecord({
  securityId: "70001",
  exchange: "MCX",
  segment: "M",
  instrumentName: "FUTCOM",
  tradingSymbol: "CRUDEOIL-Apr2026-FUT",
  customSymbol: "CRUDEOIL 26 APR FUT",
  expiryDate: "2026-04-19 23:30:00",
  expiryDateOnly: "2026-04-19",
  strikePrice: 0,
  optionType: "XX",
  expiryFlag: "M",
  exchInstrType: "FUTCOM",
  underlyingSymbol: "CRUDEOIL",
});

const CRUDEOIL_FUTCOM_MAY = makeRecord({
  securityId: "70002",
  exchange: "MCX",
  segment: "M",
  instrumentName: "FUTCOM",
  tradingSymbol: "CRUDEOIL-May2026-FUT",
  customSymbol: "CRUDEOIL 26 MAY FUT",
  expiryDate: "2026-05-19 23:30:00",
  expiryDateOnly: "2026-05-19",
  strikePrice: 0,
  optionType: "XX",
  expiryFlag: "M",
  exchInstrType: "FUTCOM",
  underlyingSymbol: "CRUDEOIL",
});

const CRUDEOIL_OPTCOM_APR = makeRecord({
  securityId: "70003",
  exchange: "MCX",
  segment: "M",
  instrumentName: "OPTCOM",
  tradingSymbol: "CRUDEOIL-Apr2026-5500-CE",
  customSymbol: "CRUDEOIL 26 APR 5500 CALL",
  expiryDate: "2026-04-19 23:30:00",
  expiryDateOnly: "2026-04-19",
  strikePrice: 5500,
  optionType: "CE",
  underlyingSymbol: "CRUDEOIL",
});

const ALL_RECORDS = [
  NIFTY_CE_24500_APR03,
  NIFTY_PE_24500_APR03,
  NIFTY_CE_24600_APR03,
  NIFTY_CE_24500_APR10,
  NIFTY_FUT_APR,
  BANKNIFTY_CE_52000_APR03,
  CRUDEOIL_FUTCOM_APR,
  CRUDEOIL_FUTCOM_MAY,
  CRUDEOIL_OPTCOM_APR,
];

// ─── Tests ────────────────────────────────────────────────────

describe("ScripMaster", () => {
  beforeEach(() => {
    _resetForTesting();
    _loadRecordsForTesting(ALL_RECORDS);
    // Freeze the clock so resolveMCXFutcom (which compares fixture
    // expiries against `new Date()`) is deterministic regardless of
    // when the test runs. Fixtures use Apr/May 2026 expiries — clock
    // pinned to Apr 1 keeps both months "non-expired" so the
    // nearest-month assertion is stable.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T09:00:00+05:30"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Status ──────────────────────────────────────────────────

  describe("getScripMasterStatus", () => {
    it("returns correct status after loading", () => {
      const status = getScripMasterStatus();
      expect(status.isLoaded).toBe(true);
      expect(status.recordCount).toBe(ALL_RECORDS.length);
      expect(status.lastDownload).toBeGreaterThan(0);
      expect(status.exchanges).toContain("NSE");
      expect(status.exchanges).toContain("MCX");
    });

    it("returns empty status when not loaded", () => {
      _resetForTesting();
      const status = getScripMasterStatus();
      expect(status.isLoaded).toBe(false);
      expect(status.recordCount).toBe(0);
    });
  });

  // ── Lookup ──────────────────────────────────────────────────

  describe("lookupSecurityId", () => {
    it("finds NIFTY CE by symbol + expiry + strike + optionType", () => {
      const result = lookupSecurityId({
        symbol: "NIFTY",
        expiry: "2026-04-03",
        strike: 24500,
        optionType: "CE",
      });
      expect(result).not.toBeNull();
      expect(result!.securityId).toBe("50001");
      expect(result!.lotSize).toBe(25);
    });

    it("finds NIFTY PE at same strike", () => {
      const result = lookupSecurityId({
        symbol: "NIFTY",
        expiry: "2026-04-03",
        strike: 24500,
        optionType: "PE",
      });
      expect(result).not.toBeNull();
      expect(result!.securityId).toBe("50002");
    });

    it("finds different strike at same expiry", () => {
      const result = lookupSecurityId({
        symbol: "NIFTY",
        expiry: "2026-04-03",
        strike: 24600,
        optionType: "CE",
      });
      expect(result).not.toBeNull();
      expect(result!.securityId).toBe("50003");
    });

    it("finds same strike at different expiry", () => {
      const result = lookupSecurityId({
        symbol: "NIFTY",
        expiry: "2026-04-10",
        strike: 24500,
        optionType: "CE",
      });
      expect(result).not.toBeNull();
      expect(result!.securityId).toBe("50004");
    });

    it("finds NIFTY FUT (no strike, no optionType)", () => {
      const result = lookupSecurityId({
        symbol: "NIFTY",
        expiry: "2026-04-24",
        instrumentName: "FUTIDX",
      });
      expect(result).not.toBeNull();
      expect(result!.securityId).toBe("50005");
      expect(result!.instrumentName).toBe("FUTIDX");
    });

    it("finds BANKNIFTY CE", () => {
      const result = lookupSecurityId({
        symbol: "BANKNIFTY",
        expiry: "2026-04-03",
        strike: 52000,
        optionType: "CE",
      });
      expect(result).not.toBeNull();
      expect(result!.securityId).toBe("60001");
    });

    it("returns null for non-existent symbol", () => {
      const result = lookupSecurityId({ symbol: "NONEXISTENT" });
      expect(result).toBeNull();
    });

    it("returns null for wrong expiry", () => {
      const result = lookupSecurityId({
        symbol: "NIFTY",
        expiry: "2099-01-01",
        strike: 24500,
        optionType: "CE",
      });
      expect(result).toBeNull();
    });

    it("is case-insensitive for symbol", () => {
      const result = lookupSecurityId({
        symbol: "nifty",
        expiry: "2026-04-03",
        strike: 24500,
        optionType: "CE",
      });
      expect(result).not.toBeNull();
      expect(result!.securityId).toBe("50001");
    });

    it("handles expiry with time component", () => {
      const result = lookupSecurityId({
        symbol: "NIFTY",
        expiry: "2026-04-03 14:30:00",
        strike: 24500,
        optionType: "CE",
      });
      expect(result).not.toBeNull();
      expect(result!.securityId).toBe("50001");
    });

    it("filters by exchange", () => {
      const result = lookupSecurityId({
        symbol: "CRUDEOIL",
        exchange: "MCX",
        instrumentName: "FUTCOM",
        expiry: "2026-04-19",
      });
      expect(result).not.toBeNull();
      expect(result!.securityId).toBe("70001");
    });
  });

  // ── Lookup Multiple ─────────────────────────────────────────

  describe("lookupMultiple", () => {
    it("returns results for multiple lookups", () => {
      const results = lookupMultiple([
        { symbol: "NIFTY", expiry: "2026-04-03", strike: 24500, optionType: "CE" },
        { symbol: "BANKNIFTY", expiry: "2026-04-03", strike: 52000, optionType: "CE" },
        { symbol: "NONEXISTENT" },
      ]);
      expect(results).toHaveLength(3);
      expect(results[0]!.securityId).toBe("50001");
      expect(results[1]!.securityId).toBe("60001");
      expect(results[2]).toBeNull();
    });
  });

  // ── Expiry Dates ────────────────────────────────────────────

  describe("getExpiryDates", () => {
    it("returns sorted unique expiry dates for NIFTY", () => {
      const dates = getExpiryDates("NIFTY");
      expect(dates.length).toBeGreaterThanOrEqual(2);
      expect(dates).toContain("2026-04-03");
      expect(dates).toContain("2026-04-10");
      // Verify sorted ascending
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i] >= dates[i - 1]).toBe(true);
      }
    });

    it("returns expiry dates filtered by exchange", () => {
      const dates = getExpiryDates("CRUDEOIL", "MCX");
      expect(dates).toContain("2026-04-19");
      expect(dates).toContain("2026-05-19");
    });

    it("returns expiry dates filtered by instrument name", () => {
      const dates = getExpiryDates("CRUDEOIL", "MCX", "FUTCOM");
      expect(dates).toContain("2026-04-19");
      expect(dates).toContain("2026-05-19");
    });

    it("returns empty for non-existent symbol", () => {
      const dates = getExpiryDates("NONEXISTENT");
      expect(dates).toHaveLength(0);
    });

    it("is case-insensitive", () => {
      const dates = getExpiryDates("nifty");
      expect(dates.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── MCX FUTCOM Resolution ──────────────────────────────────

  describe("resolveMCXFutcom", () => {
    it("returns nearest-month FUTCOM for CRUDEOIL", () => {
      const result = resolveMCXFutcom("CRUDEOIL");
      expect(result).not.toBeNull();
      // Should return April (nearest non-expired)
      expect(result!.securityId).toBe("70001");
      expect(result!.instrumentName).toBe("FUTCOM");
      expect(result!.exchange).toBe("MCX");
    });

    it("returns null for non-MCX symbol", () => {
      const result = resolveMCXFutcom("NIFTY");
      expect(result).toBeNull();
    });

    it("returns null for non-existent commodity", () => {
      const result = resolveMCXFutcom("NONEXISTENT");
      expect(result).toBeNull();
    });

    it("is case-insensitive", () => {
      const result = resolveMCXFutcom("crudeoil");
      expect(result).not.toBeNull();
      expect(result!.securityId).toBe("70001");
    });
  });

  // ── Records by Exchange ─────────────────────────────────────

  describe("getRecordsByExchange", () => {
    it("returns NSE records", () => {
      const records = getRecordsByExchange("NSE");
      expect(records.length).toBeGreaterThan(0);
      expect(records.every((r) => r.exchange === "NSE")).toBe(true);
    });

    it("returns MCX records", () => {
      const records = getRecordsByExchange("MCX");
      expect(records.length).toBe(3); // 2 FUTCOM + 1 OPTCOM
      expect(records.every((r) => r.exchange === "MCX")).toBe(true);
    });

    it("returns empty for non-existent exchange", () => {
      const records = getRecordsByExchange("UNKNOWN");
      expect(records).toHaveLength(0);
    });
  });

  // ── Records by Symbol ───────────────────────────────────────

  describe("getRecordsBySymbol", () => {
    it("returns all NIFTY records", () => {
      const records = getRecordsBySymbol("NIFTY");
      expect(records.length).toBe(5); // 3 CE + 1 PE + 1 FUT
    });

    it("returns all CRUDEOIL records", () => {
      const records = getRecordsBySymbol("CRUDEOIL");
      expect(records.length).toBe(3); // 2 FUTCOM + 1 OPTCOM
    });
  });

  // ── Needs Refresh ───────────────────────────────────────────

  describe("needsRefresh", () => {
    it("returns false immediately after loading", () => {
      expect(needsRefresh(24)).toBe(false);
    });

    it("returns true when cache is empty", () => {
      _resetForTesting();
      expect(needsRefresh(24)).toBe(true);
    });
  });

  // ── Reset ───────────────────────────────────────────────────

  describe("_resetForTesting", () => {
    it("clears all data", () => {
      _resetForTesting();
      const status = getScripMasterStatus();
      expect(status.isLoaded).toBe(false);
      expect(status.recordCount).toBe(0);
      expect(lookupSecurityId({ symbol: "NIFTY" })).toBeNull();
    });
  });
});
