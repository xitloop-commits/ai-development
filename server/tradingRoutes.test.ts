/**
 * Vitest tests for Trading REST endpoints used by Python modules.
 *
 * Covers the in-memory trading store functions that back the REST endpoints:
 * - pushOptionChain / getInstrumentData
 * - pushAnalyzerOutput / getInstrumentData / getSignals
 * - updateModuleHeartbeat / getModuleStatuses
 * - getActiveInstruments / setActiveInstruments
 *
 * These endpoints are called by Python callers: TFA, SEA, MTA.
 */

import { describe, it, expect } from "vitest";
import {
  pushOptionChain,
  pushAnalyzerOutput,
  updateModuleHeartbeat,
  getActiveInstruments,
  setActiveInstruments,
  getModuleStatuses,
  getInstrumentData,
  getSignals,
} from "./tradingStore";
import type {
  RawOptionChainData,
  RawAnalyzerOutput,
} from "../shared/tradingTypes";

// ─── Sample Data ────────────────────────────────────────────────

const sampleOptionChain: RawOptionChainData = {
  last_price: 25642.8,
  oc: {
    "25650": {
      ce: {
        oi: 100000,
        volume: 5000,
        last_price: 120.5,
        implied_volatility: 14.2,
        previous_oi: 95000,
        previous_volume: 4000,
        greeks: { delta: 0.5, theta: -3.5, gamma: 0.001, vega: 10 },
        security_id: 12345,
        average_price: 118,
        previous_close_price: 115,
        top_ask_price: 121,
        top_ask_quantity: 100,
        top_bid_price: 120,
        top_bid_quantity: 200,
      },
      pe: {
        oi: 200000,
        volume: 3500,
        last_price: 95.3,
        implied_volatility: 15.1,
        previous_oi: 190000,
        previous_volume: 3000,
        greeks: { delta: -0.5, theta: -3.2, gamma: 0.001, vega: 9.5 },
        security_id: 12346,
        average_price: 93,
        previous_close_price: 90,
        top_ask_price: 96,
        top_ask_quantity: 150,
        top_bid_price: 95,
        top_bid_quantity: 250,
      },
    },
  },
};

const sampleAnalyzerOutput: RawAnalyzerOutput = {
  instrument: "NIFTY_50",
  timestamp: new Date().toISOString(),
  last_price: 25642.8,
  active_strikes: {
    call: [25600, 25700, 25800],
    put: [25500, 25400],
  },
  main_support: 25500,
  main_resistance: 25800,
  support_levels: [25500, 25400, 25300],
  resistance_levels: [25700, 25800, 25900],
  market_bias: "BULLISH",
  oi_change_signals: ["Long Buildup detected at 25600 CE: OI +5000"],
  entry_signals: ["Call Writing at 25800 CE: OI +10000"],
  real_time_signals: [],
  exit_signals: [],
  smart_money_signals: [],
};


// ─── Active Instruments (used by ALL Python modules) ──

describe("Active Instruments (Python: all modules poll this)", () => {
  it("returns default active instruments", () => {
    // Ensure defaults are set
    setActiveInstruments(["NIFTY_50", "BANKNIFTY", "CRUDEOIL", "NATURALGAS"]);
    const instruments = getActiveInstruments();
    expect(Array.isArray(instruments)).toBe(true);
    expect(instruments.length).toBe(4);
  });

  it("sets and retrieves custom instruments", () => {
    setActiveInstruments(["NIFTY_50", "BANKNIFTY"]);
    const instruments = getActiveInstruments();
    expect(instruments).toEqual(["NIFTY_50", "BANKNIFTY"]);
    // Restore
    setActiveInstruments(["NIFTY_50", "BANKNIFTY", "CRUDEOIL", "NATURALGAS"]);
  });

  it("overwrites previous instruments on set", () => {
    setActiveInstruments(["NIFTY_50", "BANKNIFTY"]);
    setActiveInstruments(["CRUDEOIL"]);
    const instruments = getActiveInstruments();
    expect(instruments).toEqual(["CRUDEOIL"]);
    // Restore
    setActiveInstruments(["NIFTY_50", "BANKNIFTY", "CRUDEOIL", "NATURALGAS"]);
  });

  it("falls back to all instruments when empty array is provided", () => {
    setActiveInstruments([]);
    const instruments = getActiveInstruments();
    // Store falls back to all instruments when empty list is given
    expect(instruments.length).toBe(4);
  });
});

// ─── Push Option Chain (used by TFA) ──

describe("POST /api/trading/option-chain (Python: TFA)", () => {
  it("stores option chain data and reflects in instrument data", () => {
    pushOptionChain("NIFTY_50", sampleOptionChain);
    const instruments = getInstrumentData();
    const nifty = instruments.find((i) => i.name === "NIFTY_50");
    expect(nifty).toBeDefined();
    expect(nifty!.lastPrice).toBe(25642.8);
  });

  it("calculates OI totals from option chain", () => {
    pushOptionChain("NIFTY_50", sampleOptionChain);
    const instruments = getInstrumentData();
    const nifty = instruments.find((i) => i.name === "NIFTY_50");
    expect(nifty!.totalCallOI).toBe(100000);
    expect(nifty!.totalPutOI).toBe(200000);
    expect(nifty!.strikesFound).toBe(1);
  });

  it("stores data independently per instrument", () => {
    const bankData: RawOptionChainData = {
      last_price: 55000,
      oc: {},
    };
    pushOptionChain("NIFTY_50", sampleOptionChain);
    pushOptionChain("BANKNIFTY", bankData);
    const instruments = getInstrumentData();
    const nifty = instruments.find((i) => i.name === "NIFTY_50");
    const bank = instruments.find((i) => i.name === "BANKNIFTY");
    expect(nifty!.lastPrice).toBe(25642.8);
    expect(bank!.lastPrice).toBe(55000);
  });
});

