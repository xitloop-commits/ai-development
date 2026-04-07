/**
 * Vitest tests for Instruments Management System
 *
 * Tests:
 * - CRUD operations (create, read, update, delete)
 * - Default instrument seeding
 * - Search functionality via scrip master
 * - Protection of default instruments
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getAllInstruments,
  getInstrumentByKey,
  addInstrument,
  removeInstrument,
  seedDefaultInstruments,
  DEFAULT_INSTRUMENTS,
  InstrumentModel,
  type InstrumentConfig,
} from "./instruments";
import { searchByQuery, _loadRecordsForTesting, _resetForTesting, type ScripRecord } from "./broker/adapters/dhan/scripMaster";
import { connectMongo, disconnectMongo } from "./mongo";

// ─── Test Data ────────────────────────────────────────────────

function makeScripRecord(overrides: Partial<ScripRecord>): ScripRecord {
  return {
    exchange: "NSE",
    segment: "D",
    securityId: "1000",
    instrumentName: "OPTIDX",
    expiryCode: "W",
    tradingSymbol: "NETWEB-APR2026-500-CE",
    lotSize: 1,
    customSymbol: "NETWEB 26 APR 500 CALL",
    expiryDate: "2026-04-03 14:30:00",
    strikePrice: 500,
    optionType: "CE",
    tickSize: 0.05,
    expiryFlag: "W",
    exchInstrType: "OP",
    series: "EQ",
    symbolName: "NET WEB",
    underlyingSymbol: "NETWEB",
    expiryDateOnly: "2026-04-03",
    ...overrides,
  };
}

const NETWEB_EQUITY = makeScripRecord({
  exchange: "NSE",
  segment: "E",
  securityId: "2000",
  instrumentName: "EQIDX",
  tradingSymbol: "NETWEB",
  customSymbol: "NETWEB",
  symbolName: "NET WEB",
  underlyingSymbol: "NETWEB",
  strikePrice: 0,
  optionType: "XX",
});

const RELIANCE_EQUITY = makeScripRecord({
  exchange: "NSE",
  segment: "E",
  securityId: "2001",
  instrumentName: "EQIDX",
  tradingSymbol: "RELIANCE",
  customSymbol: "RELIANCE",
  symbolName: "RELIANCE INDUSTRIES",
  underlyingSymbol: "RELIANCE",
  strikePrice: 0,
  optionType: "XX",
});

const NIFTY_CALL = makeScripRecord({
  exchange: "NSE",
  segment: "D",
  securityId: "1001",
  tradingSymbol: "NIFTY-APR2026-24500-CE",
  customSymbol: "NIFTY 26 APR 24500 CALL",
  symbolName: "NIFTY 50",
  underlyingSymbol: "NIFTY",
  strikePrice: 24500,
  optionType: "CE",
});

// ─── Scrip Master Search Tests ────────────────────────────────

describe("searchByQuery - Scrip Master Search", () => {
  beforeEach(() => {
    _resetForTesting();
  });

  afterEach(() => {
    _resetForTesting();
  });

  it("should find NETWEB equity by trading symbol", () => {
    _loadRecordsForTesting([NETWEB_EQUITY]);
    const results = searchByQuery("NETWEB");
    expect(results).toHaveLength(1);
    expect(results[0].tradingSymbol).toBe("NETWEB");
  });

  it("should find instruments with partial matches", () => {
    _loadRecordsForTesting([NETWEB_EQUITY, RELIANCE_EQUITY]);
    const results = searchByQuery("NET");
    expect(results).toHaveLength(1);
    expect(results[0].underlyingSymbol).toBe("NETWEB");
  });

  it("should be case-insensitive", () => {
    _loadRecordsForTesting([NETWEB_EQUITY]);
    const lowercase = searchByQuery("netweb");
    const uppercase = searchByQuery("NETWEB");
    const mixedcase = searchByQuery("NetWeb");

    expect(lowercase).toHaveLength(1);
    expect(uppercase).toHaveLength(1);
    expect(mixedcase).toHaveLength(1);
  });

  it("should search in customSymbol field", () => {
    _loadRecordsForTesting([NETWEB_EQUITY]);
    const results = searchByQuery("NET WEB");
    expect(results).toHaveLength(1);
    expect(results[0].customSymbol).toBe("NETWEB");
  });

  it("should search in symbolName field", () => {
    _loadRecordsForTesting([RELIANCE_EQUITY]);
    const results = searchByQuery("RELIANCE INDUSTRIES");
    expect(results).toHaveLength(1);
    expect(results[0].symbolName).toBe("RELIANCE INDUSTRIES");
  });

  it("should filter by exchange", () => {
    _loadRecordsForTesting([NETWEB_EQUITY, NIFTY_CALL]);
    const nseResults = searchByQuery("NET", "NSE", 20);
    const mcxResults = searchByQuery("NET", "MCX", 20);

    expect(nseResults).toHaveLength(1);
    expect(mcxResults).toHaveLength(0);
  });

  it("should return empty array for no matches", () => {
    _loadRecordsForTesting([NETWEB_EQUITY, RELIANCE_EQUITY]);
    const results = searchByQuery("TATA");
    expect(results).toEqual([]);
  });

  it("should return empty array for empty query", () => {
    _loadRecordsForTesting([NETWEB_EQUITY]);
    const results = searchByQuery("");
    expect(results).toEqual([]);
  });

  it("should respect the limit parameter", () => {
    const records = [
      NETWEB_EQUITY,
      RELIANCE_EQUITY,
      NIFTY_CALL,
      makeScripRecord({ tradingSymbol: "NETFLIX", underlyingSymbol: "NETFLIX" }),
      makeScripRecord({ tradingSymbol: "NETWORK", underlyingSymbol: "NETWORK" }),
    ];
    _loadRecordsForTesting(records);

    const results = searchByQuery("NET", undefined, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("should search across multiple fields", () => {
    _loadRecordsForTesting([NIFTY_CALL, RELIANCE_EQUITY, NETWEB_EQUITY]);

    // Search by trading symbol
    let results = searchByQuery("NIFTY-APR");
    expect(results.some(r => r.tradingSymbol.includes("NIFTY"))).toBe(true);

    // Search by underlying symbol
    results = searchByQuery("RELIANCE");
    expect(results.some(r => r.underlyingSymbol === "RELIANCE")).toBe(true);
  });

  it("should handle whitespace in query", () => {
    _loadRecordsForTesting([RELIANCE_EQUITY]);
    const results = searchByQuery("  RELIANCE  ");
    expect(results).toHaveLength(1);
  });
});

// ─── Instruments CRUD Tests ────────────────────────────────

describe("Instruments Management - CRUD", () => {
  beforeEach(async () => {
    // Connect to test database
    await connectMongo();
    // Clear the collection
    await InstrumentModel.deleteMany({});
  });

  afterEach(async () => {
    await InstrumentModel.deleteMany({});
    await disconnectMongo();
  });

  it("should seed default instruments on first run", async () => {
    await seedDefaultInstruments();
    const instruments = await getAllInstruments();

    expect(instruments.length).toBe(4);
    expect(instruments.some(i => i.key === "NIFTY_50")).toBe(true);
    expect(instruments.some(i => i.key === "BANKNIFTY")).toBe(true);
    expect(instruments.some(i => i.key === "CRUDEOIL")).toBe(true);
    expect(instruments.some(i => i.key === "NATURALGAS")).toBe(true);
  });

  it("should mark default instruments as protected", async () => {
    await seedDefaultInstruments();
    const instruments = await getAllInstruments();

    instruments.forEach(inst => {
      if (DEFAULT_INSTRUMENTS.some(d => d.key === inst.key)) {
        expect(inst.isDefault).toBe(true);
      }
    });
  });

  it("should prevent removal of default instruments", async () => {
    await seedDefaultInstruments();

    const removeDefault = removeInstrument("NIFTY_50");
    await expect(removeDefault).rejects.toThrow("Cannot delete default instrument");
  });

  it("should add a new user instrument", async () => {
    await seedDefaultInstruments();

    await addInstrument({
      key: "RELIANCE_FUTURES",
      displayName: "RELIANCE FUTURES",
      exchange: "NSE",
      exchangeSegment: "NSE_EQ",
      underlying: "11915",
      autoResolve: false,
      symbolName: null,
    });

    const instruments = await getAllInstruments();
    const newInst = instruments.find(i => i.key === "RELIANCE_FUTURES");

    expect(newInst).toBeDefined();
    expect(newInst?.isDefault).toBe(false);
    expect(newInst?.displayName).toBe("RELIANCE FUTURES");
  });

  it("should allow removal of user-added instruments", async () => {
    await seedDefaultInstruments();

    await addInstrument({
      key: "TEST_INSTRUMENT",
      displayName: "TEST",
      exchange: "NSE",
      exchangeSegment: "NSE_EQ",
      underlying: "99999",
      autoResolve: false,
      symbolName: null,
    });

    await removeInstrument("TEST_INSTRUMENT");
    const inst = await getInstrumentByKey("TEST_INSTRUMENT");
    expect(inst).toBeNull();
  });

  it("should retrieve instrument by key", async () => {
    await seedDefaultInstruments();

    const inst = await getInstrumentByKey("BANKNIFTY");
    expect(inst).toBeDefined();
    expect(inst?.displayName).toBe("BANK NIFTY");
    expect(inst?.exchange).toBe("NSE");
  });

  it("should return null for non-existent instrument", async () => {
    await seedDefaultInstruments();

    const inst = await getInstrumentByKey("NON_EXISTENT");
    expect(inst).toBeNull();
  });

  it("should be idempotent on seeding", async () => {
    await seedDefaultInstruments();
    const count1 = (await getAllInstruments()).length;

    await seedDefaultInstruments();
    const count2 = (await getAllInstruments()).length;

    expect(count1).toBe(count2);
    expect(count2).toBe(4);
  });
});

// ─── Integration Tests ────────────────────────────────────────

describe("Instruments - Integration", () => {
  beforeEach(async () => {
    await connectMongo();
    await InstrumentModel.deleteMany({});
    _resetForTesting();
  });

  afterEach(async () => {
    await InstrumentModel.deleteMany({});
    await disconnectMongo();
    _resetForTesting();
  });

  it("should support adding instruments found in search", async () => {
    // Setup scrip master with test data
    _loadRecordsForTesting([NETWEB_EQUITY, RELIANCE_EQUITY]);

    // Search for an instrument
    const searchResults = searchByQuery("NETWEB");
    expect(searchResults).toHaveLength(1);

    const found = searchResults[0];

    // Add it to the instruments collection
    await addInstrument({
      key: "NETWEB_EQ",
      displayName: found.customSymbol || found.tradingSymbol,
      exchange: found.exchange as any,
      exchangeSegment: found.segment,
      underlying: found.securityId,
      autoResolve: false,
      symbolName: found.symbolName || null,
    });

    // Verify it was added
    const added = await getInstrumentByKey("NETWEB_EQ");
    expect(added).toBeDefined();
    expect(added?.displayName).toBe("NETWEB");
  });
});
