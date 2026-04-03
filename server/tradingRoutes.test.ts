/**
 * Vitest tests for Trading REST endpoints used by Python AI modules.
 *
 * Covers the in-memory trading store functions that back the REST endpoints:
 * - pushOptionChain / getInstrumentData
 * - pushAnalyzerOutput / getInstrumentData / getSignals
 * - pushAIDecision / getInstrumentData
 * - pushPosition / getPositions
 * - updateModuleHeartbeat / getModuleStatuses
 * - setTradingMode / getTradingMode
 * - getActiveInstruments / setActiveInstruments
 *
 * These endpoints are called by:
 *   option_chain_fetcher, option_chain_analyzer, ai_decision_engine,
 *   execution_module, dashboard_data_pusher, session_manager
 */

import { describe, it, expect } from "vitest";
import {
  pushOptionChain,
  pushAnalyzerOutput,
  pushAIDecision,
  pushPosition,
  updateModuleHeartbeat,
  setTradingMode,
  getTradingMode,
  getActiveInstruments,
  setActiveInstruments,
  getModuleStatuses,
  getInstrumentData,
  getSignals,
  getPositions,
} from "./tradingStore";
import type {
  RawOptionChainData,
  RawAnalyzerOutput,
  RawAIDecision,
  Position,
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

const sampleAIDecision: RawAIDecision = {
  instrument: "NIFTY_50",
  timestamp: new Date().toISOString(),
  decision: "GO",
  trade_type: "CALL_BUY",
  confidence_score: 0.85,
  rationale: "Strong OI buildup at support with bullish bias",
  market_bias_oc: "BULLISH",
  market_bias_news: "POSITIVE",
  active_strikes: { call: [25600, 25700], put: [25500] },
  main_support: 25500,
  main_resistance: 25800,
  entry_signal_details: "Long Buildup at 25600 CE",
  news_summary: "Positive market outlook",
  target_strike: 25600,
  target_expiry_date: "2026-04-07",
};

const samplePosition: Position = {
  id: "TEST-POS-001",
  instrument: "NIFTY_50",
  type: "CALL_BUY",
  strike: 26000,
  entryPrice: 150,
  currentPrice: 160,
  quantity: 50,
  pnl: 500,
  pnlPercent: 6.67,
  slPrice: 130,
  tpPrice: 200,
  status: "OPEN",
  entryTime: new Date().toISOString(),
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

// ─── Push Option Chain (used by dashboard_data_pusher) ──

describe("POST /api/trading/option-chain (Python: dashboard_data_pusher)", () => {
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

// ─── Push Analyzer Output (used by dashboard_data_pusher) ──

describe("POST /api/trading/analyzer (Python: dashboard_data_pusher)", () => {
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

// ─── Push AI Decision (used by dashboard_data_pusher) ──

describe("POST /api/trading/ai-decision (Python: dashboard_data_pusher)", () => {
  it("stores GO decision and reflects in instrument data", () => {
    pushAIDecision("NIFTY_50", sampleAIDecision);
    const instruments = getInstrumentData();
    const nifty = instruments.find((i) => i.name === "NIFTY_50");
    expect(nifty).toBeDefined();
    expect(nifty!.aiDecision).toBe("GO");
    expect(nifty!.aiConfidence).toBe(0.85);
  });

  it("stores WAIT decision", () => {
    const waitDecision: RawAIDecision = {
      ...sampleAIDecision,
      decision: "WAIT",
      confidence_score: 0.3,
      rationale: "Sideways market detected",
    };
    pushAIDecision("NIFTY_50", waitDecision);
    const instruments = getInstrumentData();
    const nifty = instruments.find((i) => i.name === "NIFTY_50");
    expect(nifty!.aiDecision).toBe("WAIT");
  });

  it("stores NO_GO decision", () => {
    const noGoDecision: RawAIDecision = {
      ...sampleAIDecision,
      decision: "NO_GO",
      confidence_score: 0.9,
      rationale: "High risk environment",
    };
    pushAIDecision("NIFTY_50", noGoDecision);
    const instruments = getInstrumentData();
    const nifty = instruments.find((i) => i.name === "NIFTY_50");
    expect(nifty!.aiDecision).toBe("NO_GO");
  });
});

// ─── Push Position (used by execution_module) ──

describe("POST /api/trading/position (Python: execution_module)", () => {
  it("stores position data", () => {
    pushPosition(samplePosition);
    const positions = getPositions();
    const found = positions.find((p) => p.id === "TEST-POS-001");
    expect(found).toBeDefined();
    expect(found!.instrument).toBe("NIFTY_50");
    expect(found!.status).toBe("OPEN");
  });

  it("updates existing position by id", () => {
    pushPosition(samplePosition);
    const updatedPosition: Position = {
      ...samplePosition,
      status: "CLOSED",
      pnl: 900,
      currentPrice: 230,
    };
    pushPosition(updatedPosition);
    const positions = getPositions();
    const found = positions.find((p) => p.id === "TEST-POS-001");
    expect(found).toBeDefined();
    expect(found!.status).toBe("CLOSED");
    expect(found!.pnl).toBe(900);
  });
});

// ─── Module Heartbeat (used by session_manager) ──

describe("POST /api/trading/heartbeat (Python: session_manager)", () => {
  it("records heartbeat for FETCHER module", () => {
    updateModuleHeartbeat("FETCHER", "Fetching NIFTY_50 - 45 strikes");
    const statuses = getModuleStatuses();
    const fetcher = statuses.find((s) => s.shortName === "FETCHER");
    expect(fetcher).toBeDefined();
    expect(fetcher!.message).toBe("Fetching NIFTY_50 - 45 strikes");
    expect(fetcher!.status).toBe("active");
  });

  it("records heartbeats for multiple modules", () => {
    updateModuleHeartbeat("FETCHER", "Fetching NIFTY");
    updateModuleHeartbeat("ANALYZER", "Analyzing NIFTY");
    updateModuleHeartbeat("AI ENGINE", "Processing");
    const statuses = getModuleStatuses();
    const shortNames = statuses.map((s) => s.shortName);
    expect(shortNames).toContain("FETCHER");
    expect(shortNames).toContain("ANALYZER");
    expect(shortNames).toContain("AI ENGINE");
  });

  it("updates existing heartbeat message", () => {
    updateModuleHeartbeat("EXECUTOR", "Starting");
    updateModuleHeartbeat("EXECUTOR", "Running - 2 open positions");
    const statuses = getModuleStatuses();
    const executor = statuses.find((s) => s.shortName === "EXECUTOR");
    expect(executor!.message).toBe("Running - 2 open positions");
  });

  it("ignores unknown module keys", () => {
    // updateModuleHeartbeat only updates if key exists in moduleHeartbeats
    updateModuleHeartbeat("UNKNOWN_MODULE", "Should be ignored");
    const statuses = getModuleStatuses();
    const unknown = statuses.find((s) => s.shortName === "UNKNOWN_MODULE");
    expect(unknown).toBeUndefined();
  });
});

// ─── Trading Mode (used by execution_module) ──

describe("Trading Mode (Python: execution_module)", () => {
  it("defaults to PAPER mode", () => {
    setTradingMode("PAPER"); // Reset since store is singleton
    const mode = getTradingMode();
    expect(mode).toBe("PAPER");
  });

  it("switches to LIVE mode", () => {
    setTradingMode("LIVE");
    expect(getTradingMode()).toBe("LIVE");
    // Reset
    setTradingMode("PAPER");
  });

  it("switches back to PAPER mode", () => {
    setTradingMode("LIVE");
    setTradingMode("PAPER");
    expect(getTradingMode()).toBe("PAPER");
  });
});

// ─── Instrument Data (used by dashboard) ──

describe("Instrument Data (Python: dashboard_data_pusher)", () => {
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