// ─── Push Analyzer Output (used by SEA) ──

describe("POST /api/trading/analyzer (Python: SEA)", () => {
  it("stores analyzer output and updates market bias", () => {
    pushAnalyzerOutput("NIFTY_50", sampleAnalyzerOutput);
    const instruments = getInstrumentData();
    const nifty = instruments.find((i) => i.name === "NIFTY_50");
    expect(nifty).toBeDefined();
    expect(nifty!.marketBias).toBe("BULLISH");
  });

  it("populates support and resistance levels", () => {
    pushAnalyzerOutput("NIFTY_50", sampleAnalyzerOutput);
    const instruments = getInstrumentData();
    const nifty = instruments.find((i) => i.name === "NIFTY_50");
    expect(nifty!.supportLevels.length).toBeGreaterThan(0);
    expect(nifty!.resistanceLevels.length).toBeGreaterThan(0);
  });

  it("generates signals from analyzer output", () => {
    pushAnalyzerOutput("NIFTY_50", sampleAnalyzerOutput);
    const signals = getSignals(50);
    expect(signals.length).toBeGreaterThan(0);
    const niftySignals = signals.filter((s) => s.instrument === "NIFTY_50");
    expect(niftySignals.length).toBeGreaterThan(0);
  });
});


// ─── Module Heartbeat (used by TFA / SEA / MTA) ──

describe("POST /api/trading/heartbeat (Python: TFA, SEA, MTA)", () => {
  it("records heartbeat for FETCHER module", () => {
    updateModuleHeartbeat("FETCHER", "Fetching NIFTY_50 - 45 strikes");
    const statuses = getModuleStatuses();
    const fetcher = statuses.find((s) => s.shortName === "FETCHER");
    expect(fetcher).toBeDefined();
    expect(fetcher!.message).toBe("Fetching NIFTY_50 - 45 strikes");
    expect(fetcher!.status).toBe("active");
  });

  it("records heartbeats for multiple modules (Python pipeline + TS agents)", () => {
    updateModuleHeartbeat("FETCHER", "Fetching NIFTY");
    updateModuleHeartbeat("ANALYZER", "Analyzing NIFTY");
    updateModuleHeartbeat("TEA", "1 open trade");
    const statuses = getModuleStatuses();
    const shortNames = statuses.map((s) => s.shortName);
    expect(shortNames).toContain("FETCHER");
    expect(shortNames).toContain("ANALYZER");
    expect(shortNames).toContain("TEA");
    expect(shortNames).toContain("RCA");
    expect(shortNames).toContain("PA");
  });

  it("updates existing heartbeat message", () => {
    updateModuleHeartbeat("PA", "Starting");
    updateModuleHeartbeat("PA", "Running - 2 open positions");
    const statuses = getModuleStatuses();
    const pa = statuses.find((s) => s.shortName === "PA");
    expect(pa!.message).toBe("Running - 2 open positions");
  });

  it("ignores unknown module keys", () => {
    // updateModuleHeartbeat only updates if key exists in moduleHeartbeats
    updateModuleHeartbeat("UNKNOWN_MODULE", "Should be ignored");
    const statuses = getModuleStatuses();
    const unknown = statuses.find((s) => s.shortName === "UNKNOWN_MODULE");
    expect(unknown).toBeUndefined();
  });
});

// ─── Legacy tradingMode endpoint removed (B10) ──

describe("legacy /api/trading/{position,mode} endpoints removed (B10)", () => {
  it("tradingStore no longer exports pushPosition / getTradingMode", async () => {
    const mod = await import("./tradingStore");
    expect((mod as any).pushPosition).toBeUndefined();
    expect((mod as any).getPositions).toBeUndefined();
    expect((mod as any).getTradingMode).toBeUndefined();
    expect((mod as any).setTradingMode).toBeUndefined();
  });
});

// ─── Instrument Data (used by dashboard) ──

describe("Instrument Data (Python: SEA)", () => {
  it("returns data for all 4 instruments", () => {
    setActiveInstruments(["NIFTY_50", "BANKNIFTY", "CRUDEOIL", "NATURALGAS"]);
    const instruments = getInstrumentData();
    expect(instruments).toHaveLength(4);
    const names = instruments.map((i) => i.name);
    expect(names).toContain("NIFTY_50");
    expect(names).toContain("BANKNIFTY");
    expect(names).toContain("CRUDEOIL");
    expect(names).toContain("NATURALGAS");
  });

  it("each instrument has required fields", () => {
    const instruments = getInstrumentData();
    for (const inst of instruments) {
      expect(inst).toHaveProperty("name");
      expect(inst).toHaveProperty("displayName");
      expect(inst).toHaveProperty("exchange");
      expect(inst).toHaveProperty("marketBias");
      expect(inst).toHaveProperty("aiDecision");
      expect(inst).toHaveProperty("supportLevels");
      expect(inst).toHaveProperty("resistanceLevels");
      expect(inst).toHaveProperty("activeStrikes");
    }
  });
});
